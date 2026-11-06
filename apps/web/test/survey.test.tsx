// @vitest-environment happy-dom
// 「周りを調べる」（02-foundation §3.5）：調べた候補を、出典の頁（リンク）・Claude の読みと一緒に見せ（頁の文は出さない）、家族が扱い・登録・
// だれの分・前提にするやり方を選んで「この家の候補にする」と、保存の前の確かめに渡す（何も書かない）。登録が要るかは
// Claude の読みで、家族が選ぶ。資源は場所に結んで入れ、前提にするやり方の頼む先は替えない。この所に頼むやり方は、
// 入れた後に、今のやり方を写して作る（やり方の表へ）。候補は架空の物（example.invalid）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Household, type SurveyCandidate, type SurveyShown } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { copyBases, ResourcesCard, withCandidate } from '../src/resources';
import type { Ctx, Route } from '../src/screens';
import { step } from './fake-fetch';

const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);

const CANDIDATE: SurveyCandidate = {
  id: 'res-aaaaaaaaaaaa',
  resource: {
    id: 'res-aaaaaaaaaaaa',
    kind: 'sickChildCare',
    name: 'みなと橋病児保育室（架空）',
    area: '豊洲',
    notes: [
      {
        text: '病気の子を、保護者が仕事で見られない時に預かる。',
        source: {
          kind: 'webPage',
          url: 'https://example.invalid/sick-care',
          title: 'みなと橋病児保育室のご案内（架空）',
          fetchedAt: '2026-11-05T09:58+09:00',
          quoteFound: true,
        },
      },
    ],
    use: 'candidate',
  },
  registration: { required: true },
  preparation: {
    id: 'prep-res-aaaaaaaaaaaa',
    name: 'みなと橋病児保育室（架空）の事前の登録',
    resourceId: 'res-aaaaaaaaaaaa',
    source: {
      kind: 'webPage',
      url: 'https://example.invalid/sick-care',
      fetchedAt: '2026-11-05T09:58+09:00',
      quoteFound: true,
    },
    appliesTo: { kind: 'unknown' },
    state: 'unknown',
  },
};

const SHOWN: SurveyShown = {
  area: '豊洲（豊洲駅）',
  at: '2026-11-05T10:00+09:00',
  recorded: true,
  candidates: [CANDIDATE],
  dropped: [
    { url: 'https://example.invalid/x', name: 'X', reason: 'notRead' },
    { url: 'https://example.invalid/y', name: 'Y', reason: 'quoteNotFound' },
  ],
};

function withSurvey(lang: 'ja' | 'en', shown: SurveyShown = SHOWN) {
  const runs: { live: boolean }[] = [];
  const looked: Household[] = [];
  const went: Route[] = [];
  const ctx = {
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[1],
    household,
    t: i18n.getFixedT(lang),
    send: async () => ({ status: 'ok' }),
    survey: {
      run: async (live: boolean) => {
        runs.push({ live });
        return { status: 'ok', survey: shown };
      },
      recorded: true,
      live: true,
    },
    previewHousehold: async (next: Household) => {
      looked.push(next);
      return undefined;
    },
    go: (route: Route) => went.push(route),
  } as unknown as Ctx;
  return { ctx, runs, looked, went };
}

/** 候補を、場所に結んで入れた後の家（入れた時と同じ形）。 */
const PLACE = {
  id: 'place-aaaaaaaaaaaa',
  kind: 'other' as const,
  name: CANDIDATE.resource.name,
  area: '豊洲',
  goods: [],
};
const addedHousehold = (use: 'candidate' | 'notUsed' = 'notUsed'): Household => ({
  ...household,
  places: [...household.places, PLACE],
  resources: [...household.resources, { ...CANDIDATE.resource, placeId: PLACE.id, use }],
});

const buttons = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(text));
const click = async (host: HTMLElement, text: string, index = 0) => {
  const button = buttons(host, text)[index];
  if (!button) throw new Error(`押す物が無い：${text}`);
  await step(() => button.click());
};
/** 調べを開いて、まだ家に入れていない候補の決める欄を開く（入れた候補は、はじめから開いている）。 */
const survey = async (host: HTMLElement) => {
  await click(host, '周りを調べる');
  const open = buttons(host, 'この家での扱いを決める')[0];
  if (open) await step(() => open.click());
};

