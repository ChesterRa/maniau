// 名前だけの試用で、家の場所を入れる：家に入れるのは、地域の欄（都道府県・市区町村・町名）に打った文だけ。番地の欄は、
// 地域の欄と合わせて地図の照会にだけ使い、事象（見せる物）・ログに出さない。地図で見つけた所は候補で、家族が確かめた
// 時だけ place ID を入れる。入れ直した後は、前の照会・前の候補を使わない。周りを調べる時に Claude に送るのは、地域の
// 欄だけ。地図も Claude も偽物（API を呼ばない）。住所は公共の施設の物（区が公開している江東区役所・豊洲特別出張所の
// 所在地）で、家族の住所ではない。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { SurveyReader } from '../src/demo-sessions';
import type { FoundAddress, MapsClient } from '../src/maps/google';
import type { SurveyInput } from '../src/reading/survey';
import type { View } from '../src/views';

const TOYO = { area: '東京都江東区東陽', detail: '4-11-28' };
const TOYOSU = { area: '東京都江東区豊洲', detail: '2-2-18' };
/** 番地の欄（家に残さず、Claude にも送らない部分）。 */
const DETAIL = /4-11-28|11-28|2-2-18|北5条西2/;
const headers = { 'content-type': 'application/json' };

type App = ReturnType<typeof createApp>;
type Answer = { view: View; candidate?: { id: string; address?: string } };

/** 偽物の地図：住所の照会だけを控え、打った文ごとに候補を返す（hold の文は、離すまで返さない）。 */
function fakeMaps(found: Record<string, FoundAddress | undefined> = {}) {
  const asked: string[] = [];
  const held = new Map<string, () => void>();
  const unused = () => {
    throw new Error('この試験では呼ばない');
  };
  const maps: MapsClient = {
    place: unused,
    walkMatrix: unused,
    walkRoute: unused,
    searchText: unused,
    async findAddress(text) {
      asked.push(text);
      if (holding.has(text)) await new Promise<void>((resolve) => held.set(text, resolve));
      return text in found
        ? found[text]
        : { id: `g-${asked.length}`, address: `地図の住所 ${text}` };
    },
  };
  const holding = new Set<string>();
  return {
    maps,
    asked,
    hold: (text: string) => holding.add(text),
    release: (text: string) => held.get(text)?.(),
  };
}

async function open(app: App, start: 'own' | 'sample' = 'own'): Promise<string> {
  const opened = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify(
      start === 'own' ? { start, adults: ['大人A', '大人B'], child: '子H' } : { start },
    ),
  });
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { sessionId: string }).sessionId;
}
const put = (
  app: App,
  session: string,
  input: { area: string; detail?: string },
  memberId = 'a1',
) =>
  app.request(`/api/demo/sessions/${session}/home-address`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId, ...input }),
  });
