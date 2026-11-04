// 地図の口（Google の Places・Routes）の読み方と、デモの計画への繋ぎ（02-foundation §2.3）。
// 応答は手で作った架空の物で、Google の本物の応答は使わない。鍵も架空。
import { describe, expect, it } from 'vitest';
import { loadDemoData } from '../src/demo';
import { demoSessions } from '../src/demo-sessions';
import { googleMaps, type MapsClient, MapsError } from '../src/maps/google';
import { currentOf, mapInputsFor, regularOf } from '../src/maps/inputs';

const JST = 'Asia/Tokyo';
/** 2026-11-04 21:10 JST の分。 */
const NOW = Date.parse('2026-11-04T12:10:00Z');

describe('ふだんの営業時間（regularOf）', () => {
  it('省かれた 0（分・曜日）を 0 として読み、Google の曜日（0 が日曜）を家庭の曜日にする', () => {
    expect(regularOf([{ open: { day: 1, hour: 10 }, close: { day: 1, hour: 21 } }], JST)).toEqual({
      timeZone: JST,
      periods: [{ weekday: 1, open: '10:00', close: '21:00' }],
    });
    expect(
      regularOf([{ open: { hour: 9, minute: 30 }, close: { hour: 18 } }], JST)?.periods,
    ).toEqual([{ weekday: 7, open: '09:30', close: '18:00' }]);
  });

  it('日をまたぐ区間は、その日の終わりまでと次の日の始まりからに分ける', () => {
    expect(
      regularOf([{ open: { day: 5, hour: 22 }, close: { day: 6, hour: 2 } }], JST)?.periods,
    ).toEqual([
      { weekday: 5, open: '22:00', close: '23:59' },
      { weekday: 6, open: '00:00', close: '02:00' },
    ]);
  });

  it('いつも開いている書き方は毎日、読めない形は分からない（undefined）', () => {
    expect(regularOf([{ open: { day: 0, hour: 0, minute: 0 } }], JST)?.periods).toHaveLength(7);
    expect(
      regularOf([{ open: { day: 1, hour: 25 }, close: { day: 1, hour: 26 } }], JST),
    ).toBeUndefined();
    expect(
      regularOf([{ open: { day: 1, hour: 10 } }, { open: { day: 2, hour: 10 } }], JST),
    ).toBeUndefined();
  });
});

describe('照会の日から数日の営業時間（currentOf）', () => {
  const minutes = Math.floor(NOW / 60_000);
  const at = (day: number, hour: number) => ({
    day: 3,
    hour,
    date: { year: 2026, month: 11, day },
  });
  it('覆う日は照会の日から 7 日（含まない終わり）。外の日の区間は落とす', () => {
    const current = currentOf(
      [
        { open: at(4, 10), close: at(4, 21) },
        { open: at(12, 10), close: at(12, 21) },
      ],
      JST,
      minutes,
    );
    expect(current).toMatchObject({ validFrom: '2026-11-04', validTo: '2026-11-11' });
    expect(current?.periods).toEqual([{ date: '2026-11-04', open: '10:00', close: '21:00' }]);
  });

  it('日付の無い区間があれば、覆ったと言わない（undefined）', () => {
    expect(
      currentOf([{ open: { day: 3, hour: 10 }, close: { day: 3, hour: 21 } }], JST, minutes),
    ).toBeUndefined();
  });
});

/** 架空の地図の口：駅 → 店と店 → 駅の秒、店の営業時間。 */
function fakeMaps(
  over: Partial<{
    there: number;
    back: number | undefined;
    failHours: boolean;
    failWalk: boolean;
  }> = {},
): MapsClient & { calls: string[] } {
  const calls: string[] = [];
  const there = over.there ?? 510;
  const back = 'back' in over ? over.back : 630;
  return {
    calls,
    async place(placeId, want) {
      calls.push(`place:${want.hours ? 'hours' : 'summary'}`);
      if (want.hours && over.failHours) throw new MapsError('http');
      return {
        id: placeId,
        name: `架空の場所 ${placeId.slice(-4)}`,
        location: { latitude: 35.65, longitude: 139.79 },
        timeZone: JST,
        regular: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          open: { day, hour: 10 },
          close: { day, hour: 21 },
        })),
      };
    },
    async walkMatrix(origins, destinations) {
      calls.push('matrix');
      if (over.failWalk) throw new MapsError('rateLimited');
      const result = new Map<string, number>();
      for (const o of origins) {
        for (const d of destinations) {
          const toStore = o.startsWith('ChIJMR82');
          const seconds = toStore ? there : back;
          if (seconds !== undefined) result.set(`${o}>${d}`, seconds);
        }
      }
      return result;
    },
    async walkRoute() {
      calls.push('route');
      return { durationSec: 414, distanceM: 486, polyline: 'abc', warnings: [] };
    },
    async searchText() {
      return [];
    },
  };
}

