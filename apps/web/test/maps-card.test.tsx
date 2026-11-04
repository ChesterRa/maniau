// @vitest-environment happy-dom
// 地図で置いた買い物の札：行きと戻りの徒歩を地図の分で書き（目安とは書かない）、ふだんの営業時間で置いた時は
// その日の臨時の休みを確かめていないと書き、調べた時刻と出典（Google Maps、訳さない）を添える。地図のある
// デモでは「地図で見る」で店までの徒歩の道を読み、Google の名前・分・Google マップで開く連絡を見せる。
// 地図の応答は手で作った架空の物（Google の本物の応答は使わない）。
import type { MapInputs, Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WalkView } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = {
  members: [
    { id: 'a', name: '健太', kind: 'adult', active: true },
    { id: 'b', name: '彩', kind: 'adult', active: true },
  ],
  places: [
    { id: 'st', kind: 'station', name: '豊洲駅', googlePlaceId: 'g-st', goods: [] },
    {
      id: 'shop',
      kind: 'store',
      name: '豊洲駅の近くの衣料品店',
      nearStationId: 'st',
      googlePlaceId: 'g-shop',
      walkFromStationMin: 5,
      goods: ['kidsClothing'],
    },
  ],
  careOptions: [],
  ways: [],
  resources: [],
};

const mapInputs: MapInputs = {
  checkedAt: '2026-11-04T21:10+09:00',
  stores: [
    {
      storeId: 'shop',
      googlePlaceId: 'g-shop',
      stationId: 'st',
      stationGooglePlaceId: 'g-st',
      walkFromStationMin: 9,
      walkToStationMin: 11,
      regular: {
        timeZone: 'Asia/Tokyo',
        periods: [{ weekday: 4, open: '10:00', close: '21:00' }],
      },
    },
  ],
};

const buy = (over: Partial<Task> = {}): Task =>
  ({
    key: 'task:opt:arr:purchase:i3:buy:buy',
    titleKey: 'task.buy',
    titleParams: { what: '白い長袖シャツ' },
    basis: { itemIds: ['i3'], requirementKey: 'req:i3', arrangementKey: 'arr:purchase:i3' },
    durationMin: 15,
    after: [],
    segments: ['commute', 'away'],
    placeKind: 'store',
    goods: 'kidsClothing',
    assigneeId: 'a',
    start: '2026-11-26T18:59+09:00',
    end: '2026-11-26T19:14+09:00',
    atPlaceId: 'shop',
    travelBeforeMin: 9,
    travelAfterMin: 11,
    travelSource: 'maps',
    hoursBasis: 'mapsRegular',
    detour: {
      plannedArrival: '2026-11-26T19:00+09:00',
      delayedArrival: '2026-11-26T19:35+09:00',
    },
    commitment: 'proposed',
    live: true,
    ...over,
  }) as Task;

const walk: WalkView = {
  checkedAt: '2026-11-04T21:12+09:00',
  station: {
    id: 'st',
    name: '豊洲駅（架空の応答）',
    location: { latitude: 35.65, longitude: 139.79 },
  },
  store: {
    id: 'shop',
    name: '架空の衣料品店',
    location: { latitude: 35.66, longitude: 139.79 },
    googleMapsUri: 'https://maps.google.com/?cid=1',
  },
  route: {
    durationSec: 414,
    distanceM: 486,
    polyline: 'abc',
    warnings: ['歩道の無い所があります'],
  },
};

