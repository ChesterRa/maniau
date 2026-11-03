// 合成の出典と家族の事象から、確認・訂正・取り下げ・削除を独立に検査する。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>, kind?: 'violation' | 'undetermined') =>
  report.issues
    .filter((issue) => kind === undefined || issue.kind === kind)
    .map((issue) => issue.code);

const source = (id: string) => ({
  id,
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'school',
  language: 'ja',
  sentences: [{ id: `${id}-s1`, text: '架空のお知らせ' }],
});
const item = (id: string, sourceId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sourceId,
  sentenceIds: [`${sourceId}-s1`],
  kind: 'belongings',
  written: '白いシャツ',
  interpretation: { what: '白いシャツ' },
  evidence: 'stated',
  effects: [],
  ...overrides,
});
const extraction = (
  sourceId: string,
  items: unknown[],
  overrides: Record<string, unknown> = {},
) => ({
  sourceId,
  items,
  unknowns: [],
  conditions: [],
  irrelevantSentenceIds: [],
  ambiguities: [],
  ...overrides,
});
const reading = (sourceId: string, output: unknown, sourceVersion?: number) => ({
  type: 'modelOutputRecorded',
  call: 'extract',
  model: 'fixture',
  promptVersion: 'fixture',
  inputHash: 'fixture',
  sourceId,
  output,
  ...(sourceVersion === undefined ? {} : { sourceVersion }),
});
const req = (what = '白いシャツ', overrides: Record<string, unknown> = {}) =>
  requirement({ kind: 'belongings', what, basis: { itemIds: ['i'] }, ...overrides });
const base = (evidence = 'stated') => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source: source('n1') }),
  event(3, reading('n1', extraction('n1', [item('i', 'n1', { evidence })]), 1)),
];

