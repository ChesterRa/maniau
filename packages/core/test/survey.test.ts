// 周りの調べの確かめ（02-foundation §3.5）：候補にするのは、同じ応答で本文を読んだ頁にあった引用の物だけ。引用は照らす
// だけで候補に残さず、頁の文を写したまとめも出さない。事前の登録は Claude の読みとして添え、意味は家族が頁で確かめる
// （コードは決めない）。日数は、頁の文を見せないので出さない。
// 頁と候補は、どれも架空の物（example.invalid）。

import { describe, expect, it } from 'vitest';
import { checkSurvey, type FetchedPage, quoteOnPage, type SurveyModelOutput } from '../src';

const AT = '2026-11-05T10:00+09:00';
const KINDS = ['sickChildCare', 'temporaryCare', 'familySupport'];
const idOf = (url: string, name: string) => `${url}#${name}`;

const page: FetchedPage = {
  url: 'https://example.invalid/sick-care',
  title: 'みなと橋病児保育室のご案内（架空）',
  kind: 'text',
  retrievedAt: '2026-11-05T09:58+09:00',
  text: [
    'みなと橋病児保育室（架空）は、病気の回復期に至らないお子さんを、保護者が仕事などで',
    '家庭で保育できないときにお預かりします。',
    '利用には、事前の利用登録が必要です。登録は利用の３日前までに済ませてください。',
    '予約は利用日の前日２１時までです。',
  ].join('\n'),
};

const candidate = (
  over: Partial<SurveyModelOutput['candidates'][number]> = {},
): SurveyModelOutput['candidates'][number] => ({
  kind: 'sickChildCare',
  name: 'みなと橋病児保育室（架空）',
  area: '豊洲',
  url: page.url,
  title: null,
  summary: '病気の子を、保護者が仕事で見られない時に預かる。',
  quote: '家庭で保育できないときにお預かりします。',
  registration: { required: true, quote: '利用には、事前の利用登録が必要です。' },
  leadDays: { days: 3, quote: '登録は利用の3日前までに済ませてください。' },
  ...over,
});

describe('引用が頁の本文にあるか', () => {
  it('全角・半角と空白をそろえて比べ、8 字に満たない引用は確かめない', () => {
    expect(quoteOnPage('登録は利用の3日前までに済ませてください。', page)).toBe(true);
    expect(quoteOnPage('予約は利用日の前日 21時までです。', page)).toBe(true);
    expect(quoteOnPage('前日21時', page)).toBe(false);
    expect(quoteOnPage('登録は利用の5日前までに済ませてください。', page)).toBe(false);
    expect(quoteOnPage('家庭で保育できないときにお預かりします。', { ...page, kind: 'pdf' })).toBe(
      false,
    );
  });
});

