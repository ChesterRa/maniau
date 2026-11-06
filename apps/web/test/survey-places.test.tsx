// @vitest-environment happy-dom
// 調べた候補を、確かめた家の場所の近くで地図に探す：同じ名前の所（本院・分院）を住所つきで並べ、家族が同じ所を選んで
// から、家からの徒歩を見せる（選ぶ前は出さない）。家の場所を地図で確かめていなければ探す口を出さない。候補・住所は
// 架空（example.invalid）。偽物の口だけ（通信しない）。
import { Household, type SurveyCandidate, type SurveyShown } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SurveyPlacesResult } from '../src/family';
import i18n from '../src/i18n';
import { ResourcesCard } from '../src/resources';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

const NAME = 'みなと橋病児保育室（架空）';
const CANDIDATE: SurveyCandidate = {
  id: 'res-aaaaaaaaaaaa',
  resource: {
    id: 'res-aaaaaaaaaaaa',
    kind: 'sickChildCare',
    name: NAME,
    notes: [
      {
        text: '病気の子を、保護者が仕事で見られない時に預かる。',
        source: {
          kind: 'webPage',
          url: 'https://example.invalid/sick-care',
          fetchedAt: '2026-11-06T13:30+09:00',
          quoteFound: true,
        },
      },
    ],
    use: 'candidate',
  },
};
const SHOWN: SurveyShown = {
  area: '東京都江東区東陽',
  at: '2026-11-06T13:32+09:00',
  recorded: false,
  candidates: [CANDIDATE],
  dropped: [],
};
const FOUND: SurveyPlacesResult = {
  status: 'ok',
  places: [
    { placeId: 'g-main', name: NAME, address: '架空の住所 1（本院）', walkMin: 11 },
    { placeId: 'g-branch', name: NAME, address: '架空の住所 2（分院）', walkMin: 25 },
  ],
};

const own = (googlePlaceId?: string) =>
  Household.parse({
    id: 'trial-own',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a1', kind: 'adult', name: '大人A' },
      { id: 'c1', kind: 'child', name: '子H' },
    ],
    places: [
      {
        id: 'home',
        kind: 'home',
        name: '家',
        area: '東京都江東区東陽',
        ...(googlePlaceId ? { googlePlaceId } : {}),
      },
    ],
    routines: [],
    careOptions: [],
  });

function withPlaces(household: Household, found: SurveyPlacesResult = FOUND) {
  const asked: string[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[0],
    household,
    t: i18n.getFixedT('ja'),
    send: async () => ({ status: 'ok' }),
    ownTrial: true,
    home: { set: async () => ({ status: 'ok' }), confirm: async () => 'ok', maps: true },
    survey: {
      run: async () => ({ status: 'ok', survey: SHOWN }),
      recorded: true,
      live: true,
      places: async (candidateId: string) => {
        asked.push(candidateId);
        return found;
      },
    },
    previewHousehold: async () => undefined,
    go: () => undefined,
  } as unknown as Ctx;
  return { ctx, asked };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});
const text = () => host.textContent ?? '';
const buttons = (label: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent === label);
const press = async (label: string, index = 0) => {
  const found = buttons(label)[index];
  if (!found) throw new Error(`押す物が無い：${label}`);
  await step(() => found.click());
};
const LOOK = '家からの道のりを地図で調べる';

describe('調べた候補を、家の近くの地図で探す', () => {
  it('同じ名前の所を住所つきで並べ、家族が同じ所を選んでから、家からの徒歩を見せる', async () => {
    const { ctx, asked } = withPlaces(own('g-home'));
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await press('周りを調べる');
    await press(LOOK);
    expect(asked).toEqual(['res-aaaaaaaaaaaa']);
    expect(text()).toContain(`${NAME}（架空の住所 1（本院））`);
    expect(text()).toContain(`${NAME}（架空の住所 2（分院））`);
    expect(text()).toContain('別の施設や、同じ名前の別の所（分院など）も出ます。');
    // 選ぶ前は、どの所の徒歩も出さない。
    expect(text()).not.toContain('家から歩いて');
    await press('これが同じ所', 1);
    expect(text()).toContain(`家から歩いて約 25 分（地図で選んだ「${NAME}」まで）。`);
    expect(text()).toContain(
      '地図のデータ：Google。いま地図で調べた物で、この試用には残しません。',
    );
    // 選んだ所は住所で見分けられる。選び違えたら、地図に聞き直さずに選び直せる。
    expect(text()).toContain(`選んだ所：${NAME}（架空の住所 2（分院））`);
    expect(text()).not.toContain('架空の住所 1');
    await press('選び直す');
    expect(text()).toContain(`${NAME}（架空の住所 1（本院））`);
    expect(text()).not.toContain('家から歩いて');
    await press('これが同じ所', 0);
    expect(text()).toContain(`家から歩いて約 11 分（地図で選んだ「${NAME}」まで）。`);
    expect(asked).toEqual(['res-aaaaaaaaaaaa']);
  });

  it('どれも違う時は、道のりを出さない。見つからない時はそう言う', async () => {
    const found = withPlaces(own('g-home'));
    await step(() => root.render(<ResourcesCard ctx={found.ctx} />));
    await press('周りを調べる');
    await press(LOOK);
    await press('どれも違う');
    expect(text()).toContain('同じ所が無かったので、道のりは出しません。');
    expect(text()).not.toContain('家から歩いて');
    await press('選び直す');
    expect(buttons('これが同じ所')).toHaveLength(2);

    await step(() => root.unmount());
    root = createRoot(host);
    const none = withPlaces(own('g-home'), { status: 'ok', places: [] });
    await step(() => root.render(<ResourcesCard ctx={none.ctx} />));
    await press('周りを調べる');
    await press(LOOK);
    expect(text()).toContain('地図の検索では、住所と一緒に確かめられる所は出ませんでした。');
  });

  it('家の場所を地図で確かめていなければ、探す口を出さず、確かめると調べられると言う', async () => {
    const { ctx, asked } = withPlaces(own());
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await press('周りを調べる');
    expect(buttons(LOOK)).toHaveLength(0);
    expect(text()).toContain(
      '上で家の場所を地図で確かめると、候補ごとに、家から歩く時間を地図で調べられます。',
    );
    expect(asked).toEqual([]);
  });
});