describe('事項への家族の言明', () => {
  it('まだ届いたと確かめられない出典の読み取りを、後で届いても使わない', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, reading('n1', extraction('n1', [item('i', 'n1')]), 1)),
      event(3, { type: 'noticeReceived', source: source('n1') }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, requirements: [req()] }),
      events,
    });
    expect(codes(report, 'undetermined')).toContain('source_missing');
    expect(codes(report, 'undetermined')).toContain('basis_item_missing');
  });

  it('出典が食い違う読み取りを、正しい前の読み取りに上書きしない', () => {
    const invalidOutput = extraction('n1', [item('i', 'n1', { evidence: 'inferred' })]);
    const events = [
      ...base(),
      event(4, { type: 'noticeReceived', source: source('n2') }),
      event(5, reading('n2', invalidOutput, 1)),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [req()] }),
      events,
    });
    expect(codes(report, 'violation')).toContain('extraction_source_mismatch');
    expect(codes(report, 'violation')).not.toContain('unconfirmed_required_item');
  });

  it('事項の出典が読み取りと食い違う時も、前の読み取りを保つ', () => {
    const invalidOutput = extraction('n1', [item('i', 'n2', { evidence: 'inferred' })]);
    const events = [...base(), event(4, reading('n1', invalidOutput, 1))];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events,
    });
    expect(codes(report, 'violation')).toContain('item_source_mismatch');
    expect(codes(report, 'violation')).not.toContain('unconfirmed_required_item');
  });

  it('推定は確認前に必須にせず、本人が確認すれば必須にできる', () => {
    const before = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, requirements: [req()] }),
      events: base('inferred'),
    });
    expect(codes(before, 'violation')).toContain('unconfirmed_required_item');
    const after = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events: [...base('inferred'), event(4, { type: 'itemConfirmed', itemId: 'i' })],
    });
    expect(codes(after, 'violation')).not.toContain('unconfirmed_required_item');
    expect(codes(after, 'violation')).not.toContain('inactive_item_basis');
  });

  it('仕組みや家族以外の人の確認を、家族の確認にしない', () => {
    for (const actorId of ['system', 'helper', 'absent']) {
      const report = verifyPlan({
        household: household(),
        plan: plan({ throughSeq: 4, requirements: [req()] }),
        events: [...base('inferred'), event(4, { type: 'itemConfirmed', itemId: 'i', actorId })],
      });
      expect(codes(report, 'violation')).toContain('family_event_actor_invalid');
      expect(codes(report, 'violation')).toContain('unconfirmed_required_item');
    }
  });

  it('関係ないとした事項は要件にできず、後の確認で戻る', () => {
    const dismissed = [
      ...base(),
      event(4, { type: 'itemDismissed', itemId: 'i', reason: 'notOurs' }),
    ];
    const before = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events: dismissed,
    });
    expect(codes(before, 'violation')).toContain('inactive_item_basis');
    const after = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [req()] }),
      events: [...dismissed, event(5, { type: 'itemConfirmed', itemId: 'i' })],
    });
    expect(codes(after, 'violation')).not.toContain('inactive_item_basis');
  });

  it('直した品名を使わず旧い解釈を確定の要件にすると検出する', () => {
    const events = [
      ...base(),
      event(4, { type: 'itemCorrected', itemId: 'i', interpretation: { what: '赤い帽子' } }),
    ];
    const oldPlan = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events,
    });
    expect(codes(oldPlan, 'violation')).toContain('corrected_requirement_mismatch');
    const corrected = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req('赤い帽子')] }),
      events,
    });
    expect(codes(corrected, 'violation')).not.toContain('corrected_requirement_mismatch');
  });

  it('一つの事項に対応する品物・提出物の要件は、その事項の今の名前と照らす', () => {
    for (const kind of ['belongings', 'submission'] as const) {
      const events = [
        event(1, { type: 'householdSet', household: household() }),
        event(2, { type: 'noticeReceived', source: source('n1') }),
        event(3, reading('n1', extraction('n1', [item('i', 'n1', { kind })]), 1)),
        event(4, { type: 'noticeReceived', source: source('n2') }),
        event(
          5,
          reading(
            'n2',
            extraction('n2', [
              item('j', 'n2', {
                kind,
                interpretation: { what: '赤い帽子' },
                effects: [{ type: 'replace', itemId: 'i' }],
              }),
            ]),
            1,
          ),
        ),
      ];
      const check = (what: string) =>
        verifyPlan({
          household: household(),
          events,
          plan: plan({
            throughSeq: 5,
            requirements: [
              requirement({
                kind,
                what,
                basis: { itemIds: ['j'] },
              }),
            ],
          }),
        });
      expect(codes(check('白いシャツ'), 'violation')).toContain('requirement_content_mismatch');
      expect(codes(check('赤い帽子'), 'violation')).not.toContain('requirement_content_mismatch');
    }
  });

  it('一つの休業事項に対応する子の居場所は、今の事項の日と照らす', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(
        3,
        reading(
          'n1',
          extraction('n1', [
            item('i', 'n1', {
              kind: 'dayChange',
              interpretation: { what: '振替休業日', dayType: 'noSchool', date: '2026-12-14' },
            }),
          ]),
          1,
        ),
      ),
    ];
    const check = (date: string) =>
      verifyPlan({
        household: household(),
        events,
        plan: plan({
          throughSeq: 3,
          requirements: [
            requirement({
              what: '振替休業日',
              date,
              basis: { itemIds: ['i'] },
            }),
          ],
        }),
      });
    expect(codes(check('2026-12-07'), 'violation')).toContain('requirement_date_mismatch');
    expect(codes(check('2026-12-14'), 'violation')).not.toContain('requirement_date_mismatch');
  });

  it('条件が未定か書き直し前の読み取りなら、用件や日を食い違いと断定しない', () => {
    const conditional = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(
        3,
        reading(
          'n1',
          extraction('n1', [item('i', 'n1', { conditionNodeId: 'c' })], {
            unknowns: [{ id: 'u', label: '天気', values: ['rain', 'sun'], kind: 'other' }],
            conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'rain' }],
          }),
          1,
        ),
      ),
    ];
    const uncertain = verifyPlan({
      household: household(),
      events: conditional,
      plan: plan({ throughSeq: 3, requirements: [req('赤い帽子', { conditional: true })] }),
    });
    expect(codes(uncertain, 'violation')).not.toContain('requirement_content_mismatch');
    expect(codes(uncertain, 'undetermined')).toContain('requirement_content_unverified');

    const stale = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(
        3,
        reading(
          'n1',
          extraction('n1', [
            item('i', 'n1', {
              kind: 'dayChange',
              interpretation: { what: '振替休業日', dayType: 'noSchool', date: '2026-12-14' },
            }),
          ]),
          1,
        ),
      ),
      event(4, {
        type: 'transcriptionCorrected',
        sourceId: 'n1',
        sourceVersion: 2,
        sentences: [{ id: 'n1-s1', text: '書き直した文' }],
      }),
    ];
    const staleReport = verifyPlan({
      household: household(),
      events: stale,
      plan: plan({
        throughSeq: 4,
        requirements: [
          requirement({
            date: '2026-12-07',
            conditional: true,
            basis: { itemIds: ['i'] },
          }),
        ],
      }),
    });
    expect(codes(staleReport, 'violation')).not.toContain('requirement_date_mismatch');
    expect(codes(staleReport, 'undetermined')).toContain('requirement_date_unverified');
  });

  it('本文が書き直された後は、旧い読み取りの訂正と現在の品名の一致を断定しない', () => {
    const events = [
      ...base(),
      event(4, { type: 'itemCorrected', itemId: 'i', interpretation: { what: '赤い帽子' } }),
      event(5, {
        type: 'transcriptionCorrected',
        sourceId: 'n1',
        sourceVersion: 2,
        sentences: [{ id: 'n1-s1', text: '新しい文' }],
      }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [req('白いシャツ', { conditional: true })] }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('corrected_requirement_mismatch');
    expect(codes(report, 'undetermined')).toContain('corrected_requirement_stale');
  });
});