describe('計算一回の地図の根拠（mapInputsFor）', () => {
  const { household } = loadDemoData();
  it('デモの家庭の店ごとに、行き・戻りの徒歩（分、切り上げ）と営業時間を引く', async () => {
    const inputs = await mapInputsFor(household, fakeMaps(), () => NOW);
    expect(inputs?.checkedAt).toBe('2026-11-04T21:10+09:00');
    expect(inputs?.stores.find((s) => s.storeId === 'store-clothing-toyosu')).toMatchObject({
      stationId: 'st-toyosu',
      walkFromStationMin: 9,
      walkToStationMin: 11,
      regular: { timeZone: JST },
    });
  });

  it('戻りの道が無い店は根拠を持たない（片方だけで往復と言わない）', async () => {
    expect(await mapInputsFor(household, fakeMaps({ back: undefined }), () => NOW)).toBeUndefined();
  });

  it('営業時間が引けなければ、道のりだけの根拠にする（閉まっているとは言わない）', async () => {
    const inputs = await mapInputsFor(household, fakeMaps({ failHours: true }), () => NOW);
    const shop = inputs?.stores.find((s) => s.storeId === 'store-clothing-toyosu');
    expect(shop?.walkFromStationMin).toBe(9);
    expect(shop?.regular).toBeUndefined();
    expect(shop?.current).toBeUndefined();
  });

  it('道のりが引けなければ投げる（呼ぶ側が家庭の目安に戻す）', async () => {
    await expect(mapInputsFor(household, fakeMaps({ failWalk: true }), () => NOW)).rejects.toThrow(
      MapsError,
    );
  });
});

describe('Google の応答の読み方（googleMaps）', () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('行列の 0 の番号が省かれていたら 0 と読む', async () => {
    const client = googleMaps('fake-key', {
      fetch: respond([{ duration: '300s', condition: 'ROUTE_EXISTS' }]),
    });
    expect([...(await client.walkMatrix(['a'], ['b']))]).toEqual([['a>b', 300]]);
  });

  it('失敗は理由の種類だけを返し、上限を超えたら呼ばずに止める', async () => {
    const failing = googleMaps('fake-key', { fetch: respond({ error: 'x' }, 403) });
    await expect(failing.walkMatrix(['a'], ['b'])).rejects.toMatchObject({ reason: 'http' });
    let fetched = 0;
    const counted = (async () => {
      fetched += 1;
      return new Response('[]');
    }) as unknown as typeof fetch;
    const limited = googleMaps('fake-key', { fetch: counted, perMinute: 1, clock: () => NOW });
    await limited.walkMatrix(['a'], ['b']);
    await expect(limited.walkMatrix(['a'], ['b'])).rejects.toMatchObject({ reason: 'rateLimited' });
    expect(fetched).toBe(1);
  });
});

describe('デモの計画と地図', () => {
  it('地図の口があれば、買い物の寄り道を地図の道のりで置き、根拠を計画に添える', async () => {
    const sessions = demoSessions(Date.now, {}, { maps: fakeMaps(), mapsClock: () => NOW });
    const id = sessions.create('asked');
    const view = await sessions.view(id, 'a');
    const buy = view?.plan.tasks.find((t) => t.titleKey === 'task.buy');
    expect(buy).toMatchObject({
      travelSource: 'maps',
      travelBeforeMin: 9,
      travelAfterMin: 11,
      hoursBasis: 'mapsRegular',
    });
    expect(view?.plan.mapInputs?.checkedAt).toBe('2026-11-04T21:10+09:00');
  });

  it('地図が引けなければ、家庭の目安で置く（画面は止めない）', async () => {
    const sessions = demoSessions(Date.now, {}, { maps: fakeMaps({ failWalk: true }) });
    const id = sessions.create('asked');
    const view = await sessions.view(id, 'a');
    const buy = view?.plan.tasks.find((t) => t.titleKey === 'task.buy');
    expect(buy).toMatchObject({ travelSource: 'estimate', travelBeforeMin: 5 });
    expect(view?.plan.mapInputs).toBeUndefined();
  });

  it('地図の口が無いデモは、地図を使わず、道の口も無い', async () => {
    const sessions = demoSessions();
    const id = sessions.create('asked');
    expect(sessions.mapsEnabled).toBe(false);
    expect(await sessions.walk(id, 'store-clothing-toyosu')).toBeUndefined();
  });

  it('店までの徒歩の道は、家庭の店と駅の place ID で引く（地図に結び付かない店は無し）', async () => {
    const maps = fakeMaps();
    const sessions = demoSessions(Date.now, {}, { maps, mapsClock: () => NOW });
    const id = sessions.create('asked');
    const walk = await sessions.walk(id, 'store-clothing-toyosu');
    expect(walk).toMatchObject({
      station: { id: 'st-toyosu' },
      store: { id: 'store-clothing-toyosu' },
      route: { durationSec: 414 },
    });
    expect(await sessions.walk(id, 'home')).toBeUndefined();
    expect(await sessions.walk('no-such-session', 'store-clothing-toyosu')).toBeNull();
  });
});