function ctxWith(task: Task, maps?: Ctx['maps']) {
  return {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-26T12:00+09:00',
    me: household.members[0],
    household,
    plan: {
      tasks: [task],
      requirements: [],
      arrangements: [],
      requests: [],
      questions: [],
      throughSeq: 7,
      ...(task.travelSource === 'maps' ? { mapInputs } : {}),
    },
    today: { main: [{ kind: 'proposal', task }], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    ...(maps ? { maps } : {}),
    go: () => {},
  } as unknown as Ctx;
}

/** 架空の Google の地図（台本は読まない）。描いた線と印を数える。 */
const drawn = { lines: [] as unknown[][], markers: 0 };
(globalThis as unknown as { google: unknown }).google = {
  maps: {
    Map: class {
      fitBounds() {}
    },
    Polyline: class {
      constructor(options: { path: unknown[] }) {
        drawn.lines.push(options.path);
      }
    },
    LatLngBounds: class {
      extend() {}
    },
    geometry: {
      encoding: {
        decodePath: () => [
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      },
    },
    marker: {
      AdvancedMarkerElement: class {
        constructor() {
          drawn.markers += 1;
        }
      },
    },
  },
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  drawn.lines = [];
  drawn.markers = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('地図で置いた買い物の札', () => {
  it('行きと戻りの徒歩、ふだんの営業時間（臨時の休みは確かめていない）、調べた時刻と出典を書く', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy())} />));
    const text = host.textContent ?? '';
    expect(text).toContain('豊洲駅の近くの衣料品店・駅から歩いて9分（戻りは11分）');
    expect(text).not.toContain('（目安）');
    expect(text).toContain('家に着くのは 19:35');
    expect(text).toContain('ふだんの営業時間 10:00〜21:00（この日の臨時の休みは確かめていません）');
    expect(text).toContain('道のりと営業時間は 11/4');
    const mark = [...host.querySelectorAll('[translate="no"]')].map((e) => e.textContent);
    expect(mark).toContain('Google Maps');
  });

  it('地図の口の無い画面では「地図で見る」を出さない', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy())} />));
    expect(button('地図で見る')).toBeUndefined();
  });

  it('家庭の目安で置いた札は、今までどおり目安と書き、地図の出典を添えない', async () => {
    const estimate = buy({
      travelSource: 'estimate',
      hoursBasis: 'family',
      travelBeforeMin: 5,
      travelAfterMin: 5,
    });
    await step(() =>
      root.render(<TodayScreen ctx={ctxWith(estimate, { key: 'k', walk: async () => walk })} />),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('駅から歩いて約5分（目安）');
    expect(text).not.toContain('Google Maps');
    expect(button('地図で見る')).toBeUndefined();
  });

  it('「地図で見る」で店までの徒歩の道を読み、Google の名前と分、注意、開く連絡を見せる', async () => {
    const asked: string[] = [];
    const maps = {
      key: 'browser-key',
      walk: async (storeId: string) => {
        asked.push(storeId);
        return walk;
      },
    };
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy(), maps)} />));
    const open = button('地図で見る');
    expect(open).toBeDefined();
    await step(() => open?.click());
    await step(async () => {});
    expect(asked).toEqual(['shop']);
    const text = host.textContent ?? '';
    expect(text).toContain('豊洲駅（架空の応答）から架空の衣料品店までの歩く道（0.5 km）');
    // 地図の道の分（別の照会）は書かない。計画が使った分は札の上にある。
    expect(text).not.toContain('歩いて7分');
    expect(text).toContain('歩道の無い所があります');
    expect(text).toContain('地図・道・店の名前：');
    const link = [...host.querySelectorAll('a')].find(
      (a) => a.textContent === 'Google マップで開く',
    );
    expect(link?.getAttribute('href')).toBe('https://maps.google.com/?cid=1');
    expect(button('地図を閉じる')).toBeDefined();
    // 道の線は Google の道から描き、駅と店に印を置く。
    expect(drawn.lines).toHaveLength(1);
    expect(drawn.markers).toBe(2);
  });

  it('道の線が返らなければ、駅と店を結ぶ直線を描かず、線を描けなかったと書く', async () => {
    const noLine = {
      ...walk,
      route: { ...walk.route, polyline: undefined },
    } as unknown as WalkView;
    const maps = { key: 'browser-key', walk: async () => noLine };
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy(), maps)} />));
    await step(() => button('地図で見る')?.click());
    await step(async () => {});
    expect(drawn.lines).toHaveLength(0);
    expect(host.textContent).toContain('道の線は描けませんでした');
  });

  it('道を読めなければ、地図を出せないと書き、上の分と時間は残す', async () => {
    const maps = { key: 'browser-key', walk: async () => undefined };
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy(), maps)} />));
    await step(() => button('地図で見る')?.click());
    await step(async () => {});
    const text = host.textContent ?? '';
    expect(text).toContain('地図を出せませんでした。道のりと時間は上のとおりです。');
    expect(text).toContain('駅から歩いて9分（戻りは11分）');
  });

  it('提供者（attributions）が返った時は、その店・その駅のそばに書き、URL は http・https だけ繋ぐ', async () => {
    const withProviders = {
      ...walk,
      station: { ...walk.station, attributions: [{ provider: '駅の提供者' }] },
      store: {
        ...walk.store,
        attributions: [{ provider: '店の提供者', providerUri: 'https://example.com/store' }],
      },
    } as WalkView;
    const facts = buy();
    const evidence: MapInputs = {
      ...mapInputs,
      stores: mapInputs.stores.map((e) => ({
        ...e,
        name: '架空の衣料品店',
        attributions: [{ provider: '営業時間の提供者', providerUri: 'https://example.com/hours' }],
      })),
    };
    const ctx = ctxWith(facts, { key: 'browser-key', walk: async () => withProviders });
    (ctx.plan as { mapInputs?: MapInputs }).mapInputs = evidence;
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('データ提供：営業時間の提供者');
    await step(() => button('地図で見る')?.click());
    await step(async () => {});
    const text = host.textContent ?? '';
    expect(text).toContain('豊洲駅（架空の応答）のデータ提供：駅の提供者');
    expect(text).toContain('架空の衣料品店のデータ提供：店の提供者');
    const links = [...host.querySelectorAll('a')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]);
    expect(links).toContainEqual(['営業時間の提供者', 'https://example.com/hours']);
    expect(links).toContainEqual(['店の提供者', 'https://example.com/store']);
    expect(links.some(([name]) => name === '駅の提供者')).toBe(false);
  });

  it('提供者が返らなければ、提供者の行を出さない', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(buy())} />));
    expect(host.textContent).not.toContain('データ提供');
  });
});
