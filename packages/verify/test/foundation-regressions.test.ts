// 保存前の控えと条件作用を、エンジンを読み込まずに事象と出力で照らす。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);
const violations = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

const source = (id: string) => ({
  id,
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'school',
  language: 'ja',
  sentences: [{ id: `${id}-s1`, text: '条件つきの予定' }],
});
const reading = (sourceId: string, output: Record<string, unknown>) => ({
  type: 'modelOutputRecorded',
  call: 'extract',
  model: 'fixture',
  promptVersion: 'fixture',
  inputHash: 'fixture',
  sourceId,
  output,
});

describe('送った時の控えを独立に確かめる', () => {
  const basis = {
    itemIds: ['i1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'one',
  };
  const request = {
    requestId: 'r',
    taskKey: 't',
    to: 'helper',
    kind: 'reply',
    sentAt: '2026-11-30T10:00+09:00',
    sentBy: 'a',
    state: 'awaitingReply',
    basis,
    live: true,
    needsCheck: true,
  };
  const original = {
    sourceId: 'n1',
    items: [
      {
        id: 'i1',
        sourceId: 'n1',
        sentenceIds: ['n1-s1'],
        kind: 'dayChange',
        written: '条件つきの予定',
        interpretation: { date: '2026-12-07', dayType: 'noSchool' },
        evidence: 'stated',
        effects: [],
      },
    ],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: [],
    ambiguities: [],
  };
  const reread = {
    sourceId: 'n1',
    items: [],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: ['n1-s1'],
    ambiguities: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    event(2, { type: 'noticeReceived', source: source('n1') }),
    event(3, reading('n1', original)),
    event(4, {
      type: 'optionChosen',
      arrangementKey: 'arrangement',
      optionKey: 'one',
      role: 'primary',
    }),
    event(5, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
    event(6, {
      type: 'externalRequestSent',
      taskKey: 't',
      requestId: 'r',
      snapshot: { to: 'helper', kind: 'reply', basis, conditional: false, conditionNodeIds: [] },
    }),
    event(7, reading('n1', reread)),
  ];

  it('読み直しで旧手配が見つからなくても、控えがあれば依頼を未判定として残す', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [request] }),
      events,
    });
    expect(violations(report)).toEqual([]);
    expect(codes(report)).toContain('request_need_unverified');
  });

  it('現在の作業が無くても、送信時の控えと異なる相手を違反にする', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...request, to: 'b' }] }),
      events,
    });
    expect(violations(report)).toContain('request_recipient_mismatch');
  });

  it('現在の作業が無くても、送信時の控えと異なる根拠を違反にする', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 7,
        requests: [{ ...request, basis: { ...basis, itemIds: ['other-item'] } }],
      }),
      events,
    });
    expect(violations(report)).toContain('request_basis_mismatch');
  });

  it('送信後に作業の相手が変わっても、過去の依頼は送った時の控えで照らす', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 6,
        requirements: [requirement({ basis: { itemIds: ['i1'] } })],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        tasks: [task('t', { basis, commitment: 'done', external: { to: 'b', kind: 'reply' } })],
        requests: [request],
      }),
      events: events.slice(0, 6),
    });
    expect(violations(report)).not.toContain('request_recipient_mismatch');
    expect(violations(report)).not.toContain('request_basis_mismatch');
  });

  it('送信時の根拠が明確に取り消された時は、取消しの連絡が必要', () => {
    const cancel = {
      sourceId: 'n2',
      items: [
        {
          id: 'cancel-i1',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          kind: 'event',
          written: '予定の取り消し',
          interpretation: {},
          evidence: 'stated',
          effects: [{ type: 'cancel', itemId: 'i1' }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 8, requests: [{ ...request, live: false }] }),
      events: [
        ...events.slice(0, 6),
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancel)),
      ],
    });
    expect(violations(report)).toContain('cancellation_missing');
  });

  it('複数の根拠の一部だけが取り消された依頼は、要否を未判定にする', () => {
    const multiBasis = { ...basis, itemIds: ['i1', 'i2'] };
    const multiOriginal = {
      ...original,
      items: [original.items[0], { ...original.items[0], id: 'i2' }],
    };
    const cancellation = {
      sourceId: 'n2',
      items: [
        {
          id: 'cancel-i1',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          kind: 'event',
          written: '一部だけ取り消し',
          interpretation: {},
          evidence: 'stated',
          effects: [{ type: 'cancel', itemId: 'i1' }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const sentEvents = events.slice(0, 6).map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', multiOriginal));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: { to: 'helper', kind: 'reply', basis: multiBasis, conditional: false },
        };
      return entry;
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 8,
        requirements: [requirement({ basis: { itemIds: ['i2'] } })],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        requests: [{ ...request, basis: multiBasis }],
      }),
      events: [
        ...sentEvents,
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancellation)),
      ],
    });
    expect(violations(report)).not.toContain('cancellation_missing');
    expect(violations(report)).not.toContain('request_liveness_mismatch');
    expect(violations(report)).not.toContain('inactive_item_basis');
    expect(codes(report)).toContain('request_need_unverified');
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const unmarked = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 8,
        requirements: [requirement({ basis: { itemIds: ['i2'] } })],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        requests: [{ ...withoutCheck, basis: multiBasis }],
      }),
      events: [
        ...sentEvents,
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancellation)),
      ],
    });
    expect(violations(unmarked)).toContain('request_uncertainty_unmarked');
    const prematurelyInactive = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 8,
        requirements: [requirement({ basis: { itemIds: ['i2'] } })],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        requests: [{ ...request, basis: multiBasis, live: false }],
      }),
      events: [
        ...sentEvents,
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancellation)),
      ],
    });
    expect(violations(prematurelyInactive)).toContain('request_liveness_mismatch');
    expect(violations(prematurelyInactive)).not.toContain('cancellation_missing');
    const dropped = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 9, requests: [{ ...request, basis: multiBasis, live: false }] }),
      events: [
        ...sentEvents,
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancellation)),
        event(9, { type: 'optionDropped', arrangementKey: 'arrangement', optionKey: 'one' }),
      ],
    });
    expect(violations(dropped)).toContain('cancellation_missing');
  });

  it('複数の根拠がすべて明確に取り消されたら、送った依頼の取消しが必要', () => {
    const multiBasis = { ...basis, itemIds: ['i1', 'i2'] };
    const multiOriginal = {
      ...original,
      items: [original.items[0], { ...original.items[0], id: 'i2' }],
    };
    const cancellation = {
      sourceId: 'n2',
      items: [
        {
          id: 'cancel-both',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          kind: 'event',
          written: '両方取り消し',
          interpretation: {},
          evidence: 'stated',
          effects: [
            { type: 'cancel', itemId: 'i1' },
            { type: 'cancel', itemId: 'i2' },
          ],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const sentEvents = events.slice(0, 6).map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', multiOriginal));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: { to: 'helper', kind: 'reply', basis: multiBasis, conditional: false },
        };
      return entry;
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 8, requests: [{ ...request, basis: multiBasis, live: false }] }),
      events: [
        ...sentEvents,
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancellation)),
      ],
    });
    expect(violations(report)).toContain('cancellation_missing');
  });

  it('根拠が訂正で置き換わっただけなら、送った依頼を取消し対象と決めつけない', () => {
    const replacement = {
      sourceId: 'n2',
      items: [
        {
          ...original.items[0],
          id: 'i2',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          effects: [{ type: 'replace', itemId: 'i1' }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 8,
        requirements: [requirement({ basis: { itemIds: ['i2'] } })],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        requests: [request],
      }),
      events: [
        ...events.slice(0, 6),
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', replacement)),
      ],
    });
    expect(violations(report)).not.toContain('request_liveness_mismatch');
    expect(violations(report)).not.toContain('cancellation_missing');
    expect(violations(report)).not.toContain('inactive_item_basis');
  });

  it('同じ根拠に複数の訂正が競合した時、依頼の要否を未判定にする', () => {
    const replacement = (sourceId: string, itemId: string) => ({
      sourceId,
      items: [
        {
          ...original.items[0],
          id: itemId,
          sourceId,
          sentenceIds: [`${sourceId}-s1`],
          effects: [{ type: 'replace', itemId: 'i1' }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 10, requests: [request] }),
      events: [
        ...events.slice(0, 6),
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', replacement('n2', 'i2'))),
        event(9, { type: 'noticeReceived', source: source('n3') }),
        event(10, reading('n3', replacement('n3', 'i3'))),
      ],
    });
    expect(violations(report)).not.toContain('cancellation_missing');
    expect(violations(report)).not.toContain('inactive_item_basis');
    expect(codes(report)).toContain('request_need_unverified');
  });

  it('検証器が判断し切れないだけの時は、新たな不確かさの違反と断定しない', () => {
    const cancel = (sourceId: string, itemId: string, targetId: string) => ({
      sourceId,
      items: [
        {
          id: itemId,
          sourceId,
          sentenceIds: [`${sourceId}-s1`],
          kind: 'event',
          written: '取り消し',
          interpretation: {},
          evidence: 'stated',
          effects: [{ type: 'cancel', itemId: targetId }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 10, requests: [withoutCheck] }),
      events: [
        ...events.slice(0, 6),
        event(7, { type: 'noticeReceived', source: source('n2') }),
        event(8, reading('n2', cancel('n2', 'cancel-i1', 'i1'))),
        event(9, { type: 'noticeReceived', source: source('n3') }),
        event(10, reading('n3', cancel('n3', 'cancel-cancel', 'cancel-i1'))),
      ],
    });
    expect(violations(report)).not.toContain('request_uncertainty_unmarked');
    expect(codes(report)).toContain('request_need_unverified');
  });

  it('根拠が不明なのに要確認を付けない計画を見つける', () => {
    const { needsCheck: _omitted, ...unmarked } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [unmarked] }),
      events,
    });
    expect(violations(report)).toContain('request_uncertainty_unmarked');
  });

  it('送る時は確定、今は条件付きと計画自身が示す場合は要確認を求める', () => {
    const newCondition = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'new-condition' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'new-condition', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...withoutCheck, conditional: true }] }),
      events: [...events.slice(0, 6), event(7, reading('n1', newCondition))],
    });
    expect(violations(report)).toContain('request_uncertainty_unmarked');
  });

  it('送った時から分かっていた条件は、条件しだいを表示すれば新しい要確認にしない', () => {
    const conditionalSource = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'condition-at-send' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'condition-at-send', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const conditionalEvents = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(3, reading('n1', conditionalSource)),
      event(4, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(5, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(6, {
        type: 'externalRequestSent',
        taskKey: 't',
        requestId: 'r',
        snapshot: {
          to: 'helper',
          kind: 'reply',
          basis,
          conditional: true,
          conditionNodeIds: ['condition-at-send'],
        },
      }),
    ];
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, requests: [{ ...withoutCheck, conditional: true }] }),
      events: conditionalEvents,
    });
    expect(violations(report)).not.toContain('request_uncertainty_unmarked');
    expect(codes(report)).toContain('request_condition_history_unverified');
  });

  it('同じ節点 ID のまま条件の値を読み直した時、送信後の変更を見つける', () => {
    const atSend = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'condition-at-send' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'condition-at-send', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const after = {
      ...atSend,
      conditions: [{ id: 'condition-at-send', kind: 'eq', unknownId: 'u', value: 'no' }],
    };
    const changed = events.map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', atSend));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: {
            to: 'helper',
            kind: 'reply',
            basis,
            conditional: true,
            conditionNodeIds: ['condition-at-send'],
          },
        };
      if (entry.id === 'event-7') return event(7, reading('n1', after));
      return entry;
    });
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...withoutCheck, conditional: true }] }),
      events: changed,
    });
    expect(violations(report)).toContain('request_uncertainty_unmarked');
  });

  it('条件の意味が変わった後に新しい条件が確定しても、送った依頼の再確認を求める', () => {
    const atSend = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'condition-at-send' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'condition-at-send', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const after = {
      ...atSend,
      conditions: [{ id: 'condition-at-send', kind: 'eq', unknownId: 'u', value: 'no' }],
    };
    const changed = events.map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', atSend));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: { to: 'helper', kind: 'reply', basis, conditional: true },
        };
      if (entry.id === 'event-7') return event(7, reading('n1', after));
      return entry;
    });
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 8, requests: [withoutCheck] }),
      events: [...changed, event(8, { type: 'answered', unknownId: 'u', value: 'no' })],
    });
    expect(violations(report)).toContain('request_uncertainty_unmarked');
  });

  it('条件が確定していても、複雑な式との意味の一致は未判定にする', () => {
    const atSend = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'condition' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'condition', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const after = {
      ...atSend,
      conditions: [
        { id: 'condition', kind: 'not', childId: 'child' },
        { id: 'child', kind: 'eq', unknownId: 'u', value: 'no' },
      ],
    };
    const changed = events.map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', atSend));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: { to: 'helper', kind: 'reply', basis, conditional: true },
        };
      if (entry.id === 'event-7') return event(7, reading('n1', after));
      return entry;
    });
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 8, requests: [withoutCheck] }),
      events: [...changed, event(8, { type: 'answered', unknownId: 'u', value: 'yes' })],
    });
    expect(violations(report)).not.toContain('request_uncertainty_unmarked');
    expect(codes(report)).toContain('request_condition_history_unverified');
  });

  it('条件の節点 ID だけが変わっても、意味が変わったと決めつけない', () => {
    const atSend = {
      ...original,
      items: [{ ...original.items[0], conditionNodeId: 'old-id' }],
      unknowns: [{ id: 'u', label: '日程', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'old-id', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const after = {
      ...atSend,
      items: [{ ...original.items[0], conditionNodeId: 'new-id' }],
      conditions: [{ id: 'new-id', kind: 'eq', unknownId: 'u', value: 'yes' }],
    };
    const changed = events.map((entry) => {
      if (entry.id === 'event-3') return event(3, reading('n1', atSend));
      if (entry.id === 'event-6')
        return {
          ...entry,
          snapshot: { to: 'helper', kind: 'reply', basis, conditional: true },
        };
      if (entry.id === 'event-7') return event(7, reading('n1', after));
      return entry;
    });
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...withoutCheck, conditional: true }] }),
      events: changed,
    });
    expect(violations(report)).not.toContain('request_uncertainty_unmarked');
    expect(codes(report)).toContain('request_condition_history_unverified');
  });

  it('もとから条件付きでも、読み直しで根拠を失った新しい疑いは要確認にする', () => {
    const changed = events.map((entry) =>
      entry.id === 'event-6'
        ? {
            ...entry,
            snapshot: { to: 'helper', kind: 'reply', basis, conditional: true },
          }
        : entry,
    );
    const { needsCheck: _omitted, ...withoutCheck } = request;
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...withoutCheck, conditional: true }] }),
      events: changed,
    });
    expect(violations(report)).toContain('request_uncertainty_unmarked');
  });

  it('根拠を読み直しで失っただけなら、live=false を根拠に取消しを求めない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...request, live: false }] }),
      events,
    });
    expect(violations(report)).not.toContain('cancellation_missing');
    expect(codes(report)).toContain('request_need_unverified');
  });
});

