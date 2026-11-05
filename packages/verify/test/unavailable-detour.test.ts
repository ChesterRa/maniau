import type { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { checkDetour } from '../src/detour';
import { checkHistory } from '../src/history';
import { Collector } from '../src/report';
import { instantMinute } from '../src/time';
import { household, plan, task } from './fixtures';

function example(start: string, end: string, memberId = 'b') {
  const family = household();
  const home = family.places.find((p) => p.id === 'home');
  const store = family.places.find((p) => p.id === 'store');
  const routine = family.routines.find((r) => r.memberId === 'a' && r.weekday === 4);
  if (!home || !store?.hours || !routine) throw new Error('架空の家がない');
  home.nearStationId = 'station';
  home.walkFromStationMin = 10;
  routine.segments = [
    {
      start: '18:30',
      end: '19:00',
      kind: 'commute',
      fromId: 'station',
      toId: 'home',
      viaStationIds: ['station'],
    },
    { start: '19:00', end: '22:30', kind: 'home', placeId: 'home', viaStationIds: [] },
  ];
  const withBusy = {
    ...family,
    unavailable: [{ id: 'u', memberId, date: '2026-11-26', start, end }],
  } as Household;
  const value = plan({
    tasks: [
      task('shop', {
        durationMin: 15,
        start: '2026-11-26T18:55+09:00',
        end: '2026-11-26T19:10+09:00',
        segments: ['commute'],
        atPlaceId: 'store',
        placeKind: 'store',
        goods: 'clothing',
        travelBeforeMin: 5,
        travelAfterMin: 5,
        travelSource: 'estimate',
        detour: {
          plannedArrival: '2026-11-26T19:00+09:00',
          delayedArrival: '2026-11-26T19:25+09:00',
        },
      }),
    ],
  });
  const shop = value.tasks[0];
  if (!shop?.start || !shop.end) throw new Error('架空の作業がない');
  const history = checkHistory(withBusy, value, [], new Collector());
  const report = new Collector();
  checkDetour(
    withBusy,
    value,
    history,
    shop,
    instantMinute(shop.start),
    instantMinute(shop.end),
    report,
  );
  return report.issues.map((i) => i.code);
}

describe('寄り道中に家にいる別の大人と、明示の占用', () => {
  it('別の大人が在宅でも手が離せない時は、見守りの根拠にしない', () => {
    expect(example('19:05', '19:10')).toContain('detour_other_adult_unavailable');
  });
  it('端が接するだけ、または寄り道する本人の占用は別の大人の根拠を消さない', () => {
    expect(example('18:00', '19:00')).not.toContain('detour_other_adult_unavailable');
    expect(example('19:25', '19:40')).not.toContain('detour_other_adult_unavailable');
    expect(example('19:05', '19:10', 'a')).not.toContain('detour_other_adult_unavailable');
  });
});
