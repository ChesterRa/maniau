import type { MapInputs } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

function materials() {
  const family = household();
  const home = family.places.find((place) => place.id === 'home');
  const store = family.places.find((place) => place.id === 'store');
  const station = family.places.find((place) => place.id === 'station');
  if (!home || !store || !station) throw new Error('家庭の材料がない');
  station.googlePlaceId = 'google-station';
  store.googlePlaceId = 'google-store';
  home.nearStationId = 'station';
  home.walkFromStationMin = 10;
  // 地図を使う作業に、家庭の別の営業時間を誤って当てないことも確かめる。
  store.hours = { source: 'family', periods: [], closedDates: [] };
  family.routines = family.routines.map((routine) => ({
    ...routine,
    segments: [
      {
        start: '00:00',
        end: '23:59',
        kind: 'away' as const,
        placeId: 'station',
        viaStationIds: [],
      },
    ],
  }));
  const evidence = {
    storeId: 'store',
    googlePlaceId: 'google-store',
    stationId: 'station',
    stationGooglePlaceId: 'google-station',
    walkFromStationMin: 7,
    walkToStationMin: 12,
    current: {
      timeZone: 'Asia/Tokyo',
      validFrom: '2026-11-26',
      validTo: '2026-12-03',
      periods: [{ date: '2026-11-26', open: '12:00', close: '13:00' }],
    },
    regular: {
      timeZone: 'Asia/Tokyo',
      periods: [{ weekday: 4, open: '12:00', close: '13:00' }],
    },
  };
  const maps: MapInputs = { checkedAt: '2026-11-26T08:00+09:00', stores: [evidence] };
  const shopping = task('shop', {
    start: '2026-11-26T12:15+09:00',
    end: '2026-11-26T12:35+09:00',
    durationMin: 20,
    segments: ['away'],
    atPlaceId: 'store',
    placeKind: 'store',
    travelBeforeMin: 7,
    travelAfterMin: 12,
    travelSource: 'maps',
    hoursBasis: 'mapsCurrent',
  });
  return { family, maps, shopping, evidence };
}

function verify(m: ReturnType<typeof materials>, shopping: Record<string, unknown> = m.shopping) {
  return verifyPlan({
    household: m.family,
    plan: plan({ now: '2026-11-26T08:00+09:00', tasks: [shopping], mapInputs: m.maps }),
    events: [],
  }).issues;
}

const codes = (issues: ReturnType<typeof verify>) => issues.map((issue) => issue.code);

