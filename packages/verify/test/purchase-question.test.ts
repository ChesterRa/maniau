// 買い物の問いが、同じ品物の「家にあるか」と手配を指しているかを独立に確かめる。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, plan, requirement } from './fixtures';

const unknown = 'at-home-shirt';
const questionKey = 'question-shirt';
const events = [event(1, { type: 'householdSet', household: household() })];
const item = (extra: Record<string, unknown> = {}) =>
  requirement({
    kind: 'belongings',
    what: 'ハンカチ',
    by: '2026-12-07T08:00+09:00',
    atHomeUnknownId: unknown,
    ...extra,
  });
const purchase = (extra: Record<string, unknown> = {}) =>
  arrangement({
    kind: 'purchase',
    status: 'askFirst',
    atHomeUnknownId: unknown,
    reasons: [{ code: 'askFirst', refs: [questionKey] }],
    ...extra,
  });
const question = (extra: Record<string, unknown> = {}) => ({
  key: questionKey,
  unknownId: unknown,
  askBy: '2026-12-06T08:00+09:00',
  fallbackValue: 'no',
  affects: ['arrangement'],
  ...extra,
});
const inspect = (overrides: Record<string, unknown> = {}) =>
  verifyPlan({
    household: household(),
    events,
    plan: plan({
      throughSeq: 1,
      requirements: [item()],
      arrangements: [purchase()],
      questions: [question()],
      ...overrides,
    }),
  });
const codes = (result: ReturnType<typeof inspect>, kind: 'violation' | 'undetermined') =>
  result.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('買い物の問い', () => {
  it('同じ未定の値と手配を指していれば違反にしない', () => {
    expect(codes(inspect(), 'violation')).toEqual([]);
  });

  it('別の未定の値を聞く問いは拒む', () => {
    const result = inspect({ questions: [question({ unknownId: 'another-value' })] });
    expect(codes(result, 'violation')).toContain('purchase_question_unknown_mismatch');
  });

  it('要件だけを指し、その買い物の手配を指さない問いは拒む', () => {
    const result = inspect({ questions: [question({ affects: ['requirement'] })] });
    expect(codes(result, 'violation')).toContain('purchase_question_target_mismatch');
  });

  it('要件と手配が別の値を指していれば拒む', () => {
    const result = inspect({ arrangements: [purchase({ atHomeUnknownId: 'another-value' })] });
    expect(codes(result, 'violation')).toContain('purchase_unknown_mismatch');
  });

  it('問いの参照先が無ければ、既存の検査で拒む', () => {
    expect(codes(inspect({ questions: [] }), 'violation')).toContain('question_reason_invalid');
  });

  it('不要になった持ち物に対する問いを残したら拒む', () => {
    const result = inspect({
      requirements: [item({ live: false })],
      arrangements: [purchase({ live: false, status: 'decidable', reasons: [] })],
    });
    expect(codes(result, 'violation')).toContain('purchase_question_inactive');
  });

  it('手配が無くても、不要な要件自身を指す問いを残したら拒む', () => {
    const result = inspect({
      requirements: [item({ live: false })],
      arrangements: [],
      questions: [question({ affects: ['requirement'] })],
    });
    expect(codes(result, 'violation')).toContain('purchase_question_inactive');
  });

  it('要件が必要なままなら、無効な別の手配だけを根拠に問いを拒まない', () => {
    const result = inspect({
      arrangements: [purchase({ live: false, status: 'decidable', reasons: [] })],
      questions: [question({ affects: ['requirement'] })],
    });
    expect(codes(result, 'violation')).not.toContain('purchase_question_inactive');
  });

  it('値を照らせない古い形は、間違いと決めつけず未判定にする', () => {
    const result = inspect({
      requirements: [item({ atHomeUnknownId: undefined })],
      arrangements: [purchase({ atHomeUnknownId: undefined })],
    });
    expect(codes(result, 'violation')).not.toContain('purchase_question_unknown_mismatch');
    expect(codes(result, 'undetermined')).toContain('purchase_unknown_unverified');
  });

  it('期限前に手配ごと無い時は、家にある可能性もあるため未判定にする', () => {
    const result = inspect({ arrangements: [], questions: [] });
    expect(codes(result, 'violation')).toEqual([]);
    expect(codes(result, 'undetermined')).toContain('purchase_arrangement_absence_unverified');
  });

  it('別の種類の手配は、買い物の手配がある根拠にはならない', () => {
    const result = inspect({ arrangements: [arrangement()], questions: [] });
    expect(codes(result, 'undetermined')).toContain('purchase_arrangement_absence_unverified');
  });

  it('期限が過ぎた後の手配の不在は、未判定にしない', () => {
    const result = inspect({
      requirements: [item({ by: '2026-11-30T08:00+09:00' })],
      arrangements: [],
      questions: [],
    });
    expect(codes(result, 'undetermined')).not.toContain('purchase_arrangement_absence_unverified');
  });
});