describe('条件つきの作用と、後の家族の答え', () => {
  const output = {
    sourceId: 'n1',
    items: [
      {
        id: 'conditional-effect',
        sourceId: 'n1',
        sentenceIds: ['n1-s1'],
        kind: 'event',
        written: '条件つきの予定',
        interpretation: {},
        conditionNodeId: 'gate-is-yes',
        evidence: 'stated',
        effects: [{ type: 'resolveUnknown', unknownId: 'result', value: 'yes' }],
      },
      {
        id: 'dependent',
        sourceId: 'n1',
        sentenceIds: ['n1-s1'],
        kind: 'belongings',
        written: '条件つきの予定',
        interpretation: { what: '用意する物' },
        conditionNodeId: 'result-is-yes',
        evidence: 'stated',
        effects: [],
      },
    ],
    unknowns: [
      { id: 'gate', label: '条件', values: ['yes', 'no'], kind: 'other' },
      { id: 'result', label: '結果', values: ['yes', 'no'], kind: 'other' },
    ],
    conditions: [
      { id: 'gate-is-yes', kind: 'eq', unknownId: 'gate', value: 'yes' },
      { id: 'result-is-yes', kind: 'eq', unknownId: 'result', value: 'yes' },
    ],
    irrelevantSentenceIds: [],
    ambiguities: [],
  };
  const base = [
    event(1, { type: 'householdSet', household: household() }),
    event(2, { type: 'noticeReceived', source: source('n1') }),
    event(3, reading('n1', output)),
    event(4, { type: 'answered', unknownId: 'gate', value: 'yes' }),
  ];
  const req = requirement({
    key: 'req-dependent',
    kind: 'belongings',
    basis: { itemIds: ['dependent'] },
  });

  it('同じ通知の矛盾する二つの答えは、読み取りの配列順で決めない', () => {
    const conflicts = {
      ...output,
      items: [
        {
          ...output.items[0],
          id: 'yes-effect',
          conditionNodeId: undefined,
          effects: [{ type: 'resolveUnknown', unknownId: 'result', value: 'yes' }],
        },
        {
          ...output.items[0],
          id: 'no-effect',
          conditionNodeId: undefined,
          effects: [{ type: 'resolveUnknown', unknownId: 'result', value: 'no' }],
        },
        output.items[1],
      ],
    };
    for (const items of [conflicts.items, [...conflicts.items].reverse()]) {
      const report = verifyPlan({
        household: household(),
        plan: plan({ throughSeq: 3, requirements: [req] }),
        events: [
          event(1, { type: 'householdSet', household: household() }),
          event(2, { type: 'noticeReceived', source: source('n1') }),
          event(3, reading('n1', { ...conflicts, items })),
        ],
      });
      expect(violations(report)).not.toContain('inactive_item_basis');
      expect(codes(report)).toContain('item_condition_unknown');
    }
  });

  it('後から条件に答えた時、その条件つきの作用を再評価する', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req] }),
      events: base,
    });
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: 'item_condition_unknown', subject: 'req-dependent' }),
    );
    expect(violations(report)).not.toContain('inactive_item_basis');
  });

  it('後の家族の答えは、前の出典の作用より優先する', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [req] }),
      events: [...base, event(5, { type: 'answered', unknownId: 'result', value: 'no' })],
    });
    expect(violations(report)).toContain('inactive_item_basis');
  });

  it('作用を持つ事項が後で取り消されたら、その作用で決めた値を確定扱いしない', () => {
    const cancel = {
      sourceId: 'n2',
      items: [
        {
          id: 'cancel-effect',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          kind: 'event',
          written: '条件つきの予定',
          interpretation: {},
          evidence: 'stated',
          effects: [{ type: 'cancel', itemId: 'conditional-effect' }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, requirements: [req] }),
      events: [
        ...base,
        event(5, { type: 'noticeReceived', source: source('n2') }),
        event(6, reading('n2', cancel)),
      ],
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'item_condition_unknown', subject: 'req-dependent' }),
    );
  });

  it('後の未定な作用が以前の答えを変え得る時は、その答えに頼る事項を未判定にする', () => {
    const first = { ...output, items: output.items.filter((item) => item.id === 'dependent') };
    const later = {
      sourceId: 'n2',
      items: [
        {
          ...output.items[0],
          id: 'later-effect',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          conditionNodeId: 'n2-gate-is-yes',
        },
      ],
      unknowns: [],
      conditions: [{ id: 'n2-gate-is-yes', kind: 'eq', unknownId: 'gate', value: 'yes' }],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(3, reading('n1', first)),
      event(4, { type: 'answered', unknownId: 'result', value: 'no' }),
      event(5, { type: 'noticeReceived', source: source('n2') }),
      event(6, reading('n2', later)),
    ];
    const pending = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, requirements: [req] }),
      events,
    });
    expect(pending.issues).toContainEqual(
      expect.objectContaining({ code: 'item_condition_unknown', subject: 'req-dependent' }),
    );
    expect(violations(pending)).toEqual([]);
    const answered = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requirements: [req] }),
      events: [...events, event(7, { type: 'answered', unknownId: 'result', value: 'no' })],
    });
    expect(violations(answered)).toContain('inactive_item_basis');
  });

  it('条件作用が循環して定まらない時に、途中の値を確定と扱わない', () => {
    const first = { ...output, items: output.items.filter((item) => item.id === 'dependent') };
    const later = {
      sourceId: 'n2',
      items: [
        {
          ...output.items[0],
          id: 'gate-from-result',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          conditionNodeId: 'result-is-yes-n2',
          effects: [{ type: 'resolveUnknown', unknownId: 'gate', value: 'yes' }],
        },
        {
          ...output.items[0],
          id: 'result-from-gate',
          sourceId: 'n2',
          sentenceIds: ['n2-s1'],
          conditionNodeId: 'gate-is-no-n2',
        },
      ],
      unknowns: [],
      conditions: [
        { id: 'result-is-yes-n2', kind: 'eq', unknownId: 'result', value: 'yes' },
        { id: 'gate-is-no-n2', kind: 'eq', unknownId: 'gate', value: 'no' },
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, requirements: [req] }),
      events: [
        event(1, { type: 'householdSet', household: household() }),
        event(2, { type: 'noticeReceived', source: source('n1') }),
        event(3, reading('n1', first)),
        event(4, { type: 'answered', unknownId: 'gate', value: 'no' }),
        event(5, { type: 'noticeReceived', source: source('n2') }),
        event(6, reading('n2', later)),
      ],
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'item_condition_unknown', subject: 'req-dependent' }),
    );
    expect(violations(report)).toEqual([]);
  });
});
