// 地図の口（Google の Places・Routes）の読み方と、デモの計画への繋ぎ（02-foundation §2.3）。
// 応答は手で作った架空の物で、Google の本物の応答は使わない。鍵も架空。
import type { Household, PlaceAttribution } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadDemoData } from '../src/demo';
import { demoSessions, MAX_STORE_SEARCHES_PER_SESSION } from '../src/demo-sessions';
import { type FoundPlace, googleMaps, type MapsClient, MapsError } from '../src/maps/google';
import { currentOf, mapInputsFor, regularOf } from '../src/maps/inputs';
import { searchStores } from '../src/maps/search';
import { cleanQueries, readStoreKinds } from '../src/reading/store-kinds';

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

/** デモの豊洲駅の place ID（本物。地図の口は架空）。 */
const STATION = 'ChIJMR82CaOJGGARi2sprG-ld6k';

/** 架空の地図の口：駅 → 店と店 → 駅の秒、店の営業時間、検索の結果（店ごとの駅からの秒は walks）。 */
function fakeMaps(
  over: Partial<{
    there: number;
    back: number | undefined;
    failHours: boolean;
    failWalk: boolean;
    found: FoundPlace[];
    walks: Record<string, number>;
    /** place ID ごとの、詳細と一緒に返す提供者。 */
    attributions: Record<string, PlaceAttribution[]>;
  }> = {},
): MapsClient & { calls: string[]; queries: string[] } {
  const calls: string[] = [];
  const queries: string[] = [];
  const there = over.there ?? 510;
  const back = 'back' in over ? over.back : 630;
  return {
    calls,
    queries,
    async place(placeId, want) {
      calls.push(`place:${want.hours ? 'hours' : 'summary'}`);
      if (want.hours && over.failHours) throw new MapsError('http');
      const attributions = over.attributions?.[placeId];
      return {
        id: placeId,
        name: `架空の場所 ${placeId.slice(-4)}`,
        ...(attributions ? { attributions } : {}),
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
          const toStore = o === STATION;
          const seconds = toStore ? (over.walks?.[d] ?? there) : (over.walks?.[o] ?? back);
          if (seconds !== undefined) result.set(`${o}>${d}`, seconds);
        }
      }
      return result;
    },
    async walkRoute() {
      calls.push('route');
      return { durationSec: 414, distanceM: 486, polyline: 'abc', warnings: [] };
    },
    async searchText(query) {
      calls.push('search');
      queries.push(query);
      return over.found ?? [];
    },
    async findAddress() {
      calls.push('find');
      return undefined;
    },
  };
}

/** 架空の店（Google の place ID の形だけ似せた物）。 */
const shop = (id: string, name: string): FoundPlace => ({
  id,
  name,
  address: `架空の住所 ${name}`,
  location: { latitude: 35.65, longitude: 139.79 },
});

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

describe('駅の近くの店を探す（searchStores）', () => {
  const { household } = loadDemoData();
  const clothing = household.places.find((p) => p.id === 'store-clothing-toyosu')?.googlePlaceId;

  it('言葉をそのまま送り、駅から歩いて 15 分までの店を近い順に返す（駅そのものと道の無い店は出さない）', async () => {
    const maps = fakeMaps({
      found: [
        shop('g-far', '遠い店'),
        shop('g-near', '近い店'),
        shop(STATION, '豊洲駅'),
        shop('g-edge', 'ちょうど15分の店'),
        shop('g-over', '15分を超える店'),
        shop('g-noroute', '道の無い店'),
        shop(clothing ?? '', '登録した店'),
      ],
      walks: { 'g-far': 600, 'g-near': 120, 'g-edge': 900, 'g-over': 901, [clothing ?? '']: 420 },
    });
    // 道の無い店は、行列に秒を返さない。
    const matrix = maps.walkMatrix;
    maps.walkMatrix = async (o, d) => {
      const result = await matrix(o, d);
      result.delete(`${STATION}>g-noroute`);
      return result;
    };
    const stores = await searchStores(household, maps, ' 文房具店 ', 'st-toyosu');
    expect(maps.queries).toEqual([' 文房具店 ']);
    expect(stores?.map((s) => [s.name, s.walkMin, s.known ?? false])).toEqual([
      ['近い店', 2, false],
      ['登録した店', 7, true],
      ['遠い店', 10, false],
      ['ちょうど15分の店', 15, false],
    ]);
  });

  it('駅が地図に結び付かなければ、探さない（undefined）', async () => {
    const maps = fakeMaps({ found: [shop('g-near', '近い店')] });
    expect(await searchStores(household, maps, '文房具店', 'st-yurakucho')).toBeUndefined();
    expect(maps.queries).toEqual([]);
  });
});