describe('出典の取り下げと削除', () => {
  const basis = {
    itemIds: ['i'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'one',
  };
  const sent = [
    ...base(),
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
      snapshot: { to: 'helper', kind: 'reply', basis },
    }),
  ];
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
  };

  it('全て消した出典の ID を、新しいお知らせで再使用しない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5 }),
      events: [
        ...base(),
        event(4, { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all', actorId: 'system' }),
        event(5, { type: 'noticeReceived', source: source('n1') }),
      ],
    });
    expect(codes(report, 'violation')).toContain('purged_source_id_reused');
  });

  it('取り下げた唯一の出典で送った依頼には、取消しの連絡が要る', () => {
    const events = [...sent, event(7, { type: 'sourceWithdrawn', sourceId: 'n1' })];
    const without = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...request, live: false }] }),
      events,
    });
    expect(codes(without, 'violation')).toContain('cancellation_missing');
    const withCancellation = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 7,
        requests: [{ ...request, live: false }],
        tasks: [task('cancel', { cancels: 'r', start: undefined, end: undefined })],
      }),
      events,
    });
    expect(codes(withCancellation, 'violation')).not.toContain('cancellation_missing');
  });

  it('写真だけを消しても、元の文と計画は変わらない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events: [
        ...base(),
        event(4, {
          type: 'sourceContentPurged',
          sourceId: 'n1',
          scope: 'photo',
          actorId: 'system',
        }),
      ],
    });
    expect(codes(report, 'violation')).not.toContain('inactive_item_basis');
    expect(codes(report)).not.toContain('basis_item_missing');
  });

  it('書き直した出典に頼る送信済み依頼は、新しい読み取りまで要確認', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 7,
        requirements: [req('白いシャツ', { conditional: true })],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            conditional: true,
            options: [option('one', { taskKeys: [] })],
          }),
        ],
        requests: [{ ...request, conditional: true }],
      }),
      events: [
        ...sent,
        event(7, {
          type: 'transcriptionCorrected',
          sourceId: 'n1',
          sourceVersion: 2,
          sentences: [{ id: 'n1-s1', text: '赤い帽子' }],
        }),
      ],
    });
    expect(codes(report, 'violation')).toContain('request_uncertainty_unmarked');
  });

  it('仕組み以外の削除事象は違反にし、出典を消えた事にしない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events: [...base(), event(4, { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all' })],
    });
    expect(codes(report, 'violation')).toContain('system_event_actor_invalid');
    expect(codes(report)).not.toContain('basis_item_missing');
  });

  it('お知らせ全体の削除は、依頼を要確認にし、取消しとは決めない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 7, requests: [{ ...request, needsCheck: true }] }),
      events: [
        ...sent,
        event(7, { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all', actorId: 'system' }),
      ],
    });
    expect(codes(report, 'violation')).not.toContain('cancellation_missing');
    expect(codes(report, 'violation')).not.toContain('request_liveness_mismatch');
    expect(codes(report, 'undetermined')).toContain('request_need_unverified');
    expect(codes(report, 'undetermined')).toContain('basis_item_missing');
  });

  it('削除で読み取りの中身が無い履歴は、不正なモデル応答と決めつけない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4 }),
      events: [
        event(1, { type: 'householdSet', household: household() }),
        event(2, { type: 'noticeReceived', source: source('n1') }),
        event(3, reading('n1', null, 1)),
        event(4, { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all', actorId: 'system' }),
      ],
    });
    expect(codes(report, 'violation')).not.toContain('invalid_extraction');
    expect(codes(report, 'undetermined')).toContain('purged_extraction_unavailable');
  });

  it('取り下げた・消した出典の未定値は、家族の答えでも他の出典を確定しない', () => {
    const first = extraction('n1', [item('i', 'n1')], {
      unknowns: [{ id: 'u', label: '実施するか', values: ['yes', 'no'], kind: 'other' }],
    });
    const second = extraction('n2', [item('other', 'n2', { conditionNodeId: 'c' })], {
      conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
    });
    const prior = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(3, reading('n1', first, 1)),
      event(4, { type: 'answered', unknownId: 'u', value: 'yes' }),
      event(5, { type: 'noticeReceived', source: source('n2') }),
      event(6, reading('n2', second, 1)),
    ];
    for (const terminal of [
      { type: 'sourceWithdrawn', sourceId: 'n1' },
      { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all', actorId: 'system' },
    ]) {
      const report = verifyPlan({
        household: household(),
        plan: plan({
          throughSeq: 8,
          requirements: [req('白いシャツ', { basis: { itemIds: ['other'] }, conditional: true })],
        }),
        events: [
          ...prior,
          event(7, terminal),
          event(8, { type: 'itemConfirmed', itemId: 'other' }),
        ],
      });
      expect(codes(report, 'undetermined')).toContain('item_condition_unknown');
      expect(codes(report, 'violation')).not.toContain('inactive_item_basis');
      expect(codes(report, 'violation')).not.toContain('invalid_condition');
    }
  });

  it('読み直しで未定値が見つからなくなった後も、出典の削除で旧い答えを使わない', () => {
    const first = extraction('n1', [item('i', 'n1')], {
      unknowns: [{ id: 'u', label: '実施するか', values: ['yes', 'no'], kind: 'other' }],
    });
    const second = extraction('n2', [item('other', 'n2', { conditionNodeId: 'c' })], {
      conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
    });
    const prior = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(3, reading('n1', first, 1)),
      event(4, { type: 'answered', unknownId: 'u', value: 'yes' }),
      event(5, { type: 'noticeReceived', source: source('n2') }),
      event(6, reading('n2', second, 1)),
      event(7, reading('n1', extraction('n1', [item('i', 'n1')]), 1)),
    ];
    for (const terminal of [
      { type: 'sourceWithdrawn', sourceId: 'n1' },
      { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all', actorId: 'system' },
    ]) {
      const report = verifyPlan({
        household: household(),
        plan: plan({
          throughSeq: 8,
          requirements: [req('白いシャツ', { basis: { itemIds: ['other'] }, conditional: true })],
        }),
        events: [...prior, event(8, terminal)],
      });
      expect(codes(report, 'undetermined')).toContain('item_condition_unknown');
      expect(codes(report, 'violation')).not.toContain('invalid_condition');
    }
  });
});

