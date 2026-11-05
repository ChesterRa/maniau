// 新しい家庭の印だけを、家庭を書いた架空の事象から照らす。
import { DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { checkCareConfirmationHistory } from '../src/care-confirmation-history';
import type { History } from '../src/history';
import { Collector } from '../src/report';
import { household } from './fixtures';

const now = '2026-11-25T19:30+09:00';
const family = () =>
  Household.parse({ ...household(), routines: [], routineExceptions: [], confirmDays: true });
const weekly = (allDay?: true, end = '17:00') => ({
  memberId: 'a',
  weekday: 1,
  segments: [{ start: '09:00', end, kind: 'work' }],
  ...(allDay ? { allDay } : {}),
});
const exception = (allDay?: true) => ({
  memberId: 'a',
  date: '2026-12-07',
  segments: [{ start: '09:00', end: '12:00', kind: 'work' }],
  ...(allDay ? { allDay } : {}),
});
const event = (seq: number, value: Household) =>
  DomainEvent.parse({
    type: 'householdSet',
    household: value,
    id: `event-${seq}`,
    householdId: value.id,
    seq,
    version: 1,
    occurredAt: now,
    recordedAt: now,
    actorId: 'a',
  });
const check = (families: Household[], complete = true) => {
  const report = new Collector();
  const current = families.at(-1);
  if (!current) throw new Error('家庭が無い');
  checkCareConfirmationHistory(
    current,
    { complete, events: families.map((h, i) => event(i + 1, h)) } as History,
    report,
  );
  return report.issues;
};
const codes = (issues: ReturnType<typeof check>) => issues.map((issue) => issue.code);

describe('全日の確認の履歴', () => {
  it('古い家庭で後から日程が加わっても、新しい確認印をさかのぼって要求しない', () => {
    const before = Household.parse({ ...household(), routines: [] });
    const after = Household.parse({ ...before, routines: [weekly()] });
    expect(check([before, after])).toEqual([]);
  });

  it('新しい家庭は、確認した日程を追加・変更できる', () => {
    const before = family();
    const added = Household.parse({ ...before, routines: [weekly(true)] });
    const changed = Household.parse({ ...added, routines: [weekly(true, '18:00')] });
    expect(check([before, added, changed])).toEqual([]);
  });

  it('新しい週の記録・当日例外に全日の確認印が無ければ違反', () => {
    const before = family();
    const weeklyMissing = Household.parse({ ...before, routines: [weekly()] });
    const exceptionMissing = Household.parse({ ...before, routineExceptions: [exception()] });
    expect(codes(check([before, weeklyMissing]))).toContain('care_day_not_confirmed');
    expect(codes(check([before, exceptionMissing]))).toContain('care_day_not_confirmed');
  });

  it('既存の日程を変更するときに確認印を外すことも検知する', () => {
    const before = family();
    const added = Household.parse({ ...before, routines: [weekly(true)] });
    const changed = Household.parse({ ...added, routines: [weekly(undefined, '18:00')] });
    expect(codes(check([before, added, changed]))).toContain('care_day_not_confirmed');
  });

  it('確認の決まりを後から付けたり外したりできない', () => {
    const strict = family();
    const { confirmDays: _removed, ...legacyValue } = strict;
    const legacy = Household.parse(legacyValue);
    expect(codes(check([strict, legacy]))).toContain('care_confirmation_policy_changed');
    expect(codes(check([legacy, strict]))).toContain('care_confirmation_policy_changed');
  });

  it('事象が欠けるか、同じ日程が二重なら、違反と決めず未判定にする', () => {
    const before = family();
    const incomplete = check([before], false);
    expect(incomplete).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'care_confirmation_history_unverified',
      }),
    );
    const repeated = Household.parse({ ...before, routines: [weekly(true), weekly(true)] });
    const ambiguous = check([before, repeated]);
    expect(ambiguous).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'care_confirmation_history_unverified',
      }),
    );
    expect(ambiguous.some((issue) => issue.kind === 'violation')).toBe(false);
  });
});
