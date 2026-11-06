// @vitest-environment happy-dom
// 名前だけの試用の「家の場所」：地域の欄（家に残し、周りを調べる時に Claude に送る）と番地の欄（地域の欄と合わせて
// 地図の照会にだけ）。送る前に、残して送る文をそのまま見せ、番地に見える書き方は地域の欄で受けない。地図で見つけた所は
// 家族が「合っている」を押した時だけ入れる。名前だけの試用の調べは、家の場所を入れてから Claude にいま頼む（記録した
// 見本の調べは使わない）。住所は公共の施設の物（区が公開している江東区役所の所在地）。偽物の口だけ（通信しない）。
import { Household, type SurveyShown } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HomeSetResult } from '../src/family';
import i18n from '../src/i18n';
import { ResourcesCard } from '../src/resources';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

const own = (home?: { area: string; googlePlaceId?: string }) =>
  Household.parse({
    id: 'trial-own',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a1', kind: 'adult', name: '大人A' },
      { id: 'c1', kind: 'child', name: '子H' },
    ],
    places: home ? [{ id: 'home', kind: 'home', name: '家', ...home }] : [],
    routines: [],
    careOptions: [],
  });

const SHOWN: SurveyShown = {
  area: '東京都江東区東陽',
  at: '2026-11-06T15:00+09:00',
  recorded: false,
  candidates: [],
  dropped: [],
};

