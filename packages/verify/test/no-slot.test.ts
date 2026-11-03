// 家庭の週と手書きの計画を使い、時間を決められない案の表示を検証する。
import { DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { collectFacts } from '../src/facts';
import { Collector } from '../src/report';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const homeStep = { id: 'home', name: '家で準備', durationMin: 10, segments: ['home'] };
const counterStep = {
  id: 'counter',
  name: '窓口に出す',
  durationMin: 15,
  segments: ['away'],
  placeId: 'store',
};

function check(
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
  reason: Record<string, unknown> = { code: 'noSlot', refs: ['option'] },
  arrangementOverrides: Record<string, unknown> = {},
) {
  const family = Household.parse({
    ...household(),
    ways: [{ id: 'way', name: '架空の方法', steps, cost: {}, cancellable: true }],
  });
  return verifyPlan({
    household: family,
    events: [],
    plan: plan({
      requirements: [requirement({ kind: 'need' })],
      arrangements: [
        arrangement({
          kind: 'need',
          status: 'undetermined',
          reasons: [reason],
          options: [option('option', { templateId: 'way', noSlot: true, ...overrides })],
          ...arrangementOverrides,
        }),
      ],
    }),
  });
}

const codes = (result: ReturnType<typeof check>, kind: 'violation' | 'undetermined') =>
  result.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('置けない手順がある案', () => {
  it('窓口にいる週の区間が無い一手順は、登録された週と矛盾しない', () => {
    const result = check([counterStep]);
    expect(codes(result, 'violation')).not.toContain('no_slot_mismatch');
    expect(codes(result, 'undetermined')).not.toContain('no_slot_unverified');
  });

  it('場所を指定しない全手順に十分な区間があるのに、無いとは言えない', () => {
    const result = check([homeStep, { ...homeStep, id: 'second' }]);
    expect(codes(result, 'violation')).toContain('no_slot_mismatch');
  });

  it('置ける手順と置けない手順が混ざれば、どの手順が済んだか未判定', () => {
    const result = check([homeStep, counterStep]);
    expect(codes(result, 'violation')).not.toContain('no_slot_mismatch');
    expect(codes(result, 'undetermined')).toContain('no_slot_unverified');
  });

  it('場所のある手順に区間があっても、営業時間の照合は未判定', () => {
    const result = check([{ ...homeStep, placeId: 'home' }]);
    expect(codes(result, 'violation')).not.toContain('no_slot_mismatch');
    expect(codes(result, 'undetermined')).toContain('no_slot_unverified');
  });

  it('手配の未判定の理由は、個々の案に noSlot の印がなくてもよい', () => {
    const result = check([homeStep], { noSlot: undefined });
    expect(codes(result, 'violation')).not.toContain('no_slot_reason_invalid');
  });

  it('既存の子の居場所の案も、その案の雛形と家庭の週を照らす', () => {
    const result = verifyPlan({
      household: household(),
      events: [],
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({
            status: 'undetermined',
            reasons: [{ code: 'noSlot', refs: ['option'] }],
            options: [option('option', { templateId: 'one', noSlot: true })],
          }),
        ],
      }),
    });
    expect(codes(result, 'violation')).toContain('no_slot_mismatch');
  });

  it('決め時と置けない印を同時に付けたり、理由に存在しない案を挙げたりしない', () => {
    expect(
      codes(
        check([counterStep], {
          decisionDeadline: '2026-12-06T20:00+09:00',
          deadlineCertainty: 'estimate',
        }),
        'violation',
      ),
    ).toEqual(expect.arrayContaining(['no_slot_inconsistent', 'no_slot_reason_invalid']));
    expect(
      codes(check([counterStep], {}, { code: 'noSlot', refs: ['missing'] }), 'violation'),
    ).toContain('no_slot_reason_invalid');
    expect(codes(check([counterStep], { expired: true }), 'violation')).toContain(
      'no_slot_reason_invalid',
    );
  });

  it('家族は選べるが、時刻を決められない案を推薦しない', () => {
    const result = check([counterStep], {}, undefined, {
      status: 'decidable',
      reasons: [],
      recommendedOptionKey: 'option',
    });
    expect(codes(result, 'violation')).toContain('no_slot_recommended');
  });
});

