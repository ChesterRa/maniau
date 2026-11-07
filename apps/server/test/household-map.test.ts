// 家族の地図：名前だけの試用から、架空の Google 応答を家族が確かめて場所を結ぶ。外部 API は呼ばない。
import type { Household, SurveyShown } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ownHousehold } from '../src/demo';
import type { SurveyReader } from '../src/demo-sessions';
import { googleMaps, type MapsClient } from '../src/maps/google';
import {
  HOUSEHOLD_MAP_CACHE_MS,
  type HouseholdMapCache,
  householdMap,
  MAX_HOUSEHOLD_MAP_PLACES,
} from '../src/maps/household';
import type { View } from '../src/views';

const headers = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

function mapsFixture() {
  const fetched: string[] = [];
  const searched: string[] = [];
  const maps: MapsClient = {
    async place(id, want) {
      if (want.location) fetched.push(id);
      return {
        id,
        location:
          id === 'g-home' ? { latitude: 35, longitude: 139 } : { latitude: 35.1, longitude: 139.1 },
        ...(id === 'g-school' ? { attributions: [{ provider: '架空の提供者' }] } : {}),
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
      return { id: 'g-old', address: '架空の候補住所' };
    },
    async searchPlaces(query) {
      searched.push(query);
      return [
        {
          id: query === 'house-query' ? 'g-home' : 'g-school',
          name: `架空 ${query}`,
          address: `架空住所 ${query}`,
        },
      ];
    },
  };
  return { maps, fetched, searched };
}

async function open(app: ReturnType<typeof createApp>) {
  const response = await post(app, '/api/demo/sessions', {
    start: 'own',
    adults: ['大人A', '大人B'],
    child: '子H',
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function view(app: ReturnType<typeof createApp>, id: string) {
  const response = await app.request(`/api/demo/sessions/${id}/view?member=a1`);
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}

let operation = 0;
async function save(app: ReturnType<typeof createApp>, id: string, household: Household) {
  const looked = await post(app, `/api/demo/sessions/${id}/household-preview`, {
    memberId: 'a1',
    household,
  });
  if (looked.status !== 200) return { status: looked.status, body: await looked.json() };
  const { preview } = (await looked.json()) as { preview: { throughSeq: number; seen: unknown } };
  const result = await post(app, `/api/demo/sessions/${id}/commands`, {
    memberId: 'a1',
    operationId: `map-test-${++operation}`,
    command: {
      type: 'updateHousehold',
      household,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    },
  });
  return { status: result.status, body: await result.json() };
}

describe('家庭の場所の地図', () => {
  it('地図の口は検索の住所を表示用に読み、位置と提供者は確認後の ID で別に引く', async () => {
    const requests: { url: string; method: string; fields: string; body?: unknown }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        fields: headers.get('X-Goog-FieldMask') ?? '',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      const body = url.endsWith('places:searchText')
        ? {
            places: [
              {
                id: 'p1',
                displayName: { text: '架空の学校' },
                formattedAddress: '架空の住所',
                attributions: [{ provider: '提供者' }],
              },
              { id: 'p2', displayName: { text: '住所なし' } },
            ],
          }
        : {
            id: 'p1',
            location: { latitude: 35, longitude: 139 },
            attributions: [{ provider: '提供者' }],
          };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const client = googleMaps('fake-key', { fetch: fakeFetch });
    expect(await client.searchPlaces?.('架空の学校', 5)).toEqual([
      {
        id: 'p1',
        name: '架空の学校',
        address: '架空の住所',
        attributions: [{ provider: '提供者' }],
      },
    ]);
    expect(await client.place('p1', { location: true })).toEqual({
      id: 'p1',
      location: { latitude: 35, longitude: 139 },
      attributions: [{ provider: '提供者' }],
    });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      fields: 'places.id,places.displayName,places.formattedAddress,places.attributions',
      body: { textQuery: '架空の学校', pageSize: 5 },
    });
    expect(requests[1]).toMatchObject({ method: 'GET', fields: 'id,attributions,location' });
  });

  it('位置は同じ試用のメモリーに短く控え、期限が来たら取り直す', async () => {
    const fake = mapsFixture();
    const household = ownHousehold({ adults: ['大人A'], child: '子H' });
    household.places.push({
      id: 'p-home',
      kind: 'home',
      name: '架空の家',
      googlePlaceId: 'g-home',
      goods: [],
    });
    const cache: HouseholdMapCache = new Map();
    await householdMap(household, fake.maps, cache, 1_000);
    await householdMap(household, fake.maps, cache, 1_001);
    expect(fake.fetched).toEqual(['g-home']);
    await householdMap(household, fake.maps, cache, 1_000 + HOUSEHOLD_MAP_CACHE_MS);
    expect(fake.fetched).toEqual(['g-home', 'g-home']);
    expect([...cache.values()]).toEqual([
      { expiresAt: 1_000 + 2 * HOUSEHOLD_MAP_CACHE_MS, location: { latitude: 35, longitude: 139 } },
    ]);
  });

  it('引けない位置と上限外の場所を分ける。家の記録に地図 ID が無い物は照会しない', async () => {
    const fake = mapsFixture();
    const household = ownHousehold({ adults: ['大人A'], child: '子H' });
    for (let i = 0; i < MAX_HOUSEHOLD_MAP_PLACES + 1; i++) {
      household.places.push({
        id: `p-${i}`,
        kind: 'other',
        name: `架空の場所${i}`,
        googlePlaceId: `g-${i}`,
        goods: [],
      });
    }
    household.places.push({ id: 'p-unknown', kind: 'school', name: '架空の学校', goods: [] });
    const maps: MapsClient = {
      ...fake.maps,
      async place(id, want) {
        if (id === 'g-2') throw new Error('架空の失敗');
        if (id === 'g-3') return { id, location: { latitude: 999, longitude: 139 } };
        return fake.maps.place(id, want);
      },
    };
    const result = await householdMap(household, maps, new Map(), 1_000);
    expect(result.points).toHaveLength(MAX_HOUSEHOLD_MAP_PLACES - 2);
    expect(result.failed).toEqual(['p-2', 'p-3']);
    expect(result.omitted).toEqual([`p-${MAX_HOUSEHOLD_MAP_PLACES}`]);
    expect(result.points.some((p) => p.id === 'p-unknown')).toBe(false);
  });

  it('名前だけの家：候補を見るだけでは書かず、家と学校を確認して保存すると二つの位置を返す。計画は変えない', async () => {
    const fake = mapsFixture();
    const app = createApp({ maps: fake.maps, mapsBrowserKey: 'test-key' });
    const id = await open(app);
    expect(
      (await post(app, `/api/demo/sessions/${id}/example-notice`, { memberId: 'a1' })).status,
    ).toBe(200);
    const initial = await view(app, id);
    expect(initial.household.places).toEqual([]);
    const search = await post(app, `/api/demo/sessions/${id}/maps/household-search`, {
      memberId: 'a1',
      query: 'house-query',
    });
    expect(search.status).toBe(200);
    expect(((await search.json()) as { places: { placeId: string }[] }).places[0]?.placeId).toBe(
      'g-home',
    );
    expect((await view(app, id)).plan.throughSeq).toBe(initial.plan.throughSeq);

    const home = structuredClone(initial.household);
    home.places.push({
      id: 'p-home',
      kind: 'home',
      name: '架空の家',
      googlePlaceId: 'g-home',
      goods: [],
    });
    expect((await save(app, id, home)).status).toBe(200);
    const middle = await view(app, id);
    const school = structuredClone(middle.household);
    school.places.push({
      id: 'p-school',
      kind: 'school',
      name: '架空の学校',
      googlePlaceId: 'g-school',
      goods: [],
    });
    expect((await save(app, id, school)).status).toBe(200);
    const after = await view(app, id);
    const { throughSeq: _beforeSeq, ...beforePlan } = initial.plan;
    const { throughSeq: _afterSeq, ...afterPlan } = after.plan;
    expect(afterPlan).toEqual(beforePlan);
    expect(after.household.routines).toEqual(initial.household.routines);
    expect(after.household.careOptions).toEqual(initial.household.careOptions);
    expect(JSON.stringify(after.household)).not.toContain('架空住所');
    expect(JSON.stringify(after.household)).not.toContain('latitude');

    const map = await app.request(`/api/demo/sessions/${id}/maps/household?member=a1`);
    expect(map.status).toBe(200);
    expect(map.headers.get('cache-control')).toContain('no-store');
    const body = (await map.json()) as {
      points: { id: string; googlePlaceId: string }[];
      failed: string[];
    };
    expect(body.points.map((p) => [p.id, p.googlePlaceId])).toEqual([
      ['p-home', 'g-home'],
      ['p-school', 'g-school'],
    ]);
    expect(body.points[1]).toMatchObject({ attributions: [{ provider: '架空の提供者' }] });
    expect(body.failed).toEqual([]);
    expect(fake.fetched).toEqual(['g-home', 'g-school']);
    expect((await app.request(`/api/demo/sessions/${id}/maps/household?member=a1`)).status).toBe(
      200,
    );
    // 位置だけならキャッシュできる。提供者表示がある結果は、その表示を毎回いっしょに取る。
    expect(fake.fetched).toEqual(['g-home', 'g-school', 'g-school']);
  });

  it('見せた周りの候補を家族が地図の場所にも結ぶと、資源と場所の両方に同じ施設が残る', async () => {
    const fake = mapsFixture();
    const url = 'https://example.invalid/care';
    const reader: SurveyReader = async () => ({
      output: {
        candidates: [
          {
            kind: 'sickChildCare',
            name: '架空の病児保育室',
            area: null,
            url,
            title: null,
            summary: '病気の子を預かります。',
            quote: '家庭で保育できないときにお預かりします。',
            registration: null,
            leadDays: null,
          },
        ],
      },
      pages: [{ url, kind: 'text', text: '家庭で保育できないときにお預かりします。' }],
      model: 'recorded-test',
      promptVersion: 'survey.v1',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 },
    });
    const app = createApp({ maps: fake.maps, surveyReader: reader });
    const id = await open(app);
    const first = (await view(app, id)).household;
    first.places.push({
      id: 'p-home',
      kind: 'home',
      name: '架空の家',
      area: '東京都江東区豊洲',
      googlePlaceId: 'g-home',
      goods: [],
    });
    expect((await save(app, id, first)).status).toBe(200);
    const result = await post(app, `/api/demo/sessions/${id}/survey`, {
      memberId: 'a1',
      operationId: 'survey-map',
      live: true,
    });
    expect(result.status).toBe(200);
    const found = ((await result.json()) as { survey: SurveyShown }).survey.candidates[0];
    if (!found) throw new Error('調べた候補が無い');
    const next = (await view(app, id)).household;
    const placeId = `place-${found.id.replace(/^res-/, '')}`;
    next.places.push({
      id: placeId,
      kind: 'other',
      name: found.resource.name,
      googlePlaceId: 'g-school',
      goods: [],
    });
    next.resources.push({ ...found.resource, placeId, use: 'candidate' });
    expect((await save(app, id, next)).status).toBe(200);
    const after = (await view(app, id)).household;
    expect(after.resources.find((resource) => resource.id === found.id)?.placeId).toBe(placeId);
    expect(after.places.find((place) => place.id === placeId)?.googlePlaceId).toBe('g-school');
    const map = await app.request(`/api/demo/sessions/${id}/maps/household?member=a1`);
    expect(
      ((await map.json()) as { points: { id: string }[] }).points.map((point) => point.id),
    ).toEqual(['p-home', placeId]);
  });

  it('二つ目の家を拒み、子や別の会話に地図を見せない', async () => {
    const fake = mapsFixture();
    const app = createApp({ maps: fake.maps });
    const id = await open(app);
    const household = (await view(app, id)).household;
    const two = structuredClone(household);
    two.places.push(
      { id: 'p-home1', kind: 'home', name: '架空の家1', googlePlaceId: 'g-home', goods: [] },
      { id: 'p-home2', kind: 'home', name: '架空の家2', googlePlaceId: 'g-school', goods: [] },
    );
    const denied = await save(app, id, two);
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: 'placesLocked' });
    expect((await app.request(`/api/demo/sessions/${id}/maps/household?member=c1`)).status).toBe(
      403,
    );
    expect((await app.request('/api/demo/sessions/unknown/maps/household?member=a1')).status).toBe(
      404,
    );
    expect(
      (
        await post(app, `/api/demo/sessions/${id}/maps/household-search`, {
          memberId: 'a1',
          placeId: 'unknown',
          query: 'school',
        })
      ).status,
    ).toBe(404);
  });

  it('地図で家を足した後に前からの住所欄を使っても、家を二つにしない。古い候補は新しい場所を上書きできない', async () => {
    const fake = mapsFixture();
    const app = createApp({ maps: fake.maps });
    const id = await open(app);
    const household = (await view(app, id)).household;
    household.places.push({
      id: 'p-new-home',
      kind: 'home',
      name: '架空の家',
      googlePlaceId: 'g-home',
      goods: [],
    });
    expect((await save(app, id, household)).status).toBe(200);
    const response = await post(app, `/api/demo/sessions/${id}/home-address`, {
      memberId: 'a1',
      area: '東京都江東区豊洲',
      detail: '1-2-3',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidate: { id: string } };
    expect(body.candidate.id).toBeTruthy();
    const changed = (await view(app, id)).household;
    expect(changed.places.filter((p) => p.kind === 'home').map((p) => p.id)).toEqual([
      'p-new-home',
    ]);
    const home = changed.places.find((p) => p.id === 'p-new-home');
    if (!home) throw new Error('home missing');
    expect(home.googlePlaceId).toBeUndefined();
    home.googlePlaceId = 'g-school';
    expect((await save(app, id, changed)).status).toBe(200);
    const stale = await post(app, `/api/demo/sessions/${id}/home-address/confirm`, {
      memberId: 'a1',
      candidateId: body.candidate.id,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'candidateGone' });
    const result = (await view(app, id)).household;
    expect(result.places.filter((p) => p.kind === 'home')).toHaveLength(1);
    expect(result.places.find((p) => p.kind === 'home')?.googlePlaceId).toBe('g-school');
  });
});
