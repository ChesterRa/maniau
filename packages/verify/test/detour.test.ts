import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);

function commuteHousehold() {
  const family = household();
  const home = family.places.find((entry) => entry.id === 'home');
  const store = family.places.find((entry) => entry.id === 'store');
  const thursday = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 4);
  if (!home || !store?.hours || !thursday) throw new Error('家庭の材料がない');
  home.nearStationId = 'station';
  home.walkFromStationMin = 10;
  const period = store.hours.periods.find((entry) => entry.weekday === 4);
  if (!period) throw new Error('営業時間がない');
  period.open = '10:00';
  period.close = '21:00';
  thursday.segments = [
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

function detour(overrides: Record<string, unknown> = {}) {
  return task('shop', {
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
    detour: { plannedArrival: '2026-11-26T19:00+09:00', delayedArrival: '2026-11-26T19:25+09:00' },
    ...overrides,
  });
}

describe('帰り道の寄り道', () => {
  it('元の到家から到駅を逆算し、遅れた到家までを照らす', () => {
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ tasks: [detour()] }),
      events: [],
    });
    expect(codes(report)).not.toEqual(
      expect.arrayContaining(['outside_routine', 'detour_time_mismatch', 'detour_commute_missing']),
    );
    expect(codes(report)).toContain('detour_home_flexibility_unverified');
    expect(codes(report)).toContain('route_is_estimate');
  });

  it('駅から家への最後の10分も人の占有として重なりを見つける', () => {
    const another = task('other', {
      durationMin: 5,
      start: '2026-11-26T19:18+09:00',
      end: '2026-11-26T19:23+09:00',
    });
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ tasks: [detour(), another] }),
      events: [],
    });
    expect(codes(report)).toContain('task_overlap');
  });

  it('帰りの駅と店の駅が違えば検出する', () => {
    const family = commuteHousehold();
    const store = family.places.find((entry) => entry.id === 'store');
    if (!store) throw new Error('店がない');
    store.nearStationId = 'different-station';
    const report = verifyPlan({ household: family, plan: plan({ tasks: [detour()] }), events: [] });
    expect(codes(report)).toContain('detour_station_mismatch');
  });

  it('帰宅の直後がお迎えなら遅らせない', () => {
    const family = commuteHousehold();
    const day = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 4);
    if (!day?.segments[1]) throw new Error('区間がない');
    day.segments[1] = { ...day.segments[1], kind: 'pickup' };
    const report = verifyPlan({ household: family, plan: plan({ tasks: [detour()] }), events: [] });
    expect(codes(report)).toContain('detour_fixed_commitment');
  });

  it('家への徒歩が不明なら、帰れると断定しない', () => {
    const family = commuteHousehold();
    const home = family.places.find((entry) => entry.id === 'home');
    if (!home) throw new Error('家がない');
    delete home.walkFromStationMin;
    const report = verifyPlan({ household: family, plan: plan({ tasks: [detour()] }), events: [] });
    expect(codes(report)).toContain('detour_route_missing');
    expect(codes(report)).not.toContain('outside_routine');
  });

  it('到駅が通勤開始より前になる歩行時間を受け付けない', () => {
    const family = commuteHousehold();
    const home = family.places.find((entry) => entry.id === 'home');
    if (!home) throw new Error('家がない');
    home.walkFromStationMin = 35;
    const early = detour({ start: '2026-11-26T18:30+09:00', end: '2026-11-26T18:45+09:00' });
    const report = verifyPlan({ household: family, plan: plan({ tasks: [early] }), events: [] });
    expect(codes(report)).toContain('detour_station_before_commute');
  });

  it('他の大人も同じ時間に寄り道するなら、家にいると見なさない', () => {
    const family = commuteHousehold();
    const first = family.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 4);
    const second = family.routines.find((entry) => entry.memberId === 'b' && entry.weekday === 4);
    if (!first || !second) throw new Error('区間がない');
    second.segments = structuredClone(first.segments);
    const a = detour({ commitment: 'accepted' });
    const b = { ...detour({ commitment: 'accepted', assigneeId: 'b' }), key: 'b-shop' };
    const report = verifyPlan({ household: family, plan: plan({ tasks: [a, b] }), events: [] });
    expect(codes(report)).toContain('detour_other_adult_absent');
  });

  it('他の大人の作業場所が不明なら、不在と断定せず未判定にする', () => {
    const other = task('other', {
      assigneeId: 'b',
      commitment: 'accepted',
      durationMin: 10,
      start: '2026-11-26T19:05+09:00',
      end: '2026-11-26T19:15+09:00',
      segments: ['home', 'commute'],
    });
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ tasks: [detour(), other] }),
      events: [],
    });
    expect(codes(report)).toContain('detour_other_adult_unverified');
    expect(codes(report)).not.toContain('detour_other_adult_absent');
  });

  it('他の大人の作息が未登録なら、不在と断定せず未判定にする', () => {
    const family = commuteHousehold();
    family.routines = family.routines.filter(
      (entry) => entry.memberId !== 'b' || entry.weekday !== 4,
    );
    const report = verifyPlan({ household: family, plan: plan({ tasks: [detour()] }), events: [] });
    expect(codes(report)).toContain('detour_other_adult_unverified');
    expect(codes(report)).not.toContain('detour_other_adult_absent');
  });

  it('他の大人の引き受けた外出の時刻が未定なら、在宅を確認済みとしない', () => {
    const other = task('other', {
      assigneeId: 'b',
      commitment: 'accepted',
      start: undefined,
      end: undefined,
      placeId: 'store',
      segments: ['away'],
    });
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ tasks: [detour(), other] }),
      events: [],
    });
    expect(codes(report)).toContain('detour_other_adult_unverified');
    expect(codes(report)).not.toContain('detour_other_adult_absent');
  });

  it('他の大人が同じ時間に勤務していると分かる場合は、家にいないと判定する', () => {
    const family = commuteHousehold();
    const day = family.routines.find((entry) => entry.memberId === 'b' && entry.weekday === 4);
    if (!day) throw new Error('区間がない');
    day.segments = [
      { start: '18:30', end: '20:00', kind: 'work', placeId: 'station', viaStationIds: [] },
    ];
    const report = verifyPlan({ household: family, plan: plan({ tasks: [detour()] }), events: [] });
    expect(codes(report)).toContain('detour_other_adult_absent');
  });

  it('担当が同じ時刻と到家を見て引き受けた時だけ、時刻の未確認を外す', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 'shop', assigneeId: 'a' }),
      event(2, {
        type: 'commitmentChanged',
        taskKey: 'shop',
        assigneeId: 'a',
        action: 'accept',
        shown: {
          start: '2026-11-26T18:55+09:00',
          end: '2026-11-26T19:10+09:00',
          delayedArrival: '2026-11-26T19:25+09:00',
        },
      }),
    ];
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ throughSeq: 2, tasks: [detour({ commitment: 'accepted' })] }),
      events,
    });
    expect(codes(report)).not.toContain('detour_home_flexibility_unverified');
    expect(codes(report)).toContain('route_is_estimate');
  });

  it('引き受け後に到家が変わったら、以前の確認を使わない', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 'shop', assigneeId: 'a' }),
      event(2, {
        type: 'commitmentChanged',
        taskKey: 'shop',
        assigneeId: 'a',
        action: 'accept',
        shown: {
          start: '2026-11-26T18:55+09:00',
          end: '2026-11-26T19:10+09:00',
          delayedArrival: '2026-11-26T19:20+09:00',
        },
      }),
    ];
    const report = verifyPlan({
      household: commuteHousehold(),
      plan: plan({ throughSeq: 2, tasks: [detour({ commitment: 'accepted' })] }),
      events,
    });
    expect(codes(report)).toContain('detour_home_flexibility_unverified');
  });
});
