import { expect, it } from 'vitest';
import { Household, zonedToEpochMinutes } from '../src';
import { purchaseOpportunities } from '../src/engine';
import { household } from './fixtures/demo';

// 架空の外出は 13:00–16:00、店まで往復 5 分ずつ、買う時間は 15 分。
// 期待時刻は、この 25 分と各占用の半開区間から先に求めてある。
it.each([
  ['占用なし', [], '13:05'],
  ['前半が塞がる', [['13:00', '13:30']], '13:35'],
  ['途中から塞がる', [['13:10', '13:30']], '13:35'],
  ['戻る時刻と占用の端が接する', [['13:25', '13:30']], '13:05'],
  [
    '短い隙間の次を使う',
    [
      ['13:10', '13:30'],
      ['13:40', '14:00'],
    ],
    '14:05',
  ],
  ['往復が外出の終わりにぴったり収まる', [['13:00', '15:35']], '15:40'],
  ['最後に 25 分は残らない', [['13:00', '15:36']], undefined],
] as const)('%s', (_label, windows, expected) => {
  const date = '2026-11-26';
  const time = (t: string) => zonedToEpochMinutes(date, t, 'Asia/Tokyo');
  const h = Household.parse({
    ...household,
    members: household.members.map((m) => (m.id === 'b' ? { ...m, active: false } : m)),
    routineExceptions: [
      {
        memberId: 'a',
        date,
        segments: [{ start: '13:00', end: '16:00', kind: 'away', placeId: 'st-toyosu' }],
      },
    ],
    unavailable: windows.map(([start, end], index) => ({
      id: `u-${index}`,
      memberId: 'a',
      date,
      start,
      end,
    })),
  });
  const store = h.places.find((p) => p.id === 'store-clothing-toyosu');
  if (!store) throw new Error('架空の店が無い');
  const options = purchaseOpportunities(
    h,
    'kidsClothing',
    15,
    time('12:00'),
    time('17:00'),
    undefined,
    [store],
  );
  expect(options[0]?.start).toBe(expected === undefined ? undefined : time(expected));
  for (const option of options) {
    expect(option.start - option.travelBeforeMin).toBeGreaterThanOrEqual(time('13:00'));
    expect(option.end + option.travelAfterMin).toBeLessThanOrEqual(time('16:00'));
    for (const [start, end] of windows) {
      expect(
        option.start - option.travelBeforeMin < time(end) &&
          time(start) < option.end + option.travelAfterMin,
      ).toBe(false);
    }
  }
});
