import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);
const notice = (seq: number, id: string, sentences: { id: string; text: string }[]) =>
  event(seq, {
    type: 'noticeReceived',
    source: {
      id,
      version: 1,
      receivedAt: '2026-11-29T10:00+09:00',
      sender: 'school',
      language: 'ja',
      sentences,
    },
  });
const extraction = (seq: number, id: string, output: Record<string, unknown>) =>
  event(seq, {
    type: 'modelOutputRecorded',
    call: 'extract',
    model: 'test',
    promptVersion: '1',
    inputHash: 'test',
    sourceId: id,
    output,
  });
const item = (id: string, sourceId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sourceId,
  sentenceIds: [`${sourceId}-s1`],
  kind: 'dayChange',
  written: '予定',
  interpretation: { date: '2026-12-07' },
  evidence: 'stated',
  ...overrides,
});
const extract = (sourceId: string, items: unknown[], overrides: Record<string, unknown> = {}) => ({
  sourceId,
  items,
  unknowns: [],
  conditions: [],
  irrelevantSentenceIds: [],
  ...overrides,
});

describe('出典と条件', () => {
  it('書かれた曜日と日付が違えば見つける', () => {
    const source = notice(1, 'n1', [{ id: 'n1-s1', text: '12月7日(火)' }]);
    const result = extract('n1', [
      item('i1', 'n1', { interpretation: { date: '2026-12-07', writtenWeekday: 2 } }),
    ]);
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [source, extraction(2, 'n1', result)],
    });
    expect(codes(report)).toContain('weekday_mismatch');
    expect(report.status).toBe('violation');
  });

  it('元の文に分類漏れがある場合と、同じ文を事項と関係なしに入れた場合を見つける', () => {
    const source = notice(1, 'n1', [
      { id: 'n1-s1', text: '予定' },
      { id: 'n1-s2', text: '持ち物' },
    ]);
    const result = extract('n1', [item('i1', 'n1')], { irrelevantSentenceIds: ['n1-s1'] });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [source, extraction(2, 'n1', result)],
    });
    expect(codes(report)).toEqual(
      expect.arrayContaining(['sentence_uncovered', 'sentence_classification_conflict']),
    );
  });

  it('未定の条件は未判定にし、後の回答で偽になった事項を生かさない', () => {
    const source = notice(1, 'n1', [{ id: 'n1-s1', text: '5日に開催する場合' }]);
    const result = extract('n1', [item('i1', 'n1', { conditionNodeId: 'condition' })], {
      unknowns: [{ id: 'date', label: '開催日', values: ['5', '8'], kind: 'schedule' }],
      conditions: [{ id: 'condition', kind: 'eq', unknownId: 'date', value: '5' }],
    });
    const req = requirement({ kind: 'belongings', basis: { itemIds: ['i1'] } });
    const baseEvents = [source, extraction(2, 'n1', result)];
    const unresolved = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, requirements: [req] }),
      events: baseEvents,
    });
    expect(codes(unresolved)).toContain('item_condition_unknown');
    expect(codes(unresolved)).not.toContain('inactive_item_basis');
    const answered = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, requirements: [req] }),
      events: [...baseEvents, event(3, { type: 'answered', unknownId: 'date', value: '8' })],
    });
    expect(codes(answered)).toContain('inactive_item_basis');
  });

  it('新しい連絡による置き換えをたどり、古い根拠を生かさない', () => {
    const first = notice(1, 'n1', [{ id: 'n1-s1', text: '変更前' }]);
    const changed = notice(3, 'n2', [{ id: 'n2-s1', text: '変更後' }]);
    const events = [
      first,
      extraction(2, 'n1', extract('n1', [item('old', 'n1')])),
      changed,
      extraction(
        4,
        'n2',
        extract('n2', [item('new', 'n2', { effects: [{ type: 'replace', itemId: 'old' }] })]),
      ),
    ];
    const req = requirement({ kind: 'belongings', basis: { itemIds: ['old'] } });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [req] }),
      events,
    });
    expect(codes(report)).toContain('inactive_item_basis');
  });

  it('未確認の推定から必須の要件を作った場合を見つける', () => {
    const source = notice(1, 'n1', [{ id: 'n1-s1', text: '予定' }]);
    const result = extract('n1', [item('i1', 'n1', { evidence: 'inferred' })]);
    const req = requirement({ kind: 'belongings', basis: { itemIds: ['i1'] } });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, requirements: [req] }),
      events: [source, extraction(2, 'n1', result)],
    });
    expect(codes(report)).toContain('unconfirmed_required_item');
  });

  it('共有された子を繰り返す条件の式を、同じ子を何度も展開せずに扱う', () => {
    const source = notice(1, 'n1', [{ id: 'n1-s1', text: '条件つきの予定' }]);
    const conditions: unknown[] = [{ id: 'c0', kind: 'eq', unknownId: 'u', value: 'yes' }];
    for (let index = 1; index <= 40; index += 1) {
      conditions.push({
        id: `c${index}`,
        kind: 'and',
        childIds: [`c${index - 1}`, `c${index - 1}`],
      });
    }
    const result = extract('n1', [item('i1', 'n1', { conditionNodeId: 'c40' })], {
      unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
      conditions,
    });
    const req = requirement({ kind: 'belongings', basis: { itemIds: ['i1'] } });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, requirements: [req] }),
      events: [source, extraction(2, 'n1', result)],
    });
    expect(codes(report)).toContain('item_condition_unknown');
  });

  it('大きすぎる条件の式を途中で成功扱いせず、未判定にする', () => {
    const source = notice(1, 'n1', [{ id: 'n1-s1', text: '条件つきの予定' }]);
    const conditions = Array.from({ length: 501 }, (_, index) => ({
      id: `c${index}`,
      kind: 'eq',
      unknownId: 'u',
      value: 'yes',
    }));
    const result = extract('n1', [item('i1', 'n1', { conditionNodeId: 'c0' })], {
      unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
      conditions,
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [source, extraction(2, 'n1', result)],
    });
    expect(codes(report)).toContain('condition_graph_too_large');
    expect(report.status).toBe('undetermined');
  });

  it('通知ごとの条件数が上限内なら、合計が 64 を超えても正しく評価する', () => {
    const first = Array.from({ length: 40 }, (_, index) => ({
      id: `a${index}`,
      kind: 'eq',
      unknownId: 'u1',
      value: 'yes',
    }));
    const second = Array.from({ length: 40 }, (_, index) => ({
      id: `b${index}`,
      kind: 'eq',
      unknownId: 'u2',
      value: 'yes',
    }));
    const events = [
      notice(1, 'n1', [{ id: 'n1-s1', text: '条件一' }]),
      extraction(
        2,
        'n1',
        extract('n1', [item('i1', 'n1', { conditionNodeId: 'a0' })], {
          conditions: first,
          unknowns: [{ id: 'u1', label: '一', values: ['yes', 'no'], kind: 'other' }],
        }),
      ),
      notice(3, 'n2', [{ id: 'n2-s1', text: '条件二' }]),
      extraction(
        4,
        'n2',
        extract('n2', [item('i2', 'n2', { conditionNodeId: 'b0' })], {
          conditions: second,
          unknowns: [{ id: 'u2', label: '二', values: ['yes', 'no'], kind: 'other' }],
        }),
      ),
      event(5, { type: 'answered', unknownId: 'u1', value: 'no' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, requirements: [requirement({ basis: { itemIds: ['i1'] } })] }),
      events,
    });
    expect(codes(report)).not.toContain('invalid_condition');
    expect(codes(report)).toContain('inactive_item_basis');
  });

  it('同じ通知の再読では、最新の事項と条件だけを現在の読みとして使う', () => {
    const events = [
      notice(1, 'n1', [{ id: 'n1-s1', text: '条件つきの予定' }]),
      extraction(
        2,
        'n1',
        extract('n1', [item('i1', 'n1', { conditionNodeId: 'c' })], {
          unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
          conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
        }),
      ),
      extraction(
        3,
        'n1',
        extract('n1', [item('i1', 'n1', { conditionNodeId: 'c' })], {
          unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
          conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'no' }],
        }),
      ),
      event(4, { type: 'answered', unknownId: 'u', value: 'yes' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requirements: [requirement({ basis: { itemIds: ['i1'] } })] }),
      events,
    });
    expect(codes(report)).not.toContain('duplicate_item');
    expect(codes(report)).not.toContain('duplicate_condition');
    expect(codes(report)).toContain('inactive_item_basis');
  });

  it('再読の作用は通知の到着順で扱い、後から答えた家族の値を上書きしない', () => {
    const reading = extract(
      'n1',
      [
        item('answer', 'n1', {
          effects: [{ type: 'resolveUnknown', unknownId: 'u', value: 'yes' }],
        }),
        item('conditional', 'n1', { conditionNodeId: 'c' }),
      ],
      {
        unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
        conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
      },
    );
    const events = [
      notice(1, 'n1', [{ id: 'n1-s1', text: '条件つきの予定' }]),
      extraction(2, 'n1', reading),
      event(3, { type: 'answered', unknownId: 'u', value: 'no' }),
      extraction(4, 'n1', reading),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        requirements: [requirement({ basis: { itemIds: ['conditional'] } })],
      }),
      events,
    });
    expect(codes(report)).toContain('inactive_item_basis');
  });

  it('再読で消えた出典の作用を残さない', () => {
    const withEffect = extract(
      'n1',
      [
        item('answer', 'n1', {
          effects: [{ type: 'resolveUnknown', unknownId: 'u', value: 'yes' }],
        }),
        item('conditional', 'n1', { conditionNodeId: 'c' }),
      ],
      {
        unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
        conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
      },
    );
    const withoutEffect = extract('n1', [item('conditional', 'n1', { conditionNodeId: 'c' })], {
      unknowns: [{ id: 'u', label: '条件', values: ['yes', 'no'], kind: 'other' }],
      conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'yes' }],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 3,
        requirements: [requirement({ basis: { itemIds: ['conditional'] } })],
      }),
      events: [
        notice(1, 'n1', [{ id: 'n1-s1', text: '予定' }]),
        extraction(2, 'n1', withEffect),
        extraction(3, 'n1', withoutEffect),
      ],
    });
    expect(codes(report)).toContain('item_condition_unknown');
  });
});
