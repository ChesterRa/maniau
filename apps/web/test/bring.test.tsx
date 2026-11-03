// @vitest-environment happy-dom
// 持って行く物：使う日の前の日と使う日に「きょう」に静かに出す。家にあると答えた物は「やっぱり無かった」、
// 用意の締切の後に無いと答えた物は「用意できた」と、答えられる間は答え直せ、見せた品物と計画の版を付けて送る。
// 買い終えた物は答え直さない。どのお知らせの物かを示し、元の文へ戻れる（同じ品物を同じ日に求めるお知らせが
// 二つあっても、答え直す物を見分けられる）。変わったことの札は、持ち物の使う日と用意の締切のうち、変わった
// 方を見せる（両方が別々に変われば両方）。
import type { ChangeSummary, Command, Requirement } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import type { Route } from '../src/screens';
import { TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const shirtFrom = (itemId: string): Requirement => ({
  key: `req:belongings:${itemId}`,
  kind: 'belongings',
  what: '白い長袖シャツ',
  date: '2026-12-05',
  by: '2026-12-05T08:00+09:00',
  nature: 'required',
  basis: { itemIds: [itemId], requirementKey: `req:belongings:${itemId}` },
  live: true,
  atHomeUnknownId: `u-atHome:${itemId}`,
  atHome: 'yes',
});
const school = shirtFrom('n1:i5');
const club = shirtFrom('u1:i1');
const socks = (date: string, by: string): Requirement => ({
  key: 'req:belongings:n7:h1',
  kind: 'belongings',
  what: '白い靴下',
  date,
  by,
  nature: 'required',
  basis: { itemIds: ['n7:h1'], requirementKey: 'req:belongings:n7:h1' },
  live: true,
  atHomeUnknownId: 'u-atHome:n7:h1',
});

type Card = { requirement: Requirement; bought: boolean; reanswer: boolean };

async function render(cards: Card[], changes?: ChangeSummary) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const sent: Command[] = [];
  const routes: Route[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-12-04T09:00+09:00',
    me: { id: 'a', name: '健太', kind: 'adult' },
    household: { members: [{ id: 'a', name: '健太', kind: 'adult' }] },
    plan: {
      throughSeq: 42,
      tasks: [],
      requirements: cards.map((c) => c.requirement),
      arrangements: [],
      requests: [],
    },
    today: { main: [], quiet: cards.map((c) => ({ kind: 'bring', ...c })) },
    ...(changes ? { changes } : {}),
    items: [
      { item: { id: 'n1:i5', sourceId: 'n1', sentenceIds: ['n1#3'], interpretation: {} } },
      { item: { id: 'u1:i1', sourceId: 'u1', sentenceIds: ['u1#1'], interpretation: {} } },
      {
        item: {
          id: 'n7:h1',
          sourceId: 'n7',
          sentenceIds: ['n7#1'],
          interpretation: { what: '白い靴下', deadline: '2026-12-02T17:00+09:00' },
        },
      },
    ],
    sources: new Map([
      ['n1', { id: 'n1', title: '学習発表会のお知らせ' }],
      ['u1', { id: 'u1', title: '学年だより' }],
      ['n7', { id: 'n7', title: '持ち物' }],
    ]),
    t: i18n.getFixedT('ja'),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route: Route) => {
      routes.push(route);
    },
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  const buttons = (label: string) =>
    [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));
  return { host, sent, routes, buttons, unmount: () => step(() => root.unmount()) };
}

it('家にあると答えた物は、持って行く日と一緒に出し、「やっぱり無かった」を見せた版で送る', async () => {
  const { host, sent, buttons, unmount } = await render([
    { requirement: school, bought: false, reanswer: true },
  ]);
  expect(host.textContent).toContain('白い長袖シャツを持って行く（12/5（土））');
  expect(host.textContent).toContain('家にあると答えています');
  await step(() => buttons('やっぱり無かった')[0]?.click());
  expect(sent).toEqual([
    {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: 42 },
    },
  ]);
  await unmount();
});

it('用意の締切の後に無いと答えた物は、無いことと家族で決めることを示し、「用意できた」で答え直せる', async () => {
  const { host, sent, buttons, unmount } = await render([
    { requirement: { ...school, atHome: 'no' }, bought: false, reanswer: true },
  ]);
  expect(host.textContent).toContain('白い長袖シャツを持って行く（12/5（土））');
  expect(host.textContent).toContain(
    '家に無いと答えています。用意の締切を過ぎたので、どうするかは家族で決めてください。',
  );
  expect(host.textContent).not.toContain('やっぱり無かった');
  await step(() => buttons('用意できた')[0]?.click());
  expect(sent).toEqual([
    {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: 42 },
    },
  ]);
  await unmount();
});