/** 計画の expired や手配の end でなく、元の事項と家庭の決まりで締切を照らす。 */
function pastNeed({
  now = '2026-12-02T09:00+09:00',
  deadline = '2026-12-02T08:00+09:00',
  end = deadline,
  wayDeadline,
  sourceEvents = true,
  shape = 'by',
}: {
  now?: string;
  deadline?: string;
  end?: string;
  wayDeadline?: { type: 'onTheDay'; at: string };
  sourceEvents?: boolean;
  shape?: 'by' | 'window';
} = {}) {
  const family = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way',
        name: '架空の方法',
        ...(wayDeadline ? { deadline: wayDeadline } : {}),
        steps: [counterStep],
        cost: {},
        cancellable: true,
      },
    ],
  });
  const events = sourceEvents
    ? [
        event(1, { type: 'householdSet', household: family }),
        event(2, {
          type: 'noticeReceived',
          source: {
            id: 'source',
            version: 1,
            receivedAt: '2026-11-30T10:00+09:00',
            sender: 'family',
            language: 'ja',
            sentences: [{ id: 'sentence', text: '架空の申込' }],
          },
        }),
        event(3, {
          type: 'itemsStated',
          sourceId: 'source',
          items: [
            {
              id: 'item',
              sourceId: 'source',
              sentenceIds: ['sentence'],
              kind: 'need',
              written: '架空の申込',
              interpretation:
                shape === 'by'
                  ? { what: '架空の申込', shape, deadline }
                  : {
                      what: '架空の申込',
                      shape,
                      date: '2026-12-02',
                      startTime: '08:00',
                      endTime: '10:00',
                    },
              evidence: 'stated',
              effects: [],
            },
          ],
        }),
      ]
    : [];
  return verifyPlan({
    household: family,
    events,
    plan: plan({
      throughSeq: events.length,
      now,
      requirements: [requirement({ kind: 'need', basis: { itemIds: ['item'] } })],
      arrangements: [
        arrangement({
          kind: 'need',
          needShape: shape,
          start: shape === 'window' ? '2026-12-02T08:00+09:00' : end,
          end: shape === 'window' ? '2026-12-02T10:00+09:00' : end,
          status: 'infeasible',
          reasons: [{ code: 'noOptionLeft', refs: ['option'] }],
          options: [option('option', { templateId: 'way', noSlot: true, expired: true })],
        }),
      ],
    }),
  });
}

