// 地図の根拠（MapInputs）で、寄り道の道のりと営業時間を置く試験（02-foundation §2.3）。
// 地図の応答は手で作った架空の物で、Google の本物の応答は使わない。
import { describe, expect, it } from 'vitest';
import { Household, type MapInputs, PlanResult, zonedToEpochMinutes } from '../src';
import { computePlan, searchPurchase } from '../src/engine';
import { EventLog, extraction1, household, notice1 } from './fixtures/demo';

const at = (date: string, time: string) => zonedToEpochMinutes(date, time, 'Asia/Tokyo');

/** デモの家庭の豊洲駅と衣料品店に、架空の place ID を付けた物。 */
const linked = Household.parse({
  ...household,
  places: household.places.map((p) =>
    p.id === 'st-toyosu'
      ? { ...p, googlePlaceId: 'g-station' }
      : p.id === 'store-clothing-toyosu'
        ? { ...p, googlePlaceId: 'g-store' }
        : p,
  ),
});

const everyDay = (open: string, close: string) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open, close }));

type Store = MapInputs['stores'][number];
const maps = (over: Partial<Store> = {}): MapInputs => ({
  checkedAt: '2026-11-04T21:00+09:00',
  stores: [
    {
      storeId: 'store-clothing-toyosu',
      googlePlaceId: 'g-store',
      stationId: 'st-toyosu',
      stationGooglePlaceId: 'g-station',
      walkFromStationMin: 9,
      walkToStationMin: 11,
      regular: { timeZone: 'Asia/Tokyo', periods: everyDay('10:00', '21:00') },
      ...over,
    },
  ],
});

/** 11/26（木）の健太の帰り道の機会。 */
const thursday = (h: Household, m?: MapInputs) => {
  const search = searchPurchase(
    h,
    'kidsClothing',
    15,
    at('2026-11-26', '00:00'),
    at('2026-11-26', '23:59'),
    m,
  );
  return {
    ...search,
    opportunities: search.opportunities.filter(
      (o) => o.memberId === 'a' && o.slotKind === 'commute',
    ),
  };
};

describe('地図の根拠が店と駅に結び付く時', () => {
  it('駅 → 店と店 → 駅の徒歩を別々に使い、出どころを maps にする', () => {
    // 家に着く 19:00、家は駅から 10 分 → 駅に 18:50。店へ 9 分で 18:59、買って 15 分、駅へ 11 分。
    expect(thursday(linked, maps()).opportunities[0]).toMatchObject({
      storeId: 'store-clothing-toyosu',
      start: at('2026-11-26', '18:59'),
      end: at('2026-11-26', '19:14'),
      travelBeforeMin: 9,
      travelAfterMin: 11,
      detour: {
        plannedArrival: at('2026-11-26', '19:00'),
        delayedArrival: at('2026-11-26', '19:35'),
      },
      travelSource: 'maps',
      // 照会の日から数日の外なので、ふだんの営業時間（目安）で置いた。
      hoursBasis: 'mapsRegular',
    });
  });

  it('照会の日から数日の内なら、その日の営業時間で確かめる（区間が無ければ、その日は閉まっている）', () => {
    const open = maps({
      current: {
        timeZone: 'Asia/Tokyo',
        validFrom: '2026-11-23',
        validTo: '2026-11-30',
        periods: [{ date: '2026-11-26', open: '10:00', close: '21:00' }],
      },
    });
    expect(thursday(linked, open).opportunities[0]).toMatchObject({ hoursBasis: 'mapsCurrent' });

    const closed = maps({
      current: {
        timeZone: 'Asia/Tokyo',
        validFrom: '2026-11-23',
        validTo: '2026-11-30',
        periods: [{ date: '2026-11-27', open: '10:00', close: '21:00' }],
      },
    });
    const result = thursday(linked, closed);
    expect(result.opportunities).toEqual([]);
    // 確かな営業時間で閉まっている（確かめていないから落としたのではない）。
    expect(result.droppedUnconfirmed).toBe(false);
  });

  it('ふだんの営業時間の目安で閉まっている時は置かないが、確かめていない営業時間で落としたと示す', () => {
    const weekend = maps({
      regular: {
        timeZone: 'Asia/Tokyo',
        periods: [
          { weekday: 6, open: '10:00', close: '21:00' },
          { weekday: 7, open: '10:00', close: '21:00' },
        ],
      },
    });
    const result = thursday(linked, weekend);
    expect(result.opportunities).toEqual([]);
    expect(result.droppedUnconfirmed).toBe(true);
  });

  it('営業時間が返らなければ、家庭の情報の営業時間に戻る（道のりは地図のまま）', () => {
    const noHours = maps({ regular: undefined });
    expect(thursday(linked, noHours).opportunities[0]).toMatchObject({
      travelBeforeMin: 9,
      travelSource: 'maps',
      hoursBasis: 'family',
    });
  });
});