const confirm = (app: App, session: string, candidateId: string, memberId = 'a1') =>
  app.request(`/api/demo/sessions/${session}/home-address/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId, candidateId }),
  });
const view = async (app: App, session: string) =>
  (await app.request(`/api/demo/sessions/${session}/view?member=a2`)).text();

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('名前だけの試用で、家の場所を入れる', () => {
  it('地域の欄だけを家に入れ、地図の候補は家族が確かめた時だけ place ID を入れる', async () => {
    const fake = fakeMaps({
      東京都江東区東陽4128: undefined,
      '東京都江東区東陽4-11-28': {
        id: 'g-home',
        address: '日本、〒135-0016 東京都江東区東陽４丁目１１−２８',
      },
    });
    const app = createApp({ maps: fake.maps });
    const session = await open(app);
    const response = await put(app, session, TOYO);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Answer;
    // 地図には二つの欄を合わせて照会する。候補の住所は確かめるために見せるだけ。
    expect(fake.asked).toEqual(['東京都江東区東陽4-11-28']);
    expect(body.candidate).toEqual({
      id: expect.any(String),
      address: '日本、〒135-0016 東京都江東区東陽４丁目１１−２８',
    });
    expect(body.view.household.places).toEqual([
      { id: 'home', kind: 'home', name: '家', area: '東京都江東区東陽', goods: [] },
    ]);
    expect(JSON.stringify(body.view)).not.toMatch(DETAIL);

    const confirmed = await confirm(app, session, body.candidate?.id ?? '');
    expect(confirmed.status).toBe(200);
    const home = ((await confirmed.json()) as Answer).view.household.places[0];
    expect(home).toMatchObject({ area: '東京都江東区東陽', googlePlaceId: 'g-home' });
    expect(home?.lookedUpAt).toEqual(expect.any(String));
    // 確かめは一度だけ。番地は、事象から作る見せる物にも、ログにも無い。
    expect((await confirm(app, session, body.candidate?.id ?? '')).status).toBe(409);
    expect(await view(app, session)).not.toMatch(DETAIL);
    expect(logged.join('\n')).not.toMatch(DETAIL);
  });

  it('地図の住所が無い所は、確かめようがないので候補にせず、確かめも受けない', async () => {
    const fake = fakeMaps({ '東京都江東区東陽4-11-28': { id: 'g-unknown' } });
    const app = createApp({ maps: fake.maps });
    const session = await open(app);
    const body = (await (await put(app, session, TOYO)).json()) as Answer;
    expect(fake.asked).toEqual(['東京都江東区東陽4-11-28']);
    expect(body.candidate).toBeUndefined();
    expect(body.view.household.places).toEqual([
      { id: 'home', kind: 'home', name: '家', area: '東京都江東区東陽', goods: [] },
    ]);
    const forced = await confirm(app, session, 'g-unknown');
    expect(forced.status).toBe(409);
    expect(await view(app, session)).not.toContain('g-unknown');
  });

  it('地域の欄に番地に見える書き方があれば受けない（地図にも照会しない）。数字の入る町名は番地の欄へ', async () => {
    const fake = fakeMaps();
    const app = createApp({ maps: fake.maps });
    const session = await open(app);
    for (const area of [
      '東京都江東区東陽4-11-28',
      '東京都千代田区千代田一番一号',
      '北海道札幌市中央区北5条西',
    ]) {
      const refused = await put(app, session, { area, detail: '' });
      expect(refused.status, area).toBe(400);
      expect(await refused.json()).toEqual({ error: 'detailInArea' });
    }
    const vague = await put(app, session, { area: '豊洲', detail: '2-2-18' });
    expect(vague.status).toBe(400);
    expect(await vague.json()).toEqual({ error: 'noArea' });
    expect(fake.asked).toEqual([]);
    expect(await view(app, session)).not.toContain('"kind":"home"');

    const split = await put(app, session, { area: '北海道札幌市中央区', detail: '北5条西2丁目' });
    expect(split.status).toBe(200);
    expect(fake.asked).toEqual(['北海道札幌市中央区北5条西2丁目']);
    const placed = ((await split.json()) as Answer).view.household.places;
    expect(placed.map((p) => p.area)).toEqual(['北海道札幌市中央区']);
  });

  it('大人でない人と見本の家族は断る。地図の照会は一つの試用で 5 回まで（番地が無ければ照会しない）', async () => {
    const fake = fakeMaps();
    const app = createApp({ maps: fake.maps });
    const session = await open(app);
    const child = await put(app, session, TOYO, 'c1');
    expect(child.status).toBe(403);
    expect(await child.json()).toEqual({ error: 'notAnAdult' });
    const sample = await open(app, 'sample');
    const refused = await put(app, sample, TOYO);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'notOwnTrial' });
    expect(fake.asked).toEqual([]);

    const areaOnly = (await (await put(app, session, { area: TOYO.area })).json()) as Answer;
    expect(areaOnly.candidate).toBeUndefined();
    expect(fake.asked).toEqual([]);
    for (let i = 0; i < 5; i++) expect((await put(app, session, TOYO)).status).toBe(200);
    const over = await put(app, session, TOYO);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'addressLimit' });
    expect(fake.asked).toHaveLength(5);

    const without = createApp();
    const plain = await open(without);
    const done = (await (await put(without, plain, TOYO)).json()) as Answer;
    expect(done.candidate).toBeUndefined();
    expect(done.view.household.places[0]?.area).toBe('東京都江東区東陽');
  });

  it('入れ直した後は、遅れて返った前の照会を書かず、前の候補も確かめられない', async () => {
    const fake = fakeMaps();
    const app = createApp({ maps: fake.maps });
    const session = await open(app);
    // 前に入れた所の候補は、入れ直すと使えない。
    const first = (await (await put(app, session, TOYO)).json()) as Answer;
    const second = (await (await put(app, session, TOYOSU)).json()) as Answer;
    const old = await confirm(app, session, first.candidate?.id ?? '');
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: 'candidateGone' });

    // 遅い前の照会（東陽）と、速い後の照会（豊洲）：後の物だけを書く。
    fake.hold('東京都江東区東陽4-11-28');
    const slow = put(app, session, TOYO);
    await vi.waitFor(() => expect(fake.asked.at(-1)).toBe('東京都江東区東陽4-11-28'));
    const fast = (await (await put(app, session, TOYOSU)).json()) as Answer;
    fake.release('東京都江東区東陽4-11-28');
    const late = await slow;
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: 'stale' });
    expect(fast.view.household.places.map((p) => p.area)).toEqual(['東京都江東区豊洲']);
    const confirmed = await confirm(app, session, fast.candidate?.id ?? '');
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as Answer).view.household.places).toEqual([
      expect.objectContaining({ area: '東京都江東区豊洲', googlePlaceId: expect.any(String) }),
    ]);
    expect(second.candidate?.id).not.toBe(fast.candidate?.id);
  });

  it('周りを調べる時に Claude に送るのは、地域の欄と、その頭の都道府県だけ', async () => {
    const inputs: SurveyInput[] = [];
    const surveyReader: SurveyReader = async (input) => {
      inputs.push(input);
      return {
        output: { candidates: [] },
        pages: [],
        model: 'claude-opus-5-5',
        promptVersion: 'survey.v1',
        inputHash: 'h',
        usage: { input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 },
      };
    };
    const fake = fakeMaps();
    const app = createApp({ maps: fake.maps, surveyReader });
    const session = await open(app);
    const survey = (operationId: string) =>
      app.request(`/api/demo/sessions/${session}/survey`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ memberId: 'a1', operationId, live: true }),
      });
    // 家の場所が無い間は、調べられない（どこを調べるか分からない）。
    const before = await survey('s-0');
    expect(before.status).toBe(409);
    expect(await before.json()).toEqual({ error: 'noArea' });

    const placed = (await (await put(app, session, TOYO)).json()) as Answer;
    await confirm(app, session, placed.candidate?.id ?? '');
    const surveyed = await survey('s-1');
    expect(surveyed.status).toBe(200);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      area: '東京都江東区東陽',
      region: '東京都',
      country: 'JP',
      timeZone: 'Asia/Tokyo',
    });
    // 市区町村の名前は切り出して送らない（名前の中に市・町・村を含む物を、字の決まりでは正しく切れない）。
    expect(inputs[0]).not.toHaveProperty('city');
    expect(JSON.stringify(inputs)).not.toMatch(DETAIL);
    expect(JSON.stringify(inputs)).not.toContain('g-');
    expect((await surveyed.json()) as { survey: { area: string } }).toMatchObject({
      survey: { area: '東京都江東区東陽' },
    });
  });
});
