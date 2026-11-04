// 「すること」の手配の知らせを、手書きの事象と期待で照らす。製品の通知生成関数は使わない。
import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { arrangement, event, household, option, plan, requirement } from './fixtures';

const source = {
  id: 'n-need',
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'family',
  language: 'ja',
  sentences: [{ id: 'n-need#1', text: '架空の用件をお願いします。' }],
};
const values = {
  by: { shape: 'by', what: '架空の用件', deadline: '2026-12-07T18:00+09:00' },
  window: {
    shape: 'window',
    what: '架空の用件',
    date: '2026-12-07',
    startTime: '09:00',
    endTime: '11:00',
  },
} as const;
const item = (shape: 'by' | 'window') => ({
  id: 'n-need:i1',
  sourceId: 'n-need',
  sentenceIds: ['n-need#1'],
  kind: 'need',
  written: '架空の用件をお願いします。',
  interpretation: values[shape],
  evidence: 'stated',
  effects: [],
});
const eventsOf = (shape: 'by' | 'window') => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source }),
  event(3, { type: 'itemsStated', sourceId: 'n-need', items: [item(shape)] }),
];
const requirementOf = () =>
  requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['n-need:i1'] } });
const arrangementOf = (shape: 'by' | 'window', overrides: Record<string, unknown> = {}) =>
  arrangement({
    kind: 'need',
    needShape: shape,
    status: 'undetermined',
    start: shape === 'window' ? '2026-12-07T09:00+09:00' : '2026-12-06T16:00+09:00',
    end: shape === 'window' ? '2026-12-07T11:00+09:00' : '2026-12-07T18:00+09:00',
    options: [],
    ...overrides,
  });
const ways = {
  key: 'needWays:arrangement:a',
  toMemberId: 'a',
  kind: 'decisionApproaching',
  titleKey: 'notify.need',
  subject: { type: 'arrangement', id: 'arrangement' },
  until: '2026-12-07T18:00+09:00',
};
const windowWays = { ...ways, until: '2026-12-07T11:00+09:00', actBy: '2026-12-07T09:00+09:00' };
const gaps = {
  ...windowWays,
  key: 'needGaps:arrangement:a',
  kind: 'assignment',
  titleKey: 'notify.needGaps',
};
const decide = {
  key: 'decide:arrangement:early:a',
  toMemberId: 'a',
  kind: 'decisionApproaching',
  titleKey: 'notify.decide',
  subject: { type: 'arrangement', id: 'arrangement', optionId: 'early' },
  until: '2026-12-06T20:00+09:00',
};
const check = (
  shape: 'by' | 'window',
  intent: unknown,
  overrides: Record<string, unknown> = {},
  now = '2026-12-06T16:00+09:00',
  events = eventsOf(shape),
  family = household(),
) =>
  verifyNotifications({
    household: family,
    events,
    intents: [intent],
    plan: plan({
      throughSeq: events.length,
      now,
      requirements: [requirementOf()],
      arrangements: [arrangementOf(shape, overrides)],
    }),
  });
const violations = (r: ReturnType<typeof check>) =>
  r.issues.filter((i) => i.kind === 'violation').map((i) => i.code);