describe('周りを調べる', () => {
  it('まだ入れていない候補は、何が見つかったかを先に見せ、決める欄は押した時だけ開く', async () => {
    const { ctx } = withSurvey('ja');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await click(host, '周りを調べる');
    // 見つかった物（名前・まとめ・出典・登録の読み）は出し、扱い・登録・やり方の欄はまだ出さない。
    expect(host.textContent).toContain('みなと橋病児保育室（架空）');
    expect(host.textContent).toContain('Claude のまとめ：');
    expect(buttons(host, '要る（確かめた）')).toHaveLength(0);
    expect(buttons(host, 'この家の候補にする')).toHaveLength(0);
    await click(host, 'この家での扱いを決める');
    expect(buttons(host, '要る（確かめた）')).toHaveLength(1);
    expect(buttons(host, 'この家の候補にする')).toHaveLength(1);
    expect(buttons(host, 'この家での扱いを決める')).toHaveLength(0);
    root.unmount();
  });

  it('記録した調べを見せ、家族が登録・だれの分・やり方を選んで、確かめに渡す', async () => {
    const { ctx, runs, looked } = withSurvey('ja');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await survey(host);
    expect(runs).toEqual([{ live: false }]);
    const text = host.textContent ?? '';
    expect(text).toContain('豊洲（豊洲駅） の周りを 11/5（木） に Claude が調べて記録した結果です');
    // 残さないと言うのは、頁の全文と引用の欄だけ（まとめは頁の言葉を含みうる）。
    expect(text).toContain('頁の全文と、引用として抜き出した文の欄は残していません');
    // 何が見つかったかを、候補より先に言う。要の限りは見せたまま、照らし方の細部はたたむ。
    expect(text).toContain('根拠の文を照らして出す候補は 1 件です。');
    expect(text.indexOf('根拠の文を照らして出す候補は 1 件です。')).toBeLessThan(
      text.indexOf('みなと橋病児保育室（架空）'),
    );
    expect(text).toContain(
      'その文がまとめを支えるか・読みが正しいか・頁が公式か・中身が今も正しいかは確かめていないので、リンク先で確かめてください',
    );
    const how = [...host.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === '照らし方',
    );
    expect(how?.open).toBe(false);
    expect(how?.textContent).toContain('全角・半角と空白をそろえて、コードが照らします');
    expect(how?.textContent).toContain('その文がそろえて 8 字以上なら出しません');
    expect(text).toContain('みなと橋病児保育室（架空）');
    expect(text).toContain('Claude のまとめ：病気の子を、保護者が仕事で見られない時に預かる。');
    expect(text).toContain(
      '出典の頁：みなと橋病児保育室のご案内（架空）（11/5（木） に読んだ頁。Claude が根拠に挙げた文が頁の本文にあることを、コードが照らしました。その文がまとめを支えるかは確かめていません）',
    );
    expect(text).toContain(
      'Claude の読み：使う前に事前の登録が要る。根拠に挙げた文が頁にあることだけを照らし、意味は確かめていません。頁を開いて確かめてください。',
    );
    // 頁の文は出さない（照らした結果と、頁へのリンクだけ）。日数も出さない。
    expect(how?.textContent).toContain('引用として抜き出した文の欄は、ここに出さず、残しません');
    expect(text).toContain('頁の言葉や文を含むことがあります');
    expect(text).not.toContain('「利用には');
    expect(text).not.toContain('日数');
    expect(text).toContain(
      '出していない候補は 2 件です（頁の本文を読めなかった 1 件、根拠に挙げた文を頁の本文で照らせなかった 1 件）',
    );
    const link = host.querySelector('a[href="https://example.invalid/sick-care"]');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    // 登録を決めるまでは、やり方の前提にできない。
    const way = () =>
      [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('病児保育に預ける'));
    expect(host.textContent).toContain(
      '前提にするには、事前の登録を「要る」か「同じ登録」にしてください',
    );
    expect(way()?.querySelector('input')?.disabled).toBe(true);
    expect(host.textContent).not.toContain('代わりにする');
    // 登録は要ると確かめ、陽菜の分。病児保育のやり方の前提にする（頼む先は替えない）。
    await click(host, '要る（確かめた）');
    await click(host, '陽菜');
    expect(host.textContent).toContain(
      'この登録を前提にするやり方（前提を足すだけで、頼む先・行く所は替えません）',
    );
    await step(() => way()?.querySelector('input')?.click());
    await click(host, 'この家の候補にする');
    expect(looked).toHaveLength(1);
    const next = looked[0];
    // 資源は、同じ名前の新しい場所（施設）に結ぶ。
    expect(next?.places.find((p) => p.id === PLACE.id)).toEqual(PLACE);
    expect(next?.resources.find((r) => r.id === CANDIDATE.id)).toMatchObject({
      placeId: PLACE.id,
      use: 'candidate',
    });
    expect(next?.preparations.find((p) => p.id === CANDIDATE.preparation?.id)).toMatchObject({
      appliesTo: { kind: 'members', memberIds: ['c'] },
      state: 'unknown',
    });
    // やり方は前提が増えるだけ：使う資源・頼む先は前のまま。
    const sickCare = next?.ways.find((w) => w.id === 'way-sick-care');
    expect(sickCare).toMatchObject({
      requires: ['prep-sick-care', CANDIDATE.preparation?.id],
      resourceIds: ['res-sick-care'],
    });
    expect(sickCare?.steps).toEqual(household.ways.find((w) => w.id === 'way-sick-care')?.steps);
    await step(() => root.unmount());
  });

  it('入れた後（画面を開き直しても）：今のやり方を写して、この所を使う表へ。資源と場所の無い候補には出さない', async () => {
    const { ctx, looked, went } = withSurvey('ja');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={{ ...ctx, household: addedHousehold() }} />));
    await survey(host);
    expect(host.textContent).toContain('家の情報に入っています');
    expect(buttons(host, 'この家の候補にする')).toHaveLength(0);
    expect(host.textContent).toContain(
      '時間・費用・期限は前の所の値を使わず、この所の頁で確かめて入れます',
    );
    await click(
      host,
      '「病児保育に預ける」を写して、みらい橋病児保育室（架空）の代わりにこの所で使う',
    );
    expect(went).toEqual([
      {
        name: 'way',
        copy: { wayId: 'way-sick-care', resourceId: CANDIDATE.id, insteadOf: 'res-sick-care' },
      },
    ]);
    expect(looked).toHaveLength(0);
    await step(() => root.unmount());
    // 場所に結ばずに入れた候補（同じ名前の場所を、同じ所と確かめなかった等）には、写す手を出さない。
    const unplaced = {
      ...household,
      resources: [...household.resources, { ...CANDIDATE.resource, use: 'notUsed' as const }],
    };
    expect(copyBases(unplaced, CANDIDATE)).toEqual([]);
    const again = document.createElement('div');
    const second = createRoot(again);
    await step(() => second.render(<ResourcesCard ctx={{ ...ctx, household: unplaced }} />));
    await survey(again);
    expect(again.textContent).toContain(
      '場所に結んでいないので、やり方の頼む先・行く所には使えません',
    );
    expect(buttons(again, '写して')).toHaveLength(0);
    await step(() => second.unmount());
  });

  it('もう入れた候補も出し、扱いと場所は替えずに、後から登録と前提を確かめられる', async () => {
    const { ctx, looked } = withSurvey('ja');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={{ ...ctx, household: addedHousehold() }} />));
    await survey(host);
    // 「同じ登録」に選べるのは、ほかの資源の登録だけ。
    expect(buttons(host, '病児保育の事前登録と同じ登録')).toHaveLength(1);
    await click(host, '要る（確かめた）');
    await click(host, '登録と前提を確かめる');
    const next = looked[0];
    expect(next?.resources.filter((r) => r.id === CANDIDATE.id)).toEqual([
      { ...CANDIDATE.resource, placeId: PLACE.id, use: 'notUsed' },
    ]);
    expect(next?.places.filter((p) => p.id === PLACE.id)).toHaveLength(1);
    expect(next?.preparations.filter((p) => p.id === CANDIDATE.preparation?.id)).toHaveLength(1);
    await step(() => root.unmount());
    // この候補の登録を入れた後も、それを「同じ登録」には出さない（この候補の登録は「要る」）。
    const own = document.createElement('div');
    const second = createRoot(own);
    const withPrep = {
      ...addedHousehold(),
      preparations: [
        ...household.preparations,
        ...(CANDIDATE.preparation ? [CANDIDATE.preparation] : []),
      ],
    };
    await step(() => second.render(<ResourcesCard ctx={{ ...ctx, household: withPrep }} />));
    await survey(own);
    expect(buttons(own, 'みなと橋病児保育室（架空）の事前の登録と同じ登録')).toHaveLength(0);
    expect(buttons(own, '病児保育の事前登録と同じ登録')).toHaveLength(1);
    await step(() => second.unmount());
  });

  it('同じ名前の場所が家にある時は、家族が「同じ所」と確かめた時だけ、その場所に結ぶ', async () => {
    const own = {
      id: 'own-place',
      kind: 'other' as const,
      name: CANDIDATE.resource.name,
      goods: [],
    };
    const withOwn = { ...household, places: [...household.places, own] };
    const { ctx, looked } = withSurvey('ja');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={{ ...ctx, household: withOwn }} />));
    await survey(host);
    expect(host.textContent).toContain('同じ所と確かめなければ、場所に結ばずに入れます');
    await click(host, 'この家の候補にする');
    expect(looked[0]?.resources.find((r) => r.id === CANDIDATE.id)).not.toHaveProperty('placeId');
    expect(looked[0]?.places).toEqual(withOwn.places);
    await step(() => root.unmount());
    // 開き直して、同じ所と確かめてから入れる。
    const again = document.createElement('div');
    const second = createRoot(again);
    await step(() => second.render(<ResourcesCard ctx={{ ...ctx, household: withOwn }} />));
    await survey(again);
    await click(again, `家の情報の「${own.name}」と同じ所です`);
    await click(again, 'この家の候補にする');
    expect(looked[1]?.resources.find((r) => r.id === CANDIDATE.id)).toMatchObject({
      placeId: own.id,
    });
    expect(looked[1]?.places).toEqual(withOwn.places);
    await step(() => second.unmount());
    // 確かめずに入れた後でも（開き直しても）、後から同じ所と確かめて結べる。結んだら、写す手が出る。
    const unlinked = {
      ...withOwn,
      resources: [...withOwn.resources, { ...CANDIDATE.resource, use: 'candidate' as const }],
    };
    const later = document.createElement('div');
    const third = createRoot(later);
    await step(() => third.render(<ResourcesCard ctx={{ ...ctx, household: unlinked }} />));
    await survey(later);
    expect(later.textContent).toContain(
      '場所に結んでいないので、やり方の頼む先・行く所には使えません',
    );
    await click(later, `家の情報の「${own.name}」と同じ所です`);
    await click(later, '登録と前提を確かめる');
    expect(looked[2]?.resources.filter((r) => r.id === CANDIDATE.id)).toEqual([
      { ...CANDIDATE.resource, use: 'candidate', placeId: own.id },
    ]);
    expect(looked[2]?.places).toEqual(withOwn.places);
    await step(() => third.unmount());
    const linked = createRoot(later);
    await step(() =>
      linked.render(<ResourcesCard ctx={{ ...ctx, household: looked[2] ?? unlinked }} />),
    );
    await survey(later);
    expect(buttons(later, '写して')).toHaveLength(1);
    expect(buttons(later, '同じ所です')).toHaveLength(0);
    await step(() => linked.unmount());
  });

  it('出せる候補が無い時は、出せる物が無いとだけ言い、外した訳は別に言う（照らせなかったとは言わない）', async () => {
    // 根拠の文は照らせたが、まとめが頁の文を写していたので外した物だけ（copied）。
    for (const [shown, reasons] of [
      [
        {
          ...SHOWN,
          candidates: [],
          dropped: [{ url: 'https://example.invalid/z', name: 'Z', reason: 'copied' as const }],
        },
        '出していない候補は 1 件です（まとめが頁の文そのものか、根拠に挙げた文を含んでいた 1 件）',
      ],
      [{ ...SHOWN, candidates: [], dropped: [] }, undefined],
    ] as const) {
      const { ctx } = withSurvey('ja', shown);
      const host = document.createElement('div');
      const root = createRoot(host);
      await step(() => root.render(<ResourcesCard ctx={ctx} />));
      await click(host, '周りを調べる');
      const text = host.textContent ?? '';
      expect(text).toContain('出せる候補はありませんでした。');
      expect(text).not.toContain('照らせた候補');
      expect(text).not.toContain('照らして出す候補は');
      expect(text).not.toContain('確かめられなかった');
      if (reasons) expect(text).toContain(reasons);
      else expect(text).not.toContain('出していない候補');
      await step(() => root.unmount());
    }
    const { ctx } = withSurvey('en', { ...SHOWN, candidates: [], dropped: [] });
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await click(host, 'Look around us');
    expect(host.textContent).toContain('No candidates are shown.');
    await step(() => root.unmount());
  });

  it('英語でも同じことを出す', async () => {
    const { ctx } = withSurvey('en');
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    await click(host, 'Look around us');
    await click(host, 'Decide how your family treats it');
    const text = host.textContent ?? '';
    expect(text).toContain('What Claude found around 豊洲（豊洲駅） on');
    expect(text).toContain('the full page text and separate quote fields aren’t kept');
    expect(text).toContain(
      '1 candidate is shown after checking its cited sentence against its page.',
    );
    expect(text).toContain(
      'not whether it supports the summary or the reading, or whether the page is official or still correct',
    );
    expect(text).toContain('Claude’s summaries are in Japanese');
    const how = [...host.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'How we checked',
    );
    expect(how?.open).toBe(false);
    expect(how?.textContent).toContain('8 or more normalized characters');
    expect(text).toContain('Claude’s reading: you must register in advance before using it');
    expect(text).toContain(
      'Not shown: 2 (1 whose page text couldn’t be read, 1 whose cited sentence couldn’t be checked against the page text).',
    );
    expect(text).toContain('Needed (I checked)');
    expect(text).toContain('Add as a candidate for us');
    await step(() => root.unmount());
  });

  it('上限で断られた時は、この試用の分かサーバー全体の分かを言い切らず、両方の戻り方を言う', async () => {
    // サーバーは、この試用の 3 回とサーバー全体の一日の回数を、同じ知らせ（上限）で断る。初めての試用でも、
    // サーバー全体の分で断られることがある。試用の操作に無い「やり直す」も挙げない。
    for (const [lang, label, serverWide, notSaid] of [
      ['ja', '周りを調べる', 'サーバー全体の分は、翌日（UTC）に戻ります。', 'このデモで'],
      ['en', 'Look around us', 'The server-wide limit resets the next day (UTC).', 'This demo has'],
    ] as const) {
      const { ctx } = withSurvey(lang);
      const limited = {
        ...ctx,
        survey: { ...ctx.survey, recorded: false, run: async () => ({ status: 'limit' }) },
      } as unknown as Ctx;
      const host = document.createElement('div');
      const root = createRoot(host);
      await step(() => root.render(<ResourcesCard ctx={limited} />));
      await click(host, label);
      const text = host.textContent ?? '';
      expect(text).toContain(serverWide);
      expect(text).toContain(lang === 'ja' ? '新しく始めると戻ります' : 'start a new one');
      expect(text).not.toContain(notSaid);
      expect(text).not.toContain(i18n.getFixedT(lang)('demo.restart'));
      await step(() => root.unmount());
    }
  });
});