describe('決め時のない案の締切', () => {
  it('家族の事項から締切が過ぎたと分かる時は、未判定の案を残した違反にしない', () => {
    expect(codes(pastNeed(), 'violation')).not.toContain('infeasible_with_unknown_option');
  });

  it('手配の表示を過去に改ざんしても、家族の締切がまだなら不可能と言わない', () => {
    const report = pastNeed({
      deadline: '2026-12-02T10:00+09:00',
      end: '2026-12-02T08:00+09:00',
    });
    expect(codes(report, 'violation')).toContain('infeasible_with_unknown_option');
    expect(codes(report, 'violation')).toContain('expired_state_mismatch');
  });

  it('家庭のやり方の締切が事項の締切より早く、実際に過ぎた時も照らせる', () => {
    const report = pastNeed({
      deadline: '2026-12-02T10:00+09:00',
      wayDeadline: { type: 'onTheDay', at: '08:00' },
    });
    expect(codes(report, 'violation')).not.toContain('infeasible_with_unknown_option');
  });

  it('事項の事象が無い時は、計画だけで過ぎたとは証明しない', () => {
    expect(codes(pastNeed({ sourceEvents: false }), 'violation')).toContain(
      'infeasible_with_unknown_option',
    );
  });

  it('窓の形では、窓の終わりでなく書かれた始まりを申込の上限とする', () => {
    expect(codes(pastNeed({ shape: 'window' }), 'violation')).not.toContain(
      'infeasible_with_unknown_option',
    );
  });

  it('子の居場所は、出典の日付と家庭の手の締切から過ぎたことを確かめる', () => {
    const family = household();
    const events = [
      event(1, { type: 'householdSet', household: family }),
      event(2, {
        type: 'noticeReceived',
        source: {
          id: 'source',
          version: 1,
          receivedAt: '2026-11-30T10:00+09:00',
          sender: 'family',
          language: 'ja',
          sentences: [{ id: 'sentence', text: '架空の休み' }],
        },
      }),
      event(3, {
        type: 'itemsStated',
        sourceId: 'source',
        items: [
          {
            id: 'day',
            sourceId: 'source',
            sentenceIds: ['sentence'],
            kind: 'dayChange',
            written: '架空の休み',
            interpretation: { date: '2026-12-07', dayType: 'noSchool' },
            evidence: 'stated',
            effects: [],
          },
        ],
      }),
    ];
    const report = verifyPlan({
      household: family,
      events,
      plan: plan({
        throughSeq: 3,
        now: '2026-12-05T09:00+09:00',
        requirements: [requirement({ date: '2026-12-07', basis: { itemIds: ['day'] } })],
        arrangements: [
          arrangement({
            status: 'infeasible',
            reasons: [{ code: 'noOptionLeft', refs: ['one'] }],
            options: [option('one', { expired: true })],
          }),
        ],
      }),
    });
    expect(codes(report, 'violation')).not.toContain('infeasible_with_unknown_option');
  });

  it('確かめた事項の条件や置換・取消しが未定でも、条件付きの元の分岐の締切を照らす', () => {
    const family = Household.parse({
      ...household(),
      ways: [{ id: 'way', name: '窓口', steps: [counterStep], cost: {}, cancellable: true }],
    });
    const source = {
      id: 'source',
      version: 1,
      receivedAt: '2026-11-30T10:00+09:00',
      sender: 'school',
      language: 'ja',
      sentences: [{ id: 'sentence', text: '希望する場合は12月4日まで。' }],
    };
    const item = {
      id: 'item',
      sourceId: 'source',
      sentenceIds: ['sentence'],
      kind: 'need',
      written: '希望する場合は12月4日まで。',
      evidence: 'stated',
      interpretation: {
        what: '申込',
        shape: 'by',
        deadline: '2026-12-04T00:00+09:00',
        deadlineDayOnly: true,
      },
      conditionNodeId: 'root',
      effects: [],
    };
    const checkConditional = (
      changeKind?: 'cancel' | 'replace',
      options: {
        noOriginalCondition?: boolean;
        noRequirementMark?: boolean;
        multipleBasis?: boolean;
        stale?: boolean;
        incomplete?: boolean;
        dismissed?: boolean;
      } = {},
    ) => {
      const change = {
        id: 'change',
        sourceId: 'source',
        sentenceIds: ['sentence'],
        kind: 'event',
        written: '条件により変わるかもしれません。',
        evidence: 'stated',
        interpretation: {},
        conditionNodeId: 'root',
        effects: [{ type: changeKind, itemId: 'item' }],
      };
      const current = options.noOriginalCondition ? { ...item, conditionNodeId: undefined } : item;
      const allEvents = [
        event(1, { type: 'householdSet', household: family }),
        event(2, { type: 'noticeReceived', source }),
        event(3, {
          type: 'modelOutputRecorded',
          call: 'extract',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          sourceId: 'source',
          sourceVersion: 1,
          output: {
            sourceId: 'source',
            items: changeKind ? [current, change] : [current],
            unknowns: [{ id: 'u', label: '希望するか', kind: 'family', values: ['yes', 'no'] }],
            conditions: [{ id: 'root', kind: 'eq', unknownId: 'u', value: 'yes' }],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
        }),
        event(4, { type: 'itemConfirmed', itemId: 'item' }),
        ...(options.stale
          ? [
              event(5, {
                type: 'transcriptionCorrected',
                sourceId: 'source',
                sourceVersion: 2,
                sentences: source.sentences,
              }),
            ]
          : []),
        ...(options.dismissed
          ? [event(5, { type: 'itemDismissed', itemId: 'item', reason: 'notOurs' })]
          : []),
      ].map((entry) => DomainEvent.parse(entry));
      const events = options.incomplete ? allEvents.filter((entry) => entry.seq !== 1) : allEvents;
      const facts = collectFacts(events, new Collector());
      expect(facts.needConfirmation.get('item')).toBe(
        options.dismissed ? 'dismissed' : 'confirmed',
      );
      expect(facts.active.get('item')).toBe(options.dismissed ? false : 'unknown');
      if (changeKind) expect(facts.changes.get('item')?.[0]?.active).toBe('unknown');
      return verifyPlan({
        household: family,
        events,
        plan: plan({
          throughSeq: allEvents.at(-1)?.seq ?? 0,
          now: '2026-12-05T09:00+09:00',
          requirements: [
            requirement({
              kind: 'need',
              conditional: !options.noRequirementMark,
              basis: { itemIds: options.multipleBasis ? ['item', 'other'] : ['item'] },
            }),
          ],
          arrangements: [
            arrangement({
              kind: 'need',
              needShape: 'by',
              start: '2026-12-04T23:59+09:00',
              end: '2026-12-04T23:59+09:00',
              conditional: true,
              status: 'infeasible',
              reasons: [{ code: 'noOptionLeft', refs: ['option'] }],
              options: [option('option', { templateId: 'way', noSlot: true, expired: true })],
            }),
          ],
        }),
      });
    };
    expect(codes(checkConditional(), 'violation')).not.toContain('infeasible_with_unknown_option');
    for (const changeKind of ['cancel', 'replace'] as const) {
      for (const noOriginalCondition of [false, true]) {
        const result = checkConditional(changeKind, { noOriginalCondition });
        expect(codes(result, 'violation')).not.toContain('infeasible_with_unknown_option');
        expect(codes(result, 'undetermined')).toContain('item_condition_unknown');
      }
      expect(
        codes(checkConditional(changeKind, { noRequirementMark: true }), 'violation'),
      ).toContain('infeasible_with_unknown_option');
    }
    for (const options of [
      { multipleBasis: true },
      { stale: true },
      { incomplete: true },
      { dismissed: true },
    ]) {
      expect(codes(checkConditional('cancel', options), 'violation')).toContain(
        'infeasible_with_unknown_option',
      );
    }
  });

  it('決め時は不明でも、今の依頼が実際に断られた案は使えない', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const window = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, {
        type: 'externalRequestSent',
        taskKey: 't',
        requestId: 'r',
        snapshot: { to: 'helper', kind: 'reply', basis, window },
      }),
      event(4, { type: 'externalReplyRecorded', requestId: 'r', reply: 'no' }),
    ];
    const snapshot = plan({
      throughSeq: 4,
      requirements: [requirement()],
      arrangements: [
        arrangement({
          status: 'infeasible',
          reasons: [
            { code: 'turnedDown', refs: ['r'] },
            { code: 'noOptionLeft', refs: ['one'] },
          ],
          chosenOptionKey: 'one',
          options: [option('one', { taskKeys: ['t'] })],
        }),
      ],
      tasks: [
        task('t', {
          basis,
          commitment: 'done',
          external: { to: 'helper', kind: 'reply' },
          start: undefined,
          end: undefined,
        }),
      ],
      requests: [
        {
          requestId: 'r',
          taskKey: 't',
          to: 'helper',
          kind: 'reply',
          sentAt: '2026-11-30T10:00+09:00',
          sentBy: 'a',
          state: 'turnedDown',
          basis,
          window,
          live: true,
        },
      ],
    });
    const report = verifyPlan({ household: household(), events, plan: snapshot });
    expect(codes(report, 'violation')).not.toContain('infeasible_with_unknown_option');
    const incomplete = verifyPlan({
      household: household(),
      events: events.filter((entry) => entry.seq !== 1),
      plan: snapshot,
    });
    expect(codes(incomplete, 'violation')).toContain('infeasible_with_unknown_option');
  });
});
