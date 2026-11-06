// 調べた候補を、確かめた家の場所の近くで地図に探し、家からの徒歩を添えて返す：見せるだけで取っておかない（見せる物に
// Google の名前・住所が無い）。名前で探すので、同じ名前の別の所（分院）も並べて返し、どれが同じ所かは家族が選ぶ。家の
// 場所の地図の確かめが無ければ探さない。地図も Claude も偽物（API を呼ばない）。候補と頁は架空（example.invalid）。
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { SurveyReader } from '../src/demo-sessions';
import type { MapsClient } from '../src/maps/google';

const headers = { 'content-type': 'application/json' };
const PAGE_URL = 'https://example.invalid/sick-care';
const NAME = 'みなと橋病児保育室（架空）';

/** 頁の本文に引用がある候補を一つ返す、偽物の調べ。 */
const surveyReader: SurveyReader = async () => ({
  output: {
    candidates: [
      {
        kind: 'sickChildCare',
        name: NAME,
        area: null,
        url: PAGE_URL,
        title: null,
        summary: '病気の子を、親が仕事で見られない時に預かる。',
        quote: '家庭で保育できないときにお預かりします。',
        registration: null,
        leadDays: null,
      },
    ],
  },
  pages: [
    {
      url: PAGE_URL,
      kind: 'text',
      text: 'みなと橋病児保育室（架空）は、病気のお子さんを、保護者が仕事などで家庭で保育できないときにお預かりします。',
    },
  ],
  model: 'claude-opus-5-5',
  promptVersion: 'survey.v1',
  inputHash: 'h',
  usage: { input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 },
});

/** 偽物の地図：家の場所、同じ名前の二つの所（本院と分院。住所が違う）、家からの徒歩の秒。 */
function fakeMaps() {
  const calls: string[] = [];
  const maps: MapsClient = {
    async place(placeId, want) {
      calls.push(`place:${placeId}:${want.summary ? 'summary' : 'hours'}`);
      return { id: placeId, location: { latitude: 35.67, longitude: 139.82 } };
    },
    async walkMatrix(origins, destinations) {
      calls.push(`matrix:${origins.join(',')}>${destinations.join(',')}`);
      return new Map([
        ['g-home>g-main', 610],
        ['g-home>g-branch', 1500],
        ['g-home>g-noaddress', 300],
      ]);
    },
    async walkRoute() {
      throw new Error('この試験では呼ばない');
    },
    async searchText(query, _center, radiusM, max) {
      calls.push(`search:${query}:${radiusM}:${max}`);
      return [
        { id: 'g-main', name: NAME, address: '架空の住所 1（本院）' },
        { id: 'g-branch', name: NAME, address: '架空の住所 2（分院）' },
        // 住所の無い所は、家族が出典の所在地と比べようがないので返さない。
        { id: 'g-noaddress', name: NAME },
      ];
    },
    async findAddress() {
      calls.push('find');
      return { id: 'g-home', address: '架空の家の住所' };
    },
  };
  return { maps, calls };
}

async function setup(confirmHome = true) {
  const fake = fakeMaps();
  const app = createApp({ maps: fake.maps, surveyReader });
  const opened = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ start: 'own', adults: ['大人A'], child: '子H' }),
  });
  const { sessionId } = (await opened.json()) as { sessionId: string };
  const base = `/api/demo/sessions/${sessionId}`;
  const post = (path: string, body: Record<string, unknown>) =>
    app.request(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberId: 'a1', ...body }),
    });
  const placed = (await (
    await post('/home-address', { area: '東京都江東区東陽', detail: '4-11-28' })
  ).json()) as { candidate: { id: string } };
  if (confirmHome) await post('/home-address/confirm', { candidateId: placed.candidate.id });
  const surveyed = (await (await post('/survey', { operationId: 's-1', live: true })).json()) as {
    survey: { candidates: { id: string }[] };
  };
  const candidateId = surveyed.survey.candidates[0]?.id ?? '';
  return { app, base, post, candidateId, calls: fake.calls };
}

describe('調べた候補を、家の近くの地図で探す', () => {
  it('同じ名前の所を住所つきで並べ、家からの徒歩を添える（家の場所の近くで、候補の名前で探す）', async () => {
    const { post, candidateId, calls, app, base } = await setup();
    expect(candidateId).not.toBe('');
    const response = await post('/survey/places', { candidateId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      places: [
        { placeId: 'g-main', name: NAME, address: '架空の住所 1（本院）', walkMin: 11 },
        { placeId: 'g-branch', name: NAME, address: '架空の住所 2（分院）', walkMin: 25 },
      ],
    });
    expect(calls.filter((c) => c !== 'find')).toEqual([
      'place:g-home:summary',
      `search:${NAME}:3000:3`,
      'matrix:g-home>g-main,g-branch',
    ]);
    // 見せるだけで取っておかない：見せる物（事象から作る）に、地図の住所は無い。
    const view = await (await app.request(`${base}/view?member=a1`)).text();
    expect(view).not.toContain('架空の住所');
  });

  it('家の場所の地図を確かめていなければ探さない。知らない候補・大人でない人は断る', async () => {
    const unconfirmed = await setup(false);
    const before = await unconfirmed.post('/survey/places', {
      candidateId: unconfirmed.candidateId,
    });
    expect(before.status).toBe(409);
    expect(await before.json()).toEqual({ error: 'noHome' });
    expect(unconfirmed.calls.some((c) => c.startsWith('search:'))).toBe(false);

    const { post, candidateId, app, base } = await setup();
    const unknown = await post('/survey/places', { candidateId: 'res-000000000000' });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: 'candidateGone' });
    const child = await app.request(`${base}/survey/places`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberId: 'c1', candidateId }),
    });
    expect(child.status).toBe(403);
  });

  it('一つの試用で 20 回まで', async () => {
    const { post, candidateId } = await setup();
    for (let i = 0; i < 20; i++) {
      expect((await post('/survey/places', { candidateId })).status).toBe(200);
    }
    const over = await post('/survey/places', { candidateId });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'placesLimit' });
  });
});
