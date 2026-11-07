// 名前だけの家から、家と学校を検索・確認して地図に載せる。HTTP と保存は本物のサーバー経由、地図だけ架空。
import type { Command, Household, HouseholdPreview } from '@maniau/core';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';
import type { MapsClient } from '../../server/src/maps/google';
import type { View } from '../../server/src/views';
import type { HouseholdMapView, HouseholdPlaceSearchResult } from '../src/family';
import { HouseholdMapCard } from '../src/household-map';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';
import { ctxFor } from './ctx';
import { step } from './fake-fetch';

const browser = new Window({ url: 'http://localhost/' });
const globals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'MouseEvent',
] as const;
const previous = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globals) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: browser[key] ?? browser,
  });
}
const { createRoot } = await import('react-dom/client');
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});

const headers = { 'content-type': 'application/json' };
let host: HTMLDivElement;
let root: Root;
const markers: { title: string; position: { lat: number; lng: number }; label: string | null }[] =
  [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  markers.length = 0;
  (window as unknown as { google: unknown }).google = {
    maps: {
      Map: class {
        fitBounds() {}
        panTo() {}
      },
      LatLngBounds: class {
        extend() {}
      },
      marker: {
        AdvancedMarkerElement: class {
          map: unknown;
          constructor(options: {
            map: unknown;
            title: string;
            position: { lat: number; lng: number };
            content: HTMLElement;
          }) {
            this.map = options.map;
            markers.push({
              title: options.title,
              position: options.position,
              label: options.content.textContent,
            });
          }
          addEventListener() {}
        },
      },
    },
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
function enter(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (name: string) => {
  const label = [...host.querySelectorAll('label')].find((entry) =>
    entry.textContent?.includes(name),
  );
  const input = label?.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error(`欄が無い: ${name}`);
  return input;
};

it('地図を使えない家庭でも、登録した場所と未設定を一覧できる', async () => {
  const ctx = ctxFor('arrived', 'b', 'ja');
  await step(() => root.render(<HouseholdMapCard ctx={ctx} />));
  expect(host.textContent).toContain('この家庭では、場所の検索と地図をまだ使えません。');
  await step(() => button('場所の一覧を見る')?.click());
  expect(host.textContent).toContain('地図の場所は未設定');
  expect(host.textContent).not.toContain('場所を読み取れませんでした');
});

it('検索中に別の場所を選ぶと、その場所はすぐ探せ、前の返事も混ざらない', async () => {
  let finish: ((result: HouseholdPlaceSearchResult) => void) | undefined;
  const pending = new Promise<HouseholdPlaceSearchResult>((resolve) => {
    finish = resolve;
  });
  const ctx: Ctx = {
    ...ctxFor('arrived', 'b', 'ja'),
    maps: {
      key: 'fake-key',
      walk: async () => undefined,
      householdMap: async () => ({ status: 'ok', map: { points: [], failed: [], omitted: [] } }),
      searchHouseholdPlace: async () => pending,
    },
  };
  await step(() => root.render(<HouseholdMapCard ctx={ctx} />));
  await step(() => button('地図を開く')?.click());
  const find = (name: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="「${name}」の地図の場所を探す"]`);
  await step(() => find('家')?.click());
  await step(() => enter(field('探す名前・住所'), 'old-query'));
  await step(() => button('候補を探す')?.click());
  expect(button('探しています')?.disabled).toBe(true);
  await step(() => find('みらい橋小学校（架空）')?.click());
  await step(() => enter(field('探す名前・住所'), 'new-query'));
  expect(button('候補を探す')?.disabled).toBe(false);
  if (!finish) throw new Error('検索を始めていない');
  await step(() =>
    finish?.({ status: 'ok', places: [{ placeId: 'old', name: '前の候補', address: '架空住所' }] }),
  );
  expect(host.textContent).not.toContain('前の候補');
});

it('家と学校の候補を表示してから、見る・保存する。二つのピンは保存された場所だけ', async () => {
  const maps: MapsClient = {
    async place(id) {
      return {
        id,
        location:
          id === 'g-home' ? { latitude: 35, longitude: 139 } : { latitude: 35.1, longitude: 139.1 },
      };
    },
    async walkMatrix() {
      return new Map();
    },
    async walkRoute() {
      return undefined;
    },
    async searchText() {
      return [];
    },
    async findAddress() {
      return undefined;
    },
    async searchPlaces(query) {
      return [
        {
          id: query === 'house-query' ? 'g-home' : 'g-school',
          name: `候補 ${query}`,
          address: `架空住所 ${query}`,
        },
      ];
    },
  };
  const app = createApp({ maps });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const opened = await post('/api/demo/sessions', {
    start: 'own',
    adults: ['大人A', '大人B'],
    child: '子H',
  });
  const { sessionId } = (await opened.json()) as { sessionId: string };
  const base = `/api/demo/sessions/${sessionId}`;
  const read = async () => (await (await app.request(`${base}/view?member=a1`)).json()) as View;
  let view = await read();
  const sent: Command[] = [];
  const ctx = (): Ctx =>
    ({
      household: view.household,
      plan: view.plan,
      today: view.today,
      items: view.items,
      sources: new Map(view.sources.map((source) => [source.id, source])),
      readings: [],
      me: view.household.members.find((member) => member.id === 'a1'),
      lang: 'ja',
      tz: 'Asia/Tokyo',
      now: view.now,
      t: i18n.getFixedT('ja'),
      outbound: (lang: 'ja' | 'en') => i18n.getFixedT(lang),
      go: () => {},
      maps: {
        key: 'fake-key',
        walk: async () => undefined,
        householdMap: async () => {
          const response = await app.request(`${base}/maps/household?member=a1`);
          return response.ok
            ? { status: 'ok', map: (await response.json()) as HouseholdMapView }
            : { status: 'failed' };
        },
        searchHouseholdPlace: async (placeId: string | undefined, query: string) => {
          const response = await post(`${base}/maps/household-search`, {
            memberId: 'a1',
            ...(placeId ? { placeId } : {}),
            query,
          });
          return response.ok
            ? {
                status: 'ok',
                places: (
                  (await response.json()) as {
                    places: Extract<HouseholdPlaceSearchResult, { status: 'ok' }>['places'];
                  }
                ).places,
              }
            : { status: 'failed' };
        },
      },
      previewHousehold: async (household: Household) => {
        const response = await post(`${base}/household-preview`, { memberId: 'a1', household });
        return response.ok
          ? { preview: ((await response.json()) as { preview: HouseholdPreview }).preview }
          : { refused: 'other' };
      },
      send: async (command: Command) => {
        sent.push(command);
        const response = await post(`${base}/commands`, {
          memberId: 'a1',
          operationId: `map-test-${sent.length}`,
          command,
        });
        const body = (await response.json()) as { result: { status: 'ok' | 'conflict' } };
        if (response.ok) view = await read();
        return body.result;
      },
    }) as Ctx;
  const render = async () => step(() => root.render(<HouseholdMapCard ctx={ctx()} />));
  await render();
  expect(host.textContent).not.toContain('まだ場所はありません');
  await step(() => button('地図を開く')?.click());
  expect(host.textContent).toContain('まだ場所はありません');

  async function add(name: string, kind: string, query: string) {
    await step(() => button('場所を足す')?.click());
    await step(() => enter(field('家で呼ぶ名前'), name));
    const select = host.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('種類の欄が無い');
    await step(() => {
      select.value = kind;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (kind === 'home') await step(() => enter(field('家の地域'), '東京都江東区豊洲'));
    await step(() => enter(field('探す名前・住所'), query));
    await step(() => button('候補を探す')?.click());
    expect(host.textContent).toContain(`架空住所 ${query}`);
    expect(view.household.places.some((p) => p.name === name)).toBe(false);
    await step(() => button('この候補を選ぶ')?.click());
    expect(button('この内容で保存')).toBeUndefined();
    await step(() => button('変わることを見る')?.click());
    expect(button('この内容で保存')).toBeDefined();
    await step(() => button('この内容で保存')?.click());
    await render();
    expect(view.household.places.some((p) => p.name === name)).toBe(true);
  }
  await add('架空の家', 'home', 'house-query');
  await add('架空の学校', 'school', 'school-query');
  expect(sent).toHaveLength(2);
  expect(JSON.stringify(view.household)).not.toContain('架空住所');
  await step(() => button('場所を読み直す')?.click());
  expect(markers.map((m) => m.title)).toEqual(['架空の家', '架空の学校']);
  expect(markers.map((m) => m.position)).toEqual([
    { lat: 35, lng: 139 },
    { lat: 35.1, lng: 139.1 },
  ]);
  expect(markers.map((m) => m.label)).toEqual(['1', '2']);
});