describe('書き起こしと読み取りの版', () => {
  const corrected = event(4, {
    type: 'transcriptionCorrected',
    sourceId: 'n1',
    sourceVersion: 2,
    sentences: [{ id: 'n1-s1', text: '赤い帽子' }],
  });

  it('書き直した後、古い読み取りだけなら確定した要件として出さない', () => {
    const events = [...base(), corrected];
    const unsafe = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events,
    });
    expect(codes(unsafe, 'violation')).toContain('stale_item_unmarked');
    const conditional = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req('白いシャツ', { conditional: true })] }),
      events,
    });
    expect(codes(conditional, 'violation')).not.toContain('stale_item_unmarked');
  });

  it('新しい版を読んだ後、遅れて来た旧い版はそれを上書きしない', () => {
    const fresh = extraction('n1', [item('i', 'n1', { interpretation: { what: '赤い帽子' } })]);
    const late = extraction('n1', [item('i', 'n1', { evidence: 'inferred' })]);
    const events = [
      ...base(),
      corrected,
      event(5, reading('n1', fresh, 2)),
      event(6, reading('n1', late, 1)),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, requirements: [req('赤い帽子')] }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('unconfirmed_required_item');
    expect(codes(report, 'violation')).not.toContain('stale_item_unmarked');
  });

  it('書き直し後に版の無い結果が遅れて来ても、新しい版と見なさない', () => {
    const events = [
      ...base(),
      corrected,
      event(5, reading('n1', extraction('n1', [item('i', 'n1')]))),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [req()] }),
      events,
    });
    expect(codes(report, 'violation')).toContain('stale_item_unmarked');
  });

  it('書き直しの版が進まなければ違反として、元の版を使う', () => {
    const invalid = { ...corrected, sourceVersion: 1 };
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req()] }),
      events: [...base(), invalid],
    });
    expect(codes(report, 'violation')).toContain('transcription_version_invalid');
    expect(codes(report, 'violation')).not.toContain('stale_item_unmarked');
  });
});

describe('持ち物の使用日', () => {
  it('事項に使用日が書かれている時、違う日を使っていれば検出する', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(
        3,
        reading(
          'n1',
          extraction('n1', [
            item('i', 'n1', { interpretation: { what: '白いシャツ', date: '2026-12-14' } }),
          ]),
          1,
        ),
      ),
    ];
    const check = (date: string) =>
      verifyPlan({
        household: household(),
        events,
        plan: plan({ throughSeq: 3, requirements: [req('白いシャツ', { date })] }),
      });
    expect(codes(check('2026-12-07'), 'violation')).toContain('requirement_date_mismatch');
    expect(codes(check('2026-12-14'), 'violation')).not.toContain('requirement_date_mismatch');
  });
  it('持ち物の事項に日が無い時は、その日を独立に裏付けられない', () => {
    const result = verifyPlan({
      household: household(),
      events: base(),
      plan: plan({ throughSeq: 3, requirements: [req('白いシャツ', { date: '2026-12-14' })] }),
    });
    expect(codes(result, 'undetermined')).toContain('requirement_date_unverified');
  });
});