describe('地図の根拠が結び付かない時は、家庭の目安で置く', () => {
  it.each([
    ['別の店の place ID', { googlePlaceId: 'g-other' }],
    ['別の駅の place ID', { stationGooglePlaceId: 'g-elsewhere' }],
    ['別の駅', { stationId: 'st-yurakucho' }],
    ['別の店', { storeId: 'store-super-toyosu' }],
  ])('%s', (_, over) => {
    expect(thursday(linked, maps(over)).opportunities[0]).toMatchObject({
      travelBeforeMin: 5,
      travelAfterMin: 5,
      travelSource: 'estimate',
      hoursBasis: 'family',
    });
  });

  it('家庭の店に place ID が無ければ使わない', () => {
    expect(thursday(household, maps()).opportunities[0]).toMatchObject({
      travelSource: 'estimate',
    });
  });
});

describe('計画', () => {
  const log = () =>
    new EventLog()
      .add('householdSet', '2026-11-24T21:00+09:00', 'a', { household: linked })
      .add('noticeReceived', '2026-11-25T19:30+09:00', 'b', { source: notice1 })
      .add('modelOutputRecorded', '2026-11-25T19:30+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n1',
        sourceId: 'n1',
        output: extraction1,
      })
      .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' });
  const buyKey = 'task:opt:arr:purchase:i3:buy:buy';

  it('買い物の作業は地図の道のりで置き、使った根拠を計画に添えて返す', () => {
    const m = maps();
    const plan = PlanResult.parse(computePlan(log().events, '2026-11-25T19:40+09:00', m));
    expect(plan.mapInputs).toEqual(m);
    expect(plan.tasks.find((t) => t.key === buyKey)).toMatchObject({
      start: '2026-11-26T18:59+09:00',
      travelBeforeMin: 9,
      travelAfterMin: 11,
      travelSource: 'maps',
      hoursBasis: 'mapsRegular',
      detour: { delayedArrival: '2026-11-26T19:35+09:00' },
    });
  });

  it('地図が無ければ、今までどおり家庭の目安で置き、根拠を添えない', () => {
    const plan = computePlan(log().events, '2026-11-25T19:40+09:00');
    expect(plan.mapInputs).toBeUndefined();
    expect(plan.tasks.find((t) => t.key === buyKey)).toMatchObject({
      travelBeforeMin: 5,
      travelSource: 'estimate',
      hoursBasis: 'family',
    });
  });

  it('ふだんの営業時間の目安でしか置けない時は、買える時が過ぎたと言わず、まだ判断できないとする', () => {
    const closedWeekdays = maps({
      regular: { timeZone: 'Asia/Tokyo', periods: [{ weekday: 3, open: '03:00', close: '04:00' }] },
    });
    const plan = computePlan(log().events, '2026-11-25T19:40+09:00', closedWeekdays);
    const arrangement = plan.arrangements.find((a) => a.key === 'arr:purchase:i3');
    expect(arrangement?.status).toBe('undetermined');
    expect(arrangement?.reasons).toContainEqual({ code: 'inputMissing', refs: ['storeHours'] });
    expect(arrangement?.options[0]?.expired).toBe(false);
    expect(arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(false);
  });
});