describe('調べた候補の確かめ', () => {
  it('本文を読んだ頁に引用がある候補だけを、出典つきの資源と、登録の読み・前提の案にする（頁の文と日数は残さない）', () => {
    const { candidates, dropped } = checkSurvey(
      { candidates: [candidate()] },
      [page],
      KINDS,
      idOf,
      AT,
    );
    expect(dropped).toEqual([]);
    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c?.resource).toMatchObject({
      kind: 'sickChildCare',
      name: 'みなと橋病児保育室（架空）',
      area: '豊洲',
      use: 'candidate',
      notes: [
        {
          text: '病気の子を、保護者が仕事で見られない時に預かる。',
          source: {
            kind: 'webPage',
            url: page.url,
            title: 'みなと橋病児保育室のご案内（架空）',
            fetchedAt: '2026-11-05T09:58+09:00',
            quoteFound: true,
          },
        },
      ],
    });
    expect(c?.registration).toEqual({ required: true });
    // 前提の案は、だれの分か・済んだかを分からないとする（家族が確かめる）。
    expect(c?.preparation).toMatchObject({
      resourceId: c?.id,
      appliesTo: { kind: 'unknown' },
      state: 'unknown',
      source: { kind: 'webPage', quoteFound: true },
    });
    expect(c?.preparation).not.toHaveProperty('lead');
    // 日数は出さない（頁の文を見せないので、数字だけでは何の数か確かめられない）。前提の lead にも入れない。
    expect(c).not.toHaveProperty('leadDays');
    // 頁の文（引用）は照らすだけで、候補のどこにも残さない（見せる物・記録・家に入る物）。
    const shown = JSON.stringify(c);
    for (const quote of [
      '家庭で保育できないときにお預かりします。',
      '利用には、事前の利用登録が必要です。',
      '登録は利用の3日前までに済ませてください。',
    ]) {
      expect(shown).not.toContain(quote);
    }
    expect(shown).not.toContain('"quote"');
  });

  it('本文を読んでいない・PDF・引用が無い・頼んでいない種類の物は候補にせず、訳を返す', () => {
    const pdf: FetchedPage = { url: 'https://example.invalid/pdf', kind: 'pdf' };
    const { candidates, dropped } = checkSurvey(
      {
        candidates: [
          candidate({ name: 'A（架空）', url: 'https://example.invalid/never-read' }),
          candidate({ name: 'B（架空）', url: pdf.url }),
          candidate({ name: 'C（架空）', quote: 'この頁のどこにも無い引用の文です。' }),
          candidate({ name: 'D（架空）', kind: 'clinic' }),
        ],
      },
      [page, pdf],
      KINDS,
      idOf,
      AT,
    );
    expect(candidates).toEqual([]);
    expect(dropped.map((d) => [d.name, d.reason])).toEqual([
      ['A（架空）', 'notRead'],
      ['B（架空）', 'notRead'],
      ['C（架空）', 'quoteNotFound'],
      ['D（架空）', 'kind'],
    ]);
  });

  it('引用が本文にあっても、そろえて 8 字に満たなければ照らせない物として外す（本文に無いとは限らない）', () => {
    const short = '予約は利用日';
    expect(page.text).toContain(short);
    expect(quoteOnPage(short, page)).toBe(false);
    const { candidates, dropped } = checkSurvey(
      { candidates: [candidate({ name: 'E（架空）', quote: short })] },
      [page],
      KINDS,
      idOf,
      AT,
    );
    expect(candidates).toEqual([]);
    expect(dropped.map((d) => [d.name, d.reason])).toEqual([['E（架空）', 'quoteNotFound']]);
  });

  it('登録の引用が本文に無ければ、登録の読みも前提の案も付けない', () => {
    const [c] = checkSurvey(
      {
        candidates: [
          candidate({
            registration: { required: true, quote: '登録はいつでも窓口でできます（架空の文）。' },
            leadDays: { days: 2, quote: '登録は利用の3日前までに済ませてください。' },
          }),
        ],
      },
      [page],
      KINDS,
      idOf,
      AT,
    ).candidates;
    expect(c).toBeDefined();
    expect(c).not.toHaveProperty('registration');
    expect(c).not.toHaveProperty('preparation');
    expect(c).not.toHaveProperty('leadDays');
  });

  it('引用が本文にあっても、意味はコードで決めない（「不要」の文を「要る」と読んだ物も、家族が確かめる読みとして出す）', () => {
    const noNeed: FetchedPage = {
      url: 'https://example.invalid/temporary',
      kind: 'text',
      text: 'みなと橋一時預かり（架空）は、事前登録は不要です。当日に申し込めます。',
    };
    const [c] = checkSurvey(
      {
        candidates: [
          candidate({
            kind: 'temporaryCare',
            name: 'みなと橋一時預かり（架空）',
            url: noNeed.url,
            quote: 'みなと橋一時預かり（架空）は、事前登録は不要です。',
            registration: { required: true, quote: '事前登録は不要です。当日に申し込めます。' },
            leadDays: null,
          }),
        ],
      },
      [noNeed],
      KINDS,
      idOf,
      AT,
    ).candidates;
    // 読みをそのまま渡す（画面は Claude の読みと書き、家族が頁を開いて「要る・要らない・分からない」を選ぶ）。頁の文は渡さない。
    expect(c?.registration).toEqual({ required: true });
    expect(c?.preparation?.state).toBe('unknown');
    // 頁を読んだ時刻が応答に無ければ、この調べの時刻。
    expect(c?.resource.notes[0]?.source.fetchedAt).toBe(AT);
  });

  it('まとめが頁の文の写し（頁の本文にまとめの文がある）なら、候補にせず、訳を返す', () => {
    const { candidates, dropped } = checkSurvey(
      {
        candidates: [
          candidate({
            name: '写し（架空）',
            summary: '家庭で保育できないときにお預かりします。',
          }),
        ],
      },
      [page],
      KINDS,
      idOf,
      AT,
    );
    expect(candidates).toEqual([]);
    expect(dropped.map((d) => [d.name, d.reason])).toEqual([['写し（架空）', 'copied']]);
    // 根拠に挙げた文に言葉を足しただけのまとめも、候補にしない。
    const added = checkSurvey(
      {
        candidates: [
          candidate({
            name: '足し（架空）',
            summary: '家庭で保育できないときにお預かりします。区の事業です。',
          }),
        ],
      },
      [page],
      KINDS,
      idOf,
      AT,
    );
    expect(added.dropped.map((d) => d.reason)).toEqual(['copied']);
    // 登録・日数の引用を含むまとめも同じ（どの引用も、根拠に挙げた文）。
    for (const summary of [
      '利用には、事前の利用登録が必要です。区の事業です。',
      '登録は利用の3日前までに済ませてください。区の事業です。',
    ]) {
      const other = checkSurvey({ candidates: [candidate({ summary })] }, [page], KINDS, idOf, AT);
      expect(other.dropped.map((d) => d.reason)).toEqual(['copied']);
    }
  });

  it('同じ頁・同じ名前は一つ。前の物が外れても、後の物が確かめを通れば候補にし、外した訳を消す', () => {
    const { candidates, dropped } = checkSurvey(
      {
        candidates: [
          candidate({ quote: 'この頁のどこにも無い引用の文です。' }),
          candidate(),
          candidate(),
        ],
      },
      [page],
      KINDS,
      idOf,
      AT,
    );
    expect(candidates).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});