it('答え直せない時は、答えたことだけを出し、答え直しは出さない', async () => {
  const { host, unmount } = await render([{ requirement: school, bought: false, reanswer: false }]);
  expect(host.textContent).toContain('白い長袖シャツを持って行く（12/5（土））');
  expect(host.textContent).toContain('家にあると答えています');
  expect(host.textContent).not.toContain('やっぱり無かった');
  await unmount();
});

it('買い終えた物は、買ってあると出し、見つからなければ「やっぱり無かった」と答え直せる', async () => {
  const { host, sent, buttons, unmount } = await render([
    { requirement: { ...school, atHome: 'no', bought: true }, bought: true, reanswer: true },
  ]);
  expect(host.textContent).toContain('買ってあります');
  expect(host.textContent).not.toContain('家に無いと答えています');
  await step(() => buttons('やっぱり無かった')[0]?.click());
  expect(sent).toEqual([
    {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: 42 },
    },
  ]);
  await unmount();
});

it('答えられる間を過ぎた買い終えた物は、答え直しを出さない', async () => {
  const { host, unmount } = await render([{ requirement: school, bought: true, reanswer: false }]);
  expect(host.textContent).toContain('買ってあります');
  expect(host.textContent).not.toContain('やっぱり無かった');
  await unmount();
});

it('同じ品物を同じ日に求めるお知らせが二つあれば、それぞれのお知らせを示し、元の文へ戻れる', async () => {
  const { routes, buttons, unmount } = await render([
    { requirement: school, bought: false, reanswer: true },
    { requirement: club, bought: false, reanswer: true },
  ]);
  const links = [
    ...buttons('「学習発表会のお知らせ」の文を見る'),
    ...buttons('「学年だより」の文を見る'),
  ];
  expect(links).toHaveLength(2);
  await step(() => links[1]?.click());
  expect(routes).toEqual([{ name: 'sources', sourceId: 'u1', highlight: ['u1#1'] }]);
  await unmount();
});

const changed = (before: Requirement, after: Requirement): ChangeSummary => ({
  sourceId: 'n7',
  receivedAt: '2026-12-01T20:00+09:00',
  gone: [],
  moved: [{ before, after, undo: [] }],
});

it('変わったこと：使う日だけ変わった持ち物は、日の変わりを見せる（同じ締切を並べない）', async () => {
  const deadline = '2026-12-02T17:00+09:00';
  const { host, unmount } = await render(
    [],
    changed(socks('2026-12-05', deadline), socks('2026-12-08', deadline)),
  );
  expect(host.textContent).toContain('白い靴下：12/5（土） → 12/8（火）');
  expect(host.textContent).not.toContain('まで');
  await unmount();
});

it('変わったこと：使う日と用意の締切が別々に変わった持ち物は、両方を見せる', async () => {
  const { host, unmount } = await render(
    [],
    changed(
      socks('2026-12-05', '2026-12-02T17:00+09:00'),
      socks('2026-12-08', '2026-12-03T17:00+09:00'),
    ),
  );
  expect(host.textContent).toContain('白い靴下：12/5（土） → 12/8（火）');
  expect(host.textContent).toMatch(/白い靴下：12\/2（水）\s?17:00 → 12\/3（木）\s?17:00まで/);
  await unmount();
});

it('変わったこと：締切が使う日の朝に付いて動いただけなら、日の変わりだけを見せる', async () => {
  const { host, unmount } = await render(
    [],
    changed(
      socks('2026-12-05', '2026-12-05T08:00+09:00'),
      socks('2026-12-08', '2026-12-08T08:00+09:00'),
    ),
  );
  expect(host.textContent).toContain('白い靴下：12/5（土） → 12/8（火）');
  expect(host.textContent).not.toContain('まで');
  await unmount();
});

it('変わったこと：用意の締切が変わった持ち物は、締切の変わりを見せる', async () => {
  const { host, unmount } = await render(
    [],
    changed(
      socks('2026-12-05', '2026-12-02T17:00+09:00'),
      socks('2026-12-05', '2026-12-03T17:00+09:00'),
    ),
  );
  expect(host.textContent).toMatch(/白い靴下：12\/2（水）\s?17:00 → 12\/3（木）\s?17:00まで/);
  await unmount();
});
