// 家族の架空の記録について、求解と独立した検証側を時刻ごとに照らす。
import { Household, validateHousehold } from '@maniau/core';
import { careCoverage, foldEvents } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { zonedToEpochMinutes } from '../../../packages/core/src/time';
import { householdCareKnowledge } from '../../../packages/verify/src/care-household-evidence';
import { demoEvents } from '../src/demo';

const date = '2026-12-07';
const midnight = zonedToEpochMinutes(date, '00:00', 'Asia/Tokyo');
const clock = (start: string, end: string) => ({ start, end });
const choices = [
  undefined,
  { can: [], cannot: [], rest: 'unknown' },
  { can: [], cannot: [], rest: 'can' },
  { can: [], cannot: [], rest: 'cannot' },
  { can: [clock('09:00', '12:00')], cannot: [clock('15:00', '17:00')], rest: 'unknown' },
  { can: [clock('09:00', '12:00')], cannot: [clock('15:00', '17:00')], rest: 'can' },
  { can: [clock('09:00', '12:00')], cannot: [clock('15:00', '17:00')], rest: 'cannot' },
  { can: [clock('12:00', '15:00')], cannot: [clock('09:00', '12:00')], rest: 'unknown' },
] as const;

function union(rows: readonly { start: number; end: number }[]) {
  const sorted = rows.map((row) => ({ ...row })).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const row of sorted) {
    const previous = merged.at(-1);
    if (previous && row.start <= previous.end) previous.end = Math.max(previous.end, row.end);
    else merged.push(row);
  }
  return merged;
}

describe('見守りの三値を別々に計算する', () => {
  it('答えの残り・忙しい時間・端点の組合せを照らす', () => {
    const base = foldEvents(demoEvents('arrived')).household;
    if (!base) throw new Error('家庭がない');
    let count = 0;
    for (const [aIndex, a] of choices.entries()) {
      for (const [bIndex, b] of choices.entries()) {
        for (let busyMask = 0; busyMask < 4; busyMask++) {
          const dayAnswers = [
            ...(a ? [{ memberId: 'a', date, ...a }] : []),
            ...(b ? [{ memberId: 'b', date, ...b }] : []),
          ];
          const unavailable = [
            ...(busyMask & 1
              ? [{ id: 'ua', memberId: 'a', date, ...clock('12:00', '13:00') }]
              : []),
            ...(busyMask & 2
              ? [{ id: 'ub', memberId: 'b', date, ...clock('11:00', '12:00') }]
              : []),
          ];
          const h = Household.parse({
            ...base,
            routines: [],
            routineExceptions: [],
            dayAnswers,
            unavailable,
          });
          expect(validateHousehold(h)).toEqual([]);
          const oracle = householdCareKnowledge(h, date);
          if (!oracle) throw new Error('独立した根拠を読めない');
          const actual = careCoverage(h, date);
          const toEpoch = (rows: readonly { start: number; end: number }[]) =>
            rows.map(({ start, end }) => ({ start: midnight + start, end: midnight + end }));
          const label = `a=${aIndex},b=${bIndex},busy=${busyMask}`;
          expect(actual.certain, label).toEqual(toEpoch(oracle.certain));
          expect(actual.unsure, label).toEqual(toEpoch(union(oracle.missing)));
          expect(actual.missing, label).toEqual(oracle.missingAdults);
          count++;
        }
      }
    }
    expect(count).toBe(256);
  });
});
