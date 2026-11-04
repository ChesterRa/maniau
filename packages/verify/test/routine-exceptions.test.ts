// 検証器が、ふだんの曜日ではなく対象日の例外を使うことを、手書きの予定で確かめる。
import { Household, type OptionPlan } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { checkNoSlot } from '../src/no-slot';
import { Collector } from '../src/report';
import { household, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);
const away = [{ start: '08:00', end: '22:00', kind: 'away', placeId: 'station' }];
const home = [{ start: '08:00', end: '22:00', kind: 'home', placeId: 'home' }];

function changedDay(memberId: string, date: string, segments: typeof home) {
  return { memberId, date, segments };
}

function checkTask(family: ReturnType<typeof household>, date: string, memberId = 'a') {
  return codes(
    verifyPlan({
      household: family,
      plan: plan({
        tasks: [
          task('at-home', {
            assigneeId: memberId,
            start: `${date}T10:00+09:00`,
            end: `${date}T10:30+09:00`,
          }),
        ],
      }),
      events: [],
    }),
  );
}

function commuteFamily() {
  const family = household();
  const homePlace = family.places.find((place) => place.id === 'home');
  const store = family.places.find((place) => place.id === 'store');
  const day = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 4);
  if (!homePlace || !store?.hours || !day) throw new Error('家庭の材料がない');
  homePlace.nearStationId = 'station';
  homePlace.walkFromStationMin = 10;
  const hours = store.hours.periods.find((entry) => entry.weekday === 4);
  if (!hours) throw new Error('営業時間がない');
  hours.open = '10:00';
  hours.close = '21:00';
  day.segments = [
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
  return family;
}

function checkDetour(family: ReturnType<typeof household>, date = '2026-11-26') {
  return codes(
    verifyPlan({
      household: family,
      events: [],
      plan: plan({
        tasks: [
          task('shop', {
            durationMin: 15,
            start: `${date}T18:55+09:00`,
            end: `${date}T19:10+09:00`,
            segments: ['commute'],
            atPlaceId: 'store',
            placeKind: 'store',
            goods: 'clothing',
            travelBeforeMin: 5,
            travelAfterMin: 5,
            travelSource: 'estimate',
            detour: {
              plannedArrival: `${date}T19:00+09:00`,
              delayedArrival: `${date}T19:25+09:00`,
            },
          }),
        ],
      }),
    }),
  );
}