describe('することの手配の知らせ', () => {
  it('締切型は締切まで26時間以内、開始欄を行動時刻として使わない', () => {
    expect(violations(check('by', ways))).toEqual([]);
    expect(violations(check('by', ways, {}, '2026-12-06T15:59+09:00'))).toContain(
      'notification_wrong_time',
    );
    expect(violations(check('by', ways, { start: '2026-12-01T08:00+09:00' }))).toEqual([]);
    expect(violations(check('by', { ...ways, actBy: '2026-12-06T16:00+09:00' }))).toContain(
      'notification_deadline_mismatch',
    );
    expect(violations(check('by', ways, {}, '2026-12-07T18:00+09:00'))).toContain(
      'notification_expired',
    );
  });

  it('窓型は開始の26時間前から終了まで、夜間判断は窓の開始', () => {
    expect(violations(check('window', windowWays, {}, '2026-12-06T07:00+09:00'))).toEqual([]);
    expect(violations(check('window', windowWays, {}, '2026-12-06T06:59+09:00'))).toContain(
      'notification_wrong_time',
    );
    expect(violations(check('window', windowWays, {}, '2026-12-07T09:30+09:00'))).toEqual([]);
    expect(
      violations(
        check('window', { ...windowWays, actBy: undefined }, {}, '2026-12-07T09:30+09:00'),
      ),
    ).toContain('notification_deadline_mismatch');
    expect(violations(check('window', windowWays, {}, '2026-12-07T11:00+09:00'))).toContain(
      'notification_expired',
    );
  });

  it('選び直しはやり方、間に合う候補が無いだけ・解決済み・問いが先なら知らせない', () => {
    expect(
      violations(check('by', ways, { reasons: [{ code: 'inputMissing', refs: ['waysChanged'] }] })),
    ).toEqual([]);
    expect(violations(check('by', ways, { status: 'infeasible' }))).toContain(
      'notification_subject_mismatch',
    );
    expect(violations(check('by', ways, { status: 'askFirst' }))).toContain(
      'notification_subject_mismatch',
    );
    expect(
      violations(check('by', ways, { status: 'decidable', chosenOptionKey: 'one' })),
    ).toContain('notification_subject_mismatch');
    expect(violations(check('by', { ...ways, key: 'needWays:other:a' }))).toContain(
      'notification_key_mismatch',
    );
    expect(
      violations(check('by', { ...ways, subject: { ...ways.subject, optionId: 'x' } })),
    ).toContain('notification_subject_mismatch');
  });

  it('時間を決められない案は選択済みなので、やり方未選択の通知を出さない', () => {
    const unplaced = {
      reasons: [{ code: 'noSlot', refs: ['counter'] }],
      options: [option('counter', { noSlot: true })],
    };
    expect(violations(check('by', ways, unplaced))).toContain('notification_subject_mismatch');
    // 内容が変わったため選び直しが必要なら、その事を知らせる。
    expect(
      violations(
        check('by', ways, {
          ...unplaced,
          reasons: [
            { code: 'inputMissing', refs: ['waysChanged'] },
            { code: 'noSlot', refs: ['counter'] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('本命選びは残る候補の最も早い決め時を使い、候補なしや対象外は拒む', () => {
    const choices = {
      status: 'decidable',
      options: [
        option('late', { decisionDeadline: '2026-12-07T10:00+09:00' }),
        option('early', { decisionDeadline: '2026-12-06T20:00+09:00' }),
        option('old', { decisionDeadline: '2026-12-06T18:00+09:00', expired: true }),
      ],
    };
    expect(violations(check('by', decide, choices))).toEqual([]);
    const late = {
      ...decide,
      key: 'decide:arrangement:late:a',
      subject: { ...decide.subject, optionId: 'late' },
      until: '2026-12-07T10:00+09:00',
    };
    expect(violations(check('by', late, choices))).toContain('notification_subject_mismatch');
    expect(violations(check('by', decide, { ...choices, chosenOptionKey: 'early' }))).toContain(
      'notification_subject_mismatch',
    );
    expect(violations(check('by', decide, { ...choices, status: 'undetermined' }))).toContain(
      'notification_subject_mismatch',
    );
    expect(violations(check('by', decide, { ...choices, options: [option('early')] }))).toContain(
      'notification_subject_mismatch',
    );
  });

  it('選んだ案が使えず開いた案が残る時は、推薦が無くても選び直しを知らせる', () => {
    const choices = {
      status: 'decidable',
      chosenOptionKey: 'old',
      options: [
        option('old', { decisionDeadline: '2026-12-06T18:00+09:00', expired: true }),
        option('early', { decisionDeadline: '2026-12-06T20:00+09:00' }),
      ],
    };
    expect(violations(check('by', decide, choices))).toEqual([]);
    expect(violations(check('by', decide, { ...choices, inUseOptionKey: 'old' }))).toContain(
      'notification_subject_mismatch',
    );
  });

  it('やめたやり方を新たな本命や予備として知らせず、別の開いた案を照らす', () => {
    const family = household();
    family.stoppedWayIds = ['retired'];
    const choices = {
      status: 'decidable',
      options: [
        option('early', { templateId: 'retired', decisionDeadline: '2026-12-06T20:00+09:00' }),
        option('late', { templateId: 'active', decisionDeadline: '2026-12-06T21:00+09:00' }),
      ],
    };
    const checkFor = (intent: unknown, overrides: Record<string, unknown> = choices) =>
      check('by', intent, overrides, '2026-12-06T16:00+09:00', eventsOf('by'), family);
    expect(violations(checkFor(decide))).toContain('notification_subject_mismatch');
    const late = {
      ...decide,
      key: 'decide:arrangement:late:a',
      subject: { ...decide.subject, optionId: 'late' },
      until: '2026-12-06T21:00+09:00',
    };
    expect(violations(checkFor(late))).not.toContain('notification_subject_mismatch');
    // すでに予備として選んだ物は、やめた後も本命に替えられる。
    expect(
      violations(
        checkFor(decide, {
          ...choices,
          chosenOptionKey: 'other',
          backupOptionKeys: ['early'],
        }),
      ),
    ).not.toContain('notification_subject_mismatch');
  });

  it('やめた案を返事待ちの予備として知らせない', () => {
    const family = household();
    const request = {
      requestId: 'request',
      taskKey: 'sent',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'awaitingReply',
      basis: { itemIds: [], arrangementKey: 'arrangement' },
      live: true,
    };
    const intent = {
      ...decide,
      key: 'backup:arrangement:early:a',
      titleKey: 'notify.backup',
      subject: { ...decide.subject, requestId: 'request' },
    };
    const current = plan({
      now: '2026-12-06T16:00+09:00',
      requests: [request],
      arrangements: [
        arrangementOf('by', {
          status: 'dependsOnReply',
          chosenOptionKey: 'other',
          options: [option('early', { templateId: 'retired', decisionDeadline: intent.until })],
        }),
      ],
    });
    const checkFor = () =>
      verifyNotifications({ household: family, plan: current, events: [], intents: [intent] });
    expect(violations(checkFor())).not.toContain('notification_subject_mismatch');
    family.stoppedWayIds = ['retired'];
    expect(violations(checkFor())).toContain('notification_subject_mismatch');
  });

  it('選んだやり方が全て停止中なら、選び直しとして知らせる', () => {
    const family = household();
    family.stoppedWayIds = ['retired'];
    const choices = {
      status: 'decidable',
      options: [option('early', { templateId: 'retired', decisionDeadline: decide.until })],
    };
    const checkFor = (intent: unknown) =>
      check('by', intent, choices, '2026-12-06T16:00+09:00', eventsOf('by'), family);
    expect(violations(checkFor(ways))).not.toContain('notification_subject_mismatch');
    expect(violations(checkFor(decide))).toContain('notification_subject_mismatch');
  });

  it('受け持ち未確認は窓の形と notCovered が必要で、終了したら知らせない', () => {
    const uncovered = {
      status: 'decidable',
      chosenOptionKey: 'one',
      inUseOptionKey: 'one',
      reasons: [{ code: 'notCovered', refs: [] }],
    };
    expect(violations(check('window', gaps, uncovered, '2026-12-06T07:00+09:00'))).toEqual([]);
    expect(violations(check('window', gaps, uncovered, '2026-12-06T06:59+09:00'))).toContain(
      'notification_wrong_time',
    );
    expect(violations(check('window', gaps, uncovered, '2026-12-07T09:30+09:00'))).toEqual([]);
    expect(violations(check('window', gaps, uncovered, '2026-12-07T11:00+09:00'))).toContain(
      'notification_expired',
    );
    expect(violations(check('window', gaps, { ...uncovered, reasons: [] }))).toContain(
      'notification_subject_mismatch',
    );
    expect(
      violations(check('by', { ...gaps, until: '2026-12-07T18:00+09:00' }, uncovered)),
    ).toContain('notification_subject_mismatch');
  });

  it('手配の形と時刻が確認済みの事項に反していれば拒み、根拠が無ければ未判定', () => {
    expect(
      violations(check('by', windowWays, { needShape: 'window', end: '2026-12-07T11:00+09:00' })),
    ).toEqual(
      expect.arrayContaining([
        'notification_need_shape_mismatch',
        'notification_need_frame_mismatch',
      ]),
    );
    expect(violations(check('window', windowWays, { start: '2026-12-07T10:00+09:00' }))).toContain(
      'notification_need_frame_mismatch',
    );
    const empty = verifyNotifications({
      household: household(),
      events: [],
      intents: [ways],
      plan: plan({
        now: '2026-12-06T16:00+09:00',
        requirements: [requirementOf()],
        arrangements: [arrangementOf('by')],
      }),
    });
    expect(empty.issues.map((i) => i.code)).toContain('notification_need_evidence_unverified');
    expect(empty.issues.filter((i) => i.kind === 'violation')).toEqual([]);
  });

  it('読み取っただけの事項に手配が捏造されても、通知の根拠にしない', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: { ...source, sender: 'school' } }),
      event(3, {
        type: 'modelOutputRecorded',
        call: 'extract',
        sourceId: 'n-need',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'n-need',
          items: [item('by')],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }),
    ];
    expect(violations(check('by', ways, {}, '2026-12-06T16:00+09:00', events))).toContain(
      'notification_subject_mismatch',
    );
  });

  it('確認済みの条件付き事項は、条件が未定でも書かれた締切を照らせる', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: { ...source, sender: 'school' } }),
      event(3, {
        type: 'modelOutputRecorded',
        call: 'extract',
        sourceId: 'n-need',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'n-need',
          items: [{ ...item('by'), conditionNodeId: 'n-need:c1' }],
          unknowns: [
            { id: 'n-need:u1', label: '申し込むか', kind: 'family', values: ['yes', 'no'] },
          ],
          conditions: [{ id: 'n-need:c1', kind: 'eq', unknownId: 'n-need:u1', value: 'yes' }],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }),
      event(4, { type: 'itemConfirmed', itemId: 'n-need:i1' }),
    ];
    const result = check('by', ways, { conditional: true }, '2026-12-06T16:00+09:00', events);
    expect(violations(result)).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).not.toContain(
      'notification_need_evidence_unverified',
    );
    const answered = [
      ...events,
      event(5, { type: 'answered', unknownId: 'n-need:u1', value: 'no' }),
    ];
    expect(
      violations(check('by', ways, { conditional: true }, '2026-12-06T16:00+09:00', answered)),
    ).toContain('notification_subject_mismatch');
  });

  it('二つの新しい通知は固定文と kind だけを許す', () => {
    for (const [i, language, title, body] of [
      [ways, 'ja', 'まにあう', '進め方がまだ決まっていないことがあります。日が近づいています。'],
      [
        ways,
        'en',
        'Maniau',
        'Something still has no way to proceed chosen, and its date is coming up.',
      ],
      [gaps, 'ja', 'まにあう', 'まだ受け持ちを確かめられていない時間があります。'],
      [gaps, 'en', 'Maniau', 'Some hours still have no one confirmed to cover them.'],
    ] as const) {
      const result = verifyNotificationMessage({
        language,
        intents: [i],
        message: { title, body, titleKey: i.titleKey, count: 1 },
      });
      expect(result.issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
    }
    expect(violations(check('by', { ...ways, kind: 'assignment' }))).toContain(
      'notification_kind_mismatch',
    );
  });
});