function withHome(
  household: Household,
  options: { result?: HomeSetResult; live?: boolean; maps?: boolean; lang?: 'ja' | 'en' } = {},
) {
  const sets: [string, string][] = [];
  const confirms: string[] = [];
  const runs: boolean[] = [];
  const lang = options.lang ?? 'ja';
  const ctx = {
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[0],
    household,
    t: i18n.getFixedT(lang),
    send: async () => ({ status: 'ok' }),
    ownTrial: true,
    home: {
      set: async (area: string, detail: string) => {
        sets.push([area, detail]);
        return options.result ?? { status: 'ok' };
      },
      confirm: async (id: string) => {
        confirms.push(id);
        return 'ok' as const;
      },
      maps: options.maps ?? true,
    },
    survey: {
      run: async (live: boolean) => {
        runs.push(live);
        return { status: 'ok', survey: SHOWN };
      },
      recorded: true,
      live: options.live ?? true,
    },
    previewHousehold: async () => undefined,
    go: () => undefined,
  } as unknown as Ctx;
  return { ctx, sets, confirms, runs };
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
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const press = async (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`押す物が無い：${label}`);
  await step(() => found.click());
};
const field = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector('input') ?? undefined;
async function enter(label: string, value: string) {
  const element = field(label);
  if (!element) throw new Error(`欄が無い：${label}`);
  await step(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const AREA = '都道府県・市区町村・町名';
const DETAIL = '丁目・番地（建物名・部屋番号は要りません）';
const SET = 'この住所で家の場所を入れる';

describe('名前だけの試用の家の場所', () => {
  it('家の場所が無い間は二つの欄と送り先の説明を出し、調べる口は出さない', async () => {
    const { ctx } = withHome(own());
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    expect(field(AREA)).toBeDefined();
    expect(field(DETAIL)).toBeDefined();
    expect(text()).toContain(
      '上の欄に打った文は、空白を除いて家の情報に残し、周りを調べる時に Claude に送ります。',
    );
    expect(text()).toContain('下の欄は、上の欄と合わせて、地図（Google）で場所を探すのにだけ送り');
    expect(text()).toContain(
      '上で家の場所を入れると、その地域の周りを Claude に調べてもらえます。',
    );
    expect(button('周りを調べる')).toBeUndefined();
    expect(button(SET)?.disabled).toBe(true);
  });

  it('残して送る文をそのまま見せる。番地に見える書き方・市区町村の無い物は、地域の欄で受けない', async () => {
    const { ctx, sets } = withHome(own());
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await enter(AREA, '東京都江東区東陽4-11-28');
    expect(text()).toContain(
      '下の欄に入れてください（数字の入る町名、例えば「北5条西」も下の欄へ）。',
    );
    expect(button(SET)?.disabled).toBe(true);
    await enter(AREA, '豊洲');
    expect(text()).toContain('上の欄は、市区町村から入れてください');
    expect(button(SET)?.disabled).toBe(true);
    await enter(AREA, '東京都江東区東陽');
    expect(text()).toContain('Claude に送るのは、上の欄の「東京都江東区東陽」です。');
    expect(button(SET)?.disabled).toBe(false);
    expect(sets).toEqual([]);
  });

  it('二つの欄を送り、地図の候補を見せて、合っていると押した時だけ確かめる。送った後は欄を空にする', async () => {
    const { ctx, sets, confirms } = withHome(own(), {
      result: {
        status: 'ok',
        candidate: { id: 'cand-1', address: '日本、〒135-0016 東京都江東区東陽４丁目１１−２８' },
      },
    });
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await enter(AREA, '東京都江東区東陽');
    await enter(DETAIL, '4-11-28');
    await press(SET);
    expect(sets).toEqual([['東京都江東区東陽', '4-11-28']]);
    expect(text()).toContain(
      '地図で見つけた場所：日本、〒135-0016 東京都江東区東陽４丁目１１−２８',
    );
    expect(text()).toContain('地図のデータ：Google');
    expect(field(AREA)?.value).toBe('');
    expect(field(DETAIL)?.value).toBe('');
    expect(confirms).toEqual([]);
    await press('この場所で合っている');
    expect(confirms).toEqual(['cand-1']);
    expect(text()).not.toContain('地図で見つけた場所');
  });

  it('違う所だったと押せば確かめず、地域だけだと言う。地図で見つからなかった時もそう言う', async () => {
    const found = withHome(own(), {
      result: { status: 'ok', candidate: { id: 'cand-1', address: '架空の住所' } },
    });
    await step(() => root.render(<ResourcesCard ctx={found.ctx} />));
    await enter(AREA, '東京都江東区東陽');
    await enter(DETAIL, '4-11-28');
    await press(SET);
    await press('違う所だった');
    expect(found.confirms).toEqual([]);
    expect(text()).toContain('地図の場所は入れませんでした。家の場所は、地域だけです。');

    const missing = withHome(own(), { result: { status: 'ok' } });
    await step(() => root.render(<ResourcesCard ctx={missing.ctx} />));
    await enter(AREA, '東京都江東区東陽');
    await enter(DETAIL, '4-11-28');
    await press(SET);
    expect(text()).toContain(
      '地図では、確かめられる場所を見つけられませんでした。家の場所は、地域だけで入れました。',
    );
  });

  it('地図を使わないサーバーでは、番地の欄を出さず、番地を送らない', async () => {
    const { ctx, sets } = withHome(own(), { maps: false });
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    expect(text()).toContain('このサーバーでは地図を使わないので、丁目・番地は入れません。');
    expect(field(DETAIL)).toBeUndefined();
    await enter(AREA, '東京都江東区東陽');
    await press(SET);
    expect(sets).toEqual([['東京都江東区東陽', '']]);
  });

  it('家の場所を入れた後は地域と地図の確かめを見せ、調べは記録した見本でなく Claude にいま頼む', async () => {
    const { ctx, runs } = withHome(own({ area: '東京都江東区東陽', googlePlaceId: 'g-home' }));
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    expect(text()).toContain('家の場所：東京都江東区東陽');
    expect(text()).toContain('この試用には、その場所を指す地図の ID を残しています');
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('地図で見る'));
    expect(link?.getAttribute('href')).toContain('query_place_id=g-home');
    expect(field(AREA)).toBeUndefined();
    await press('周りを調べる');
    expect(runs).toEqual([true]);
    expect(text()).toContain('東京都江東区東陽 の周りを');
    await press('住所を入れ直す');
    expect(field(AREA)).toBeDefined();
  });

  it('Claude にいま頼めないサーバーでは、名前だけの試用の調べの口を出さない（見本の記録を使わない）', async () => {
    const { ctx, runs } = withHome(own({ area: '東京都江東区東陽' }), { live: false });
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    expect(text()).toContain('このサーバーでは、いま Claude に調べてもらえません。');
    expect(button('周りを調べる')).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('英語の画面でも、二つの欄と送り先を言う', async () => {
    const { ctx } = withHome(own(), { lang: 'en' });
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    expect(text()).toContain('Prefecture, city or ward, and town (in Japanese)');
    expect(text()).toContain(
      'The lower field is sent, together with the top field, only to the map (Google)',
    );
  });
});