describe('候補を入れた後の家', () => {
  const base = {
    use: 'usual' as const,
    appliesTo: { kind: 'unknown' as const },
    wayIds: ['way-sick-care'],
  };
  const sickCare = household.ways.find((w) => w.id === 'way-sick-care');

  it('資源は新しい場所に結んで入れる。「まだ分からない」なら前提を入れず、やり方も替えない', () => {
    const next = withCandidate(household, CANDIDATE, { ...base, registration: 'unsure' });
    expect(next.preparations).toEqual(household.preparations);
    expect(next.ways).toEqual(household.ways);
    expect(next.resources.find((r) => r.id === CANDIDATE.id)).toMatchObject({
      use: 'usual',
      placeId: PLACE.id,
    });
    expect(next.places.at(-1)).toEqual(PLACE);
  });

  it('「同じ登録」なら、もう入れてある前提を、選んだやり方の前提にする（新しく作らない。資源・頼む先は替えない）', () => {
    const next = withCandidate(household, CANDIDATE, {
      ...base,
      registration: 'same',
      sameAs: 'prep-sick-care',
      wayIds: ['way-grandma'],
    });
    expect(next.preparations).toHaveLength(household.preparations.length);
    const grandma = household.ways.find((w) => w.id === 'way-grandma');
    expect(next.ways.find((w) => w.id === 'way-grandma')).toEqual({
      ...grandma,
      requires: ['prep-sick-care'],
    });
  });

  it('「要らない」なら、やり方に何も足さない', () => {
    const next = withCandidate(household, CANDIDATE, { ...base, registration: 'no' });
    expect(next.ways).toEqual(household.ways);
  });

  it('Claude の読みの無い候補でも、家族が「要る」とすれば、出典の無い登録の案を入れ、前提にする', () => {
    const { preparation: _p, registration: _r, ...plain } = CANDIDATE;
    const next = withCandidate(household, plain, {
      ...base,
      registration: 'new',
      appliesTo: { kind: 'members', memberIds: ['c'] },
    });
    const added = next.preparations.at(-1);
    expect(added).toEqual({
      id: `prep-${CANDIDATE.id}`,
      name: 'みなと橋病児保育室（架空）の事前の登録',
      resourceId: CANDIDATE.id,
      appliesTo: { kind: 'members', memberIds: ['c'] },
      state: 'unknown',
    });
    expect(next.ways.find((w) => w.id === 'way-sick-care')).toEqual({
      ...sickCare,
      requires: ['prep-sick-care', added?.id],
    });
  });

  it('もう入れた資源・場所・登録は重ねて入れず、家族の扱いとだれの分を替えずに、前提にする', () => {
    const once = withCandidate(household, CANDIDATE, {
      ...base,
      use: 'notUsed',
      registration: 'new',
      appliesTo: { kind: 'members', memberIds: ['c'] },
      wayIds: [],
    });
    const again = withCandidate(once, CANDIDATE, {
      ...base,
      registration: 'new',
      appliesTo: { kind: 'household' },
    });
    expect(again.resources.filter((r) => r.id === CANDIDATE.id)).toEqual([
      { ...CANDIDATE.resource, placeId: PLACE.id, use: 'notUsed' },
    ]);
    expect(again.places.filter((p) => p.id === PLACE.id)).toHaveLength(1);
    expect(again.preparations.filter((p) => p.id === CANDIDATE.preparation?.id)).toEqual([
      { ...CANDIDATE.preparation, appliesTo: { kind: 'members', memberIds: ['c'] } },
    ]);
    expect(again.ways.find((w) => w.id === 'way-sick-care')?.requires).toEqual([
      'prep-sick-care',
      CANDIDATE.preparation?.id,
    ]);
  });

  it('選んでいないやり方は替えない', () => {
    const next = withCandidate(household, CANDIDATE, { ...base, registration: 'new', wayIds: [] });
    expect(next.ways).toEqual(household.ways);
    expect(next.preparations.at(-1)?.id).toBe(CANDIDATE.preparation?.id);
  });

  it('写す元は、同じ種類の資源を使うやり方と、その資源（場所に結んで入れた後だけ）', () => {
    expect(copyBases(household, CANDIDATE)).toEqual([]);
    const bases = copyBases(addedHousehold(), CANDIDATE);
    expect(bases.map((b) => [b.way.id, b.instead.id])).toEqual([
      ['way-sick-care', 'res-sick-care'],
    ]);
  });
});