describe('その日だけの一日を独立に照らす', () => {
  it('例外の日だけ作業を許さず、翌週と別の人の同じ時刻にはふだんの週を使う', () => {
    const family = Household.parse({
      ...household(),
      routineExceptions: [changedDay('a', '2026-12-07', away)],
    });
    expect(checkTask(family, '2026-12-07')).toContain('outside_routine');
    expect(checkTask(family, '2026-12-14')).not.toContain('outside_routine');
    expect(checkTask(family, '2026-12-07', 'b')).not.toContain('outside_routine');
  });

  it('ふだん外にいる人がその日だけ家にいれば、作業をふだんの週で誤って外さない', () => {
    const family = household();
    const monday = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 1);
    if (!monday) throw new Error('月曜の区間がない');
    monday.segments = [
      { start: '08:00', end: '22:00', kind: 'away', placeId: 'station', viaStationIds: [] },
    ];
    const changed = Household.parse({
      ...family,
      routineExceptions: [changedDay('a', '2026-12-07', home)],
    });
    expect(checkTask(changed, '2026-12-07')).not.toContain('outside_routine');
    expect(checkTask(changed, '2026-12-14')).toContain('outside_routine');
  });

  it('担当の例外に帰宅の通勤がなければ、寄り道の元の到家を確認できない', () => {
    const family = Household.parse({
      ...commuteFamily(),
      routineExceptions: [changedDay('a', '2026-11-26', home)],
    });
    expect(checkDetour(family)).toContain('detour_commute_missing');
    expect(checkDetour(family, '2026-12-03')).not.toContain('detour_commute_missing');
  });

  it('別の大人の例外が外出なら、遅れた到家まで家にいると見なさない', () => {
    const family = Household.parse({
      ...commuteFamily(),
      routineExceptions: [changedDay('b', '2026-11-26', away)],
    });
    expect(checkDetour(family)).toContain('detour_other_adult_absent');
    expect(checkDetour(family, '2026-12-03')).not.toContain('detour_other_adult_absent');
  });

  it('相接する家と職場の区間の間に移動がなければ、場所のつながりを未判定とする', () => {
    const original = household();
    const family = Household.parse({
      ...original,
      places: [...original.places, { id: 'office', kind: 'workplace', name: '職場' }],
      routineExceptions: [
        changedDay('a', '2026-12-07', [
          { start: '08:00', end: '09:00', kind: 'work', placeId: 'office' },
          { start: '09:00', end: '17:00', kind: 'home', placeId: 'home' },
          { start: '17:00', end: '18:00', kind: 'work', placeId: 'office' },
        ]),
      ],
    });
    const report = verifyPlan({ household: family, plan: plan(), events: [] });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'routine_transition_unverified' }),
    );
  });

  it('家・通勤・到着地がつながる一日は許し、場所不明の外出はつながると決めない', () => {
    const valid = Household.parse({
      ...household(),
      routineExceptions: [
        {
          memberId: 'a',
          date: '2026-12-07',
          segments: [
            { start: '08:00', end: '08:30', kind: 'home', placeId: 'home' },
            { start: '08:30', end: '09:00', kind: 'commute', fromId: 'home', toId: 'station' },
            { start: '09:00', end: '10:00', kind: 'away', placeId: 'station' },
          ],
        },
      ],
    });
    expect(codes(verifyPlan({ household: valid, plan: plan(), events: [] }))).not.toContain(
      'routine_transition_unverified',
    );
    const unknown = structuredClone(valid);
    delete unknown.routineExceptions[0]?.segments[2]?.placeId;
    expect(codes(verifyPlan({ household: unknown, plan: plan(), events: [] }))).toContain(
      'routine_transition_unverified',
    );
  });

  it('同じ曜日のふだんの一日から、そのまま写した場所の境界は新たな未判定にしない', () => {
    const family = household();
    const ordinary = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 1);
    if (!ordinary) throw new Error('月曜の区間がない');
    family.routineExceptions = [
      { memberId: 'a', date: '2026-12-07', segments: structuredClone(ordinary.segments) },
    ];
    expect(codes(verifyPlan({ household: family, plan: plan(), events: [] }))).not.toContain(
      'routine_transition_unverified',
    );
    const previous = family.routineExceptions[0]?.segments[1];
    const next = family.routineExceptions[0]?.segments[2];
    if (!previous || !next) throw new Error('外出の区間がない');
    previous.end = '13:30';
    next.start = '13:30';
    expect(codes(verifyPlan({ household: family, plan: plan(), events: [] }))).toContain(
      'routine_transition_unverified',
    );
  });

  it('一日を家にいて他の作業もない大人がいる時だけ、手配が無い理由を確認できる', () => {
    const family = Household.parse({
      ...household(),
      routineExceptions: [changedDay('a', '2026-12-07', home)],
    });
    const check = (tasks: Record<string, unknown>[], date: string | undefined = '2026-12-07') =>
      codes(
        verifyPlan({
          household: family,
          events: [],
          plan: plan({ requirements: [requirement({ date })], tasks }),
        }),
      );
    expect(check([])).not.toContain('required_arrangement_missing');
    expect(check([], '2026-12-14')).toContain('required_arrangement_missing');
    expect(
      check([
        task('away', {
          segments: ['away'],
          placeId: 'station',
          start: '2026-12-07T12:00+09:00',
          end: '2026-12-07T12:30+09:00',
        }),
      ]),
    ).toContain('required_arrangement_missing');
    expect(check([task('unscheduled', { start: undefined, end: undefined })])).toContain(
      'required_arrangement_missing',
    );
    expect(
      check([
        task('other-day', {
          start: '2026-12-08T10:00+09:00',
          end: '2026-12-08T10:30+09:00',
        }),
      ]),
    ).not.toContain('required_arrangement_missing');
  });

  it('二週間の両方の同じ曜日を例外が置き換えうる時、週の区間だけで noSlot を違反としない', () => {
    const family = Household.parse({
      ...household(),
      routines: [
        { memberId: 'a', weekday: 1, segments: home },
        { memberId: 'b', weekday: 1, segments: away },
      ],
      routineExceptions: [changedDay('a', '2026-12-07', away), changedDay('a', '2026-12-14', away)],
      ways: [
        {
          id: 'way',
          name: '架空の方法',
          steps: [{ id: 's', name: '準備', durationMin: 10, segments: ['home'] }],
          cost: {},
        },
      ],
    });
    const way = family.ways[0];
    if (!way) throw new Error('やり方がない');
    const option = {
      key: 'option',
      noSlot: true,
      deadlineCertainty: 'undetermined',
    } as OptionPlan;
    const result = new Collector();
    checkNoSlot(family, option, way, undefined, result);
    expect(result.issues.map((issue) => issue.code)).toContain('no_slot_unverified');
    expect(result.issues.map((issue) => issue.code)).not.toContain('no_slot_mismatch');

    family.routineExceptions.pop();
    const one = new Collector();
    checkNoSlot(family, option, way, undefined, one);
    expect(one.issues.map((issue) => issue.code)).toContain('no_slot_mismatch');
  });

  it('ふだんの週になくても、例外に置ける区間があれば未判定とする', () => {
    const family = Household.parse({
      ...household(),
      routines: [{ memberId: 'a', weekday: 1, segments: away }],
      routineExceptions: [changedDay('a', '2026-12-07', home)],
      ways: [
        {
          id: 'way',
          name: '架空の方法',
          steps: [{ id: 's', name: '準備', durationMin: 10, segments: ['home'] }],
          cost: {},
        },
      ],
    });
    const way = family.ways[0];
    if (!way) throw new Error('やり方がない');
    const result = new Collector();
    checkNoSlot(
      family,
      { key: 'option', noSlot: true, deadlineCertainty: 'undetermined' } as OptionPlan,
      way,
      undefined,
      result,
    );
    expect(result.issues.map((issue) => issue.code)).toContain('no_slot_unverified');
  });
});
