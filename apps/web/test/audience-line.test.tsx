// 読み取りが書いた対象（例：1年生）を、確かめる札と持ち物の問いに一行で見せる。モデルの読みなので「読み取り」と
// 書き、対象で札を隠さない。根拠が二つ以上なら、読んだ対象を全部並べる（一つ目だけを全部の対象に見せない）。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';

const text = (html: string) => html.replace(/<[^>]+>/g, '');

const item = (id: string, audience?: string) => ({
  id,
  sourceId: 'n1',
  sentenceIds: ['n1#1'],
  kind: 'belongings',
  written: '体操服を持ってきてください。',
  interpretation: { what: '体操服', ...(audience ? { audience } : {}) },
  evidence: 'stated',
  effects: [],
});

/** 持ち物の問い一枚だけの画面の材料（根拠の事項を選べる）。 */
function questionCtx(items: ReturnType<typeof item>[], lang: 'ja' | 'en' = 'ja'): Ctx {
  const requirement = {
    key: 'req:belongings:n1',
    kind: 'belongings',
    what: '体操服',
    by: '2026-12-18T08:00+09:00',
    basis: { itemIds: items.map((i) => i.id) },
    live: true,
    atHomeUnknownId: 'u-atHome:n1',
  };
  const question = { key: 'q:n1', unknownId: requirement.atHomeUnknownId };
  return {
    household: {
      members: [{ id: 'a', kind: 'adult', name: '彩' }],
      places: [],
      careOptions: [],
      ways: [],
    },
    me: { id: 'a', kind: 'adult', name: '彩' },
    plan: {
      throughSeq: 7,
      requirements: [requirement],
      arrangements: [],
      tasks: [],
      requests: [],
      questions: [question],
    },
    today: { main: [{ kind: 'question' as const, question, requirement }], quiet: [] },
    items: items.map((i) => ({ item: i, live: true, conditional: false, trusted: true })),
    sources: new Map([['n1', { id: 'n1', sender: 'school', sentences: [] }]]),
    readings: [],
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:00+09:00',
    t: i18n.getFixedT(lang),
    outbound: (lng: string) => i18n.getFixedT(lng),
    go: () => {},
    send: async () => ({ status: 'ok' as const }),
  } as unknown as Ctx;
}

it('持ち物の問い：読み取りの対象を「読み取り」と書いて一行で見せる（日英）', () => {
  const ja = text(
    renderToStaticMarkup(<TodayScreen ctx={questionCtx([item('n1:i1', '3年生')])} />),
  );
  expect(ja).toContain('対象（読み取り）：3年生');
  const en = text(
    renderToStaticMarkup(<TodayScreen ctx={questionCtx([item('n1:i1', '3年生')], 'en')} />),
  );
  expect(en).toContain('For (as read): 3年生');
});

it('持ち物の問い：根拠が二つなら、読んだ対象を両方並べる。対象を読んでいなければ出さない', () => {
  const both = text(
    renderToStaticMarkup(
      <TodayScreen ctx={questionCtx([item('n1:i1', '1年生'), item('n1:i2', '全学年')])} />,
    ),
  );
  expect(both).toContain('対象（読み取り）：1年生、全学年');
  const none = text(renderToStaticMarkup(<TodayScreen ctx={questionCtx([item('n1:i1')])} />));
  expect(none).not.toContain('対象（読み取り）');
});