describe('店を探す言葉の案（Claude）', () => {
  it('空・長すぎる・重なりを落とし、3 つまでにする', () => {
    expect(
      cleanQueries([
        ' 文房具店 ',
        '',
        '文房具店',
        'あ'.repeat(21),
        '100円ショップ',
        '画材店',
        '楽器店',
      ]),
    ).toEqual(['文房具店', '100円ショップ', '画材店']);
  });

  it('送るのは品物の名前だけで、モデルの案をそろえて返す', async () => {
    const sent: unknown[] = [];
    const client = {
      messages: {
        parse: async (request: unknown) => {
          sent.push(request);
          return {
            stop_reason: 'end_turn',
            model: 'fake-model',
            parsed_output: { queries: ['画材店', '画材店', '文房具店'] },
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    } as unknown as Parameters<typeof readStoreKinds>[0];
    const result = await readStoreKinds(client, '絵の具セット');
    expect(result.queries).toEqual(['画材店', '文房具店']);
    expect(JSON.stringify((sent[0] as { messages: unknown }).messages)).toBe(
      JSON.stringify([{ role: 'user', content: '{"item":"絵の具セット"}' }]),
    );
  });
});

describe('デモで店を探して選ぶ', () => {
  const found = [shop('g-new', '新しい店')];

  it('探せる数はデモごとに限る', async () => {
    const sessions = demoSessions(
      Date.now,
      {},
      { maps: fakeMaps({ found }), mapsClock: () => NOW },
    );
    const id = sessions.create('asked');
    for (let i = 0; i < MAX_STORE_SEARCHES_PER_SESSION; i += 1) {
      expect(await sessions.searchStores(id, '子供服', 'st-toyosu')).toMatchObject({
        status: 'ok',
      });
    }
    expect(await sessions.searchStores(id, '子供服', 'st-toyosu')).toEqual({ status: 'limit' });
    expect(await sessions.searchStores('no-such-session', '子供服', 'st-toyosu')).toBeNull();
    // 地図の口が無いデモは、探さない（undefined）。
    const plain = demoSessions();
    expect(await plain.searchStores(plain.create('asked'), 'x', 'st-toyosu')).toBeUndefined();
  });

  it('選んだ新しい店は、見る時にも地図の根拠を引き、見た通りに保存される', async () => {
    const maps = fakeMaps({ found, walks: { 'g-new': 180 } });
    const sessions = demoSessions(Date.now, {}, { maps, mapsClock: () => NOW });
    const id = sessions.create('asked');
    const before = await sessions.view(id, 'a');
    const household = structuredClone(before?.household) as Household;
    household.places.push({
      id: 'store-new',
      kind: 'store',
      name: '子供服',
      nearStationId: 'st-toyosu',
      googlePlaceId: 'g-new',
      goods: ['白い長袖シャツ'],
    });
    const preview = await sessions.householdPreview(id, 'a', household);
    if (!preview || 'reason' in preview) throw new Error('見られない');
    expect(preview.changes.relocated).toEqual([
      expect.objectContaining({ before: 'store-clothing-toyosu', after: 'store-new' }),
    ]);
    const saved = await sessions.command(id, 'a', 'op-store', {
      type: 'updateHousehold',
      household,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
    expect(saved?.result.status).toBe('ok');
    expect(saved?.view.plan.tasks.find((t) => t.titleKey === 'task.buy')).toMatchObject({
      atPlaceId: 'store-new',
      travelSource: 'maps',
      travelBeforeMin: 3,
    });
  });
});

describe('店を探す口（API）', () => {
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const sessionOf = async (app: ReturnType<typeof createApp>) =>
    (await (await post(app, '/api/demo/sessions', { stage: 'asked' })).json()) as {
      sessionId: string;
      canSearchStores?: boolean;
      canSuggestStores?: boolean;
    };

  it('地図の口が無ければ、探す口も案の口も開けない', async () => {
    const app = createApp({ storeKindsReader: async () => ({}) as never });
    const session = await sessionOf(app);
    expect(session.canSearchStores).toBeUndefined();
    expect(session.canSuggestStores).toBeUndefined();
    const base = `/api/demo/sessions/${session.sessionId}/maps`;
    expect((await post(app, `${base}/stores`, { query: 'x', stationId: 'st-toyosu' })).status).toBe(
      503,
    );
    expect((await post(app, `${base}/store-kinds`, { what: 'ハンカチ' })).status).toBe(503);
  });

  it('案は押した時だけ聞き、探すのは送った言葉で（控えに残さない）', async () => {
    const maps = fakeMaps({ found: [shop('g-new', '新しい店')], walks: { 'g-new': 180 } });
    const asked: string[] = [];
    const app = createApp({
      maps,
      storeKindsReader: async (what) => {
        asked.push(what);
        return {
          queries: ['文房具店'],
          model: 'fake',
          promptVersion: 'fake',
          inputHash: 'fake',
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    });
    const session = await sessionOf(app);
    expect(session).toMatchObject({ canSearchStores: true, canSuggestStores: true });
    expect(asked).toEqual([]);
    expect(maps.queries).toEqual([]);
    const base = `/api/demo/sessions/${session.sessionId}/maps`;
    const kinds = await post(app, `${base}/store-kinds`, { what: 'ハンカチ' });
    expect(await kinds.json()).toEqual({ queries: ['文房具店'] });
    expect(maps.queries).toEqual([]);
    const stores = await post(app, `${base}/stores`, { query: '雑貨店', stationId: 'st-toyosu' });
    expect(stores.status).toBe(200);
    expect(stores.headers.get('cache-control')).toContain('no-store');
    expect(((await stores.json()) as { stores: unknown[] }).stores).toHaveLength(1);
    expect(maps.queries).toEqual(['雑貨店']);
    expect((await post(app, `${base}/stores`, { query: '', stationId: 'st-toyosu' })).status).toBe(
      400,
    );
    expect(
      (await post(app, `${base}/stores`, { query: 'あ'.repeat(41), stationId: 'st-toyosu' }))
        .status,
    ).toBe(400);
  });
});

describe('結果と一緒に見せる提供者（attributions）', () => {
  const given = [
    { provider: '架空の提供者', providerUri: 'https://example.com/a' },
    { provider: '危ない提供者', providerUri: 'javascript:alert(1)' },
    { provider: ' ' },
  ];
  const kept: PlaceAttribution[] = [
    { provider: '架空の提供者', providerUri: 'https://example.com/a' },
    { provider: '危ない提供者' },
  ];

  it('詳細と文の検索で提供者を頼み、名前の無い物を落とし、URL は http・https だけを残す', async () => {
    const masks: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const mask = headers['X-Goog-FieldMask'] ?? '';
      masks.push(mask);
      const place = { id: 'g-1', displayName: { text: '架空の店' }, attributions: given };
      return new Response(JSON.stringify(mask.startsWith('places.') ? { places: [place] } : place));
    }) as unknown as typeof fetch;
    const client = googleMaps('fake-key', { fetch: fake });
    expect((await client.place('g-1', { hours: true })).attributions).toEqual(kept);
    const found = await client.searchText('文房具店', { latitude: 35.6, longitude: 139.7 }, 800, 8);
    expect(found[0]?.attributions).toEqual(kept);
    expect(masks[0]?.split(',')).toContain('attributions');
    expect(masks[1]?.split(',')).toContain('places.attributions');
  });

  it('提供者は、その店・その駅の結果にだけ付ける（返らなければ付けない）', async () => {
    const { household } = loadDemoData();
    const clothing =
      household.places.find((p) => p.id === 'store-clothing-toyosu')?.googlePlaceId ?? '';
    const maps = fakeMaps({
      attributions: { [clothing]: kept, [STATION]: [{ provider: '駅の提供者' }] },
      found: [
        { ...shop('g-a', '提供者のある店'), attributions: kept },
        shop('g-b', '提供者の無い店'),
      ],
      walks: { 'g-a': 120, 'g-b': 180 },
    });
    const inputs = await mapInputsFor(household, maps, () => NOW);
    expect(inputs?.stores.find((e) => e.storeId === 'store-clothing-toyosu')?.attributions).toEqual(
      kept,
    );
    expect(
      inputs?.stores.find((e) => e.storeId === 'store-super-toyosu')?.attributions,
    ).toBeUndefined();
    const stores = await searchStores(household, maps, '文房具店', 'st-toyosu');
    expect(stores?.map((f) => [f.name, f.attributions])).toEqual([
      ['提供者のある店', kept],
      ['提供者の無い店', undefined],
    ]);
    const sessions = demoSessions(Date.now, {}, { maps, mapsClock: () => NOW });
    const walk = await sessions.walk(sessions.create('asked'), 'store-clothing-toyosu');
    expect(walk?.station.attributions).toEqual([{ provider: '駅の提供者' }]);
    expect(walk?.store.attributions).toEqual(kept);
  });
});

describe('住所の場所を探す', () => {
  it('place ID と確かめる住所と提供者だけを頼み（名前・位置は頼まない）、一つだけ受ける。無ければ undefined', async () => {
    const asked: { mask: string; body: Record<string, unknown> }[] = [];
    let places: Record<string, unknown>[] = [
      { id: 'g-home', formattedAddress: '日本、〒135-0016 東京都江東区東陽４丁目１１−２８' },
    ];
    const fake = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      asked.push({ mask: headers['X-Goog-FieldMask'] ?? '', body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ places }));
    }) as unknown as typeof fetch;
    const client = googleMaps('fake-key', { fetch: fake });
    expect(await client.findAddress('東京都江東区東陽4-11-28')).toEqual({
      id: 'g-home',
      address: '日本、〒135-0016 東京都江東区東陽４丁目１１−２８',
    });
    expect(asked[0]?.mask).toBe('places.id,places.formattedAddress,places.attributions');
    expect(asked[0]?.body).toEqual({
      textQuery: '東京都江東区東陽4-11-28',
      languageCode: 'ja',
      regionCode: 'JP',
      pageSize: 1,
    });
    places = [];
    expect(await client.findAddress('どこにも無い所')).toBeUndefined();
  });
});