describe('地図の根拠を家庭の情報とは別に照らす', () => {
  it('家庭の正本と事象は照合したまま、別の入力として地図の根拠を使う', () => {
    const m = materials();
    const recorded = structuredClone(m.family);
    const events = [
      event(1, {
        type: 'householdSet',
        household: recorded,
        occurredAt: '2026-11-26T07:55+09:00',
        recordedAt: '2026-11-26T07:55+09:00',
      }),
    ];
    const input = {
      household: m.family,
      plan: plan({
        now: '2026-11-26T08:00+09:00',
        throughSeq: 1,
        tasks: [m.shopping],
        mapInputs: m.maps,
      }),
      events,
    };
    expect(codes(verifyPlan(input).issues)).not.toContain('household_snapshot_mismatch');
    const other = structuredClone(m.family);
    const store = other.places.find((place) => place.id === 'store');
    if (!store?.hours) throw new Error('店がない');
    store.hours.closedDates.push('2026-11-26');
    expect(codes(verifyPlan({ ...input, household: other }).issues)).toContain(
      'household_snapshot_mismatch',
    );
  });

  it('店と駅の両方が合い、二方向と当日の営業時間に収まる', () => {
    const issues = verify(materials());
    expect(codes(issues)).not.toEqual(
      expect.arrayContaining([
        'route_evidence_missing',
        'route_time_mismatch',
        'opening_hours_evidence_missing',
        'outside_opening_hours',
      ]),
    );
  });

  it('店や駅の ID が一つでも違う・同じ店の根拠が重複した時は確認済みとしない', () => {
    for (const change of [
      { googlePlaceId: 'other-store' },
      { stationId: 'other-station' },
      { stationGooglePlaceId: 'other-google-station' },
    ]) {
      const m = materials();
      Object.assign(m.evidence, change);
      const issues = verify(m);
      expect(codes(issues)).toContain('route_evidence_missing');
      expect(codes(issues)).toContain('opening_hours_evidence_missing');
      expect(codes(issues)).not.toContain('outside_opening_hours');
    }
    const m = materials();
    m.maps.stores.push(structuredClone(m.evidence));
    expect(codes(verify(m))).toContain('route_evidence_missing');
  });

  it('帰りの徒歩を行きと取り違えると違反にする', () => {
    const m = materials();
    const issues = verify(m, { ...m.shopping, travelAfterMin: 7 });
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'route_time_mismatch' }),
    );
  });

  it('当日の営業時間が明示的に空なら閉まっているが、返らなければ未判定', () => {
    const closed = materials();
    closed.evidence.current.periods = [];
    expect(verify(closed)).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'outside_opening_hours' }),
    );
    const missing = materials();
    missing.maps.stores[0] = { ...missing.evidence, current: undefined };
    const issues = verify(missing);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'opening_hours_evidence_missing' }),
    );
    expect(codes(issues)).not.toContain('outside_opening_hours');
  });

  it('照会の七日窓の終端・照会前・長すぎる窓は未判定にする', () => {
    const end = materials();
    const outside = {
      ...end.shopping,
      start: '2026-12-03T12:15+09:00',
      end: '2026-12-03T12:35+09:00',
    };
    expect(codes(verify(end, outside))).toContain('opening_hours_out_of_range');
    const before = materials();
    before.maps.checkedAt = '2026-11-26T12:30+09:00';
    expect(codes(verify(before))).toContain('opening_hours_out_of_range');
    const longer = materials();
    longer.evidence.current.validTo = '2026-12-04';
    expect(codes(verify(longer))).toContain('opening_hours_out_of_range');
    for (const issues of [verify(end, outside), verify(before), verify(longer)]) {
      expect(codes(issues)).not.toContain('outside_opening_hours');
    }
  });

  it('七日窓の終端ちょうどに終わる作業は、最後の日として照らす', () => {
    const m = materials();
    m.evidence.current.periods = [{ date: '2026-12-02', open: '23:40', close: '00:00' }];
    const atEnd = {
      ...m.shopping,
      start: '2026-12-02T23:50+09:00',
      end: '2026-12-03T00:00+09:00',
      durationMin: 10,
    };
    expect(codes(verify(m, atEnd))).not.toEqual(
      expect.arrayContaining(['opening_hours_out_of_range', 'outside_opening_hours']),
    );
  });

  it('ふだんの営業時間は、表に合う場合も合わない場合も当日を未判定にする', () => {
    const m = materials();
    const regular = { ...m.shopping, hoursBasis: 'mapsRegular' };
    expect(verify(m, regular)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'opening_hours_estimate' }),
    );
    m.evidence.regular.periods = [];
    const issues = verify(m, regular);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'opening_hours_estimate_mismatch' }),
    );
    expect(codes(issues)).not.toContain('outside_opening_hours');
  });

  it('日をまたぐ区間を使い、同時刻の開店・閉店は断定しない', () => {
    const m = materials();
    m.evidence.current.periods = [{ date: '2026-11-26', open: '22:00', close: '02:00' }];
    const overnight = {
      ...m.shopping,
      start: '2026-11-27T00:15+09:00',
      end: '2026-11-27T00:35+09:00',
    };
    expect(codes(verify(m, overnight))).not.toContain('outside_opening_hours');
    m.evidence.current.periods = [{ date: '2026-11-27', open: '00:00', close: '00:00' }];
    const issues = verify(m, overnight);
    expect(codes(issues)).toContain('opening_hours_ambiguous');
    expect(codes(issues)).not.toContain('outside_opening_hours');
  });

  it('不正な時区では例外にせず、営業時間を未判定にする', () => {
    const m = materials();
    m.evidence.current.timeZone = 'not/a-timezone';
    expect(verify(m)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'opening_hours_timezone_invalid' }),
    );
  });
});

describe('帰り道の地図の根拠', () => {
  it('異なる往路・復路から到店と到家を独立に計算する', () => {
    const m = materials();
    const thursday = m.family.routines.find((r) => r.memberId === 'a' && r.weekday === 4);
    if (!thursday) throw new Error('作息がない');
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
    m.evidence.current.periods = [{ date: '2026-11-26', open: '18:00', close: '21:00' }];
    const detour = {
      ...m.shopping,
      start: '2026-11-26T18:57+09:00',
      end: '2026-11-26T19:12+09:00',
      durationMin: 15,
      segments: ['commute'],
      detour: {
        plannedArrival: '2026-11-26T19:00+09:00',
        delayedArrival: '2026-11-26T19:34+09:00',
      },
    };
    const issues = verify(m, detour);
    expect(codes(issues)).not.toEqual(
      expect.arrayContaining([
        'detour_walk_mismatch',
        'detour_time_mismatch',
        'route_evidence_missing',
      ]),
    );
    const wrongReturn = {
      ...detour,
      detour: { ...detour.detour, delayedArrival: '2026-11-26T19:29+09:00' },
    };
    expect(codes(verify(m, wrongReturn))).toContain('detour_time_mismatch');
  });
});
