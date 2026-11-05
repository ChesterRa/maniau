import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { modeledCareGaps } from '../src/child-care-gap-evidence';
import { coveredBy } from '../src/time';
import { household } from './fixtures';

const date = '2026-12-07';
const day = (memberId: string, segments: object[]) => ({ memberId, date, segments });
const home = (start: string, end: string) => ({ start, end, kind: 'home', placeId: 'home' });
const away = (start: string, end: string) => ({ start, end, kind: 'work' });
const base = household();
const at = (h: number, m = 0) => h * 60 + m;

describe('記録から計算する子の居場所の空き', () => {
  it('長さの違う二つの空きと、端が接する区間をそのまま残す', () => {
    const h = Household.parse({
      ...base,
      routineExceptions: [
        day('a', [away('09:00', '12:00'), away('15:00', '18:00')]),
        day('b', [away('09:00', '10:00'), home('10:00', '15:00'), away('15:00', '17:00')]),
      ],
    });
    expect(modeledCareGaps(h, date)).toEqual({
      gaps: [
        { start: at(9), end: at(10) },
        { start: at(15), end: at(17) },
      ],
      complete: true,
    });
  });

  it('一人の記録が無い時、残る人の外の時間を計算するが、現実の不在とは呼ばない', () => {
    const h = Household.parse({
      ...base,
      routines: base.routines.filter((entry) => entry.memberId !== 'b'),
      routineExceptions: [day('a', [away('09:00', '10:00'), away('15:00', '17:00')])],
    });
    expect(modeledCareGaps(h, date)).toEqual({
      gaps: [
        { start: at(9), end: at(10) },
        { start: at(15), end: at(17) },
      ],
      complete: true,
    });
  });

  it('日程の無い人に占用を足しても、もう一人の予定から求めた空きを縮めない', () => {
    const h = Household.parse({
      ...base,
      routines: base.routines.filter((entry) => entry.memberId !== 'a'),
      routineExceptions: [day('b', [away('09:00', '12:00')])],
    });
    const occupied = [{ id: 'u1', memberId: 'a', date, start: '09:00', end: '10:00' }];
    expect(modeledCareGaps(h, date, occupied)).toEqual(modeledCareGaps(h, date));
    expect(modeledCareGaps(h, date, occupied).gaps).toEqual([{ start: at(9), end: at(12) }]);
  });

  it('両方に日程が無い時は、明示の占用の和集合だけを計算上の空きとする', () => {
    const h = Household.parse({ ...base, routines: [], routineExceptions: [] });
    const occupied = [
      { id: 'u1', memberId: 'a', date, start: '09:00', end: '10:00' },
      { id: 'u2', memberId: 'b', date, start: '10:00', end: '11:00' },
    ];
    expect(modeledCareGaps(h, date)).toEqual({ gaps: [], complete: true });
    expect(modeledCareGaps(h, date, occupied)).toEqual({
      gaps: [{ start: at(9), end: at(11) }],
      complete: true,
    });
  });

  it('家にいる二人の明示の占用が重なる時だけ、見守れない時間に足す', () => {
    const h = Household.parse({
      ...base,
      routineExceptions: [day('a', [home('09:00', '12:00')]), day('b', [home('09:00', '12:00')])],
    });
    const occupied = [
      { id: 'u1', memberId: 'a', date, start: '09:00', end: '10:00' },
      { id: 'u2', memberId: 'b', date, start: '09:30', end: '10:30' },
    ];
    expect(modeledCareGaps(h, date, occupied).gaps).toEqual([{ start: at(9, 30), end: at(10) }]);
  });

  it('照らす日の不正な占用があれば、完全な根拠としない', () => {
    const h = Household.parse({ ...base, routineExceptions: [day('a', [home('09:00', '12:00')])] });
    expect(
      modeledCareGaps(h, date, [{ id: 'u', memberId: 'a', date, start: '09:99', end: '10:00' }])
        .complete,
    ).toBe(false);
  });

  it('明示の占用を足しただけで、前の計算上の空きを縮めない', () => {
    const states = ['home', 'away', 'unknown'] as const;
    type State = (typeof states)[number];
    const segments = (first: State, second: State) =>
      (
        [
          [first, '09:00', '10:00'],
          [second, '10:00', '11:00'],
        ] as const
      ).flatMap(([state, start, end]) => {
        if (state === 'unknown') return [];
        return [state === 'home' ? home(start, end) : away(start, end)];
      });
    let checked = 0;
    for (const a1 of states)
      for (const a2 of states)
        for (const b1 of states)
          for (const b2 of states) {
            const h = Household.parse({
              ...base,
              routineExceptions: [],
              routines: [
                { memberId: 'a', weekday: 1, segments: segments(a1, a2) },
                { memberId: 'b', weekday: 1, segments: segments(b1, b2) },
              ],
            });
            const before = modeledCareGaps(h, date);
            for (let mask = 0; mask < 4; mask += 1) {
              const busy = ['a', 'b'].flatMap((memberId, index) =>
                mask & (1 << index)
                  ? [{ id: `u-${memberId}`, memberId, date, start: '09:00', end: '10:00' }]
                  : [],
              );
              const after = modeledCareGaps(h, date, busy);
              expect(before.complete && after.complete).toBe(true);
              for (const gap of before.gaps)
                expect(coveredBy(gap.start, gap.end, after.gaps)).toBe(true);
              checked += 1;
            }
          }
    expect(checked).toBe(324);
  });

  it('一日だけの例外が週間の記録より優先し、成人以外と無効の成人を数えない', () => {
    const h = Household.parse({
      ...base,
      members: [
        ...base.members.filter((m) => m.id !== 'b'),
        ...base.members.filter((m) => m.id === 'b').map((m) => ({ ...m, active: false })),
      ],
      routineExceptions: [day('a', [away('09:00', '10:00')])],
    });
    expect(modeledCareGaps(h, date)).toEqual({
      gaps: [{ start: at(9), end: at(10) }],
      complete: true,
    });
  });

  it('日程の重複・重なる区間・成人無しは完全な根拠としない', () => {
    const duplicateDay = Household.parse({
      ...base,
      routineExceptions: [day('a', [away('09:00', '10:00')]), day('a', [away('09:00', '10:00')])],
    });
    const overlapping = Household.parse({
      ...base,
      routineExceptions: [day('a', [away('09:00', '11:00'), home('10:00', '12:00')])],
    });
    const noAdults = Household.parse({
      ...base,
      members: base.members.filter((m) => m.kind !== 'adult'),
    });
    for (const h of [duplicateDay, overlapping, noAdults])
      expect(modeledCareGaps(h, date).complete).toBe(false);
  });

  it('二人の記録の全組合せを、一分ごとの独立した数え方で照らす', () => {
    const schedules = [
      null,
      ['home', 'home'],
      ['home', 'work'],
      ['work', 'home'],
      ['work', 'work'],
    ] as const;
    for (const a of schedules) {
      for (const b of schedules) {
        const makeDay = (id: string, schedule: typeof a) =>
          schedule === null
            ? []
            : [
                day(
                  id,
                  schedule.map((kind, i) =>
                    (kind === 'home' ? home : away)(
                      i === 0 ? '09:00' : '10:00',
                      i === 0 ? '10:00' : '11:00',
                    ),
                  ),
                ),
              ];
        const h = Household.parse({
          ...base,
          routines: base.routines.filter((entry) => !['a', 'b'].includes(entry.memberId)),
          routineExceptions: [...makeDay('a', a), ...makeDay('b', b)],
        });
        const expected: number[] = [];
        for (let minute = at(9); minute < at(11); minute += 1) {
          const slot = minute < at(10) ? 0 : 1;
          const states = [a, b].map((entry) => entry?.[slot] ?? 'unknown');
          if (!states.includes('home') && states.includes('work')) expected.push(minute);
        }
        const actual = modeledCareGaps(h, date);
        expect(actual.complete).toBe(true);
        const actualMinutes = actual.gaps.flatMap((range) =>
          Array.from({ length: range.end - range.start }, (_, i) => range.start + i),
        );
        expect(actualMinutes).toEqual(expected);
      }
    }
  });
});
