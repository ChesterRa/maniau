// 同じ日に頼む時間が変わった依頼の、時間の変更のお願い（画面）：確かめの札に前の時間と今の時間を書き、変更のお願いの
// 入口を出す。入口から開いた頼む文は、前の時間と新しい時間を相手の言葉で書き、送ったの記録に前の依頼と見せた前の
// 時間を付ける。変更の返事を待つ間は確かめの札を出さず、返事待ちの行に「OK だった」の意味を書く。断られたら、前の
// お願いの状態のまま残っていると書く。見本の家族（架空）を、サーバーと同じ命令の道で動かす。
import type { Command, DomainEvent, Household } from '@maniau/core';
import { keys } from '@maniau/core/engine';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { AskScreen, type Ctx, type Route, TodayScreen } from '../src/screens';
import { demoData } from './ctx';
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

const CARE = 'arr:childCare:n1:i6:c';
const ASK = keys.task(keys.option(CARE, 'opt-grandma'), 'ask');
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const buttonOf = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

/**
 * 段「返事がまだ」から、祖母（r-grandma）の返事を記録し（reply が無ければ返事待ちのまま）、大人 a の月曜の帰りを
 * 18:15 から 19:30 に直す（画面と同じ、見てから保存する道）。子を見てもらう時間は 19:10（b の帰り）まで延びる。
 */
async function lengthened(
  reply?: 'yes',
  edit?: (events: DomainEvent[]) => DomainEvent[],
  stage: DemoStageId = 'chase',
) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const seeded = demoEvents(stage);
  const store = memoryStore(new Map([['demo', edit ? edit(seeded) : seeded]]));
  let op = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()] as DomainEvent[]);
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `w-${++op}`, now, demo: true }, command);
  if (reply) {
    expect(await run('b', { type: 'recordReply', requestId: 'r-grandma', reply })).toMatchObject({
      status: 'ok',
    });
  }
  const set = (await events()).findLast((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家庭が無い');
  const next: Household = structuredClone(set.household);
  const monday = next.routines.find((r) => r.memberId === 'a' && r.weekday === 1);
  const back = monday?.segments.find((s) => s.kind === 'home' && s.start === '18:15');
  const commute = monday?.segments.find((s) => s.kind === 'commute' && s.end === '18:15');
  if (!back || !commute) throw new Error('月曜の帰りが無い');
  back.start = '19:30';
  commute.end = '19:30';
  const preview = previewChange(
    await events(),
    { memberId: 'a', now },
    { type: 'updateHousehold', household: next },
  );
  if ('status' in preview) throw new Error(`preview: ${preview.status}`);
  expect(
    await run('a', {
      type: 'updateHousehold',
      household: next,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  const sent: Command[] = [];
  const routes: Route[] = [];
  const ctx = async (memberId: string, lang: 'ja' | 'en' = 'ja'): Promise<Ctx> => {
    const me = demoData.household.members.find((m) => m.id === memberId);
    if (!me) throw new Error('大人が無い');
    const view = viewFor(await events(), memberId, now);
    return {
      plan: view.plan,
      household: view.household,
      today: view.today,
      ...(view.changes ? { changes: view.changes } : {}),
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: demoData.readings,
      me,
      lang,
      tz: view.household.timeZone,
      now: view.now,
      t: i18n.getFixedT(lang),
      outbound: (lng) => i18n.getFixedT(lng),
      preview: async () => undefined,
      send: async (command: Command) => {
        sent.push(command);
        return { status: 'ok' };
      },
      go: (route: Route) => {
        routes.push(route);
      },
    };
  };
  return { run, ctx, sent, routes };
}

describe('同じ日に頼む時間が変わった依頼', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`確かめの札に前と今の時間を書き、時間の変更を頼む文へ進める（${lang}）`, async () => {
      const h = await lengthened('yes');
      const c = await h.ctx('b', lang);
      const r1 = c.plan.requests.find((r) => r.requestId === 'r-grandma');
      expect(r1).toMatchObject({ state: 'confirmed', needsCheck: true });
      await step(() => root.render(<TodayScreen ctx={c} />));
      expect(host.textContent).toContain(lang === 'ja' ? '前：' : 'before:');
      // 時刻は画面の言葉で書く（日本語は 24 時間、英語は午前・午後）。
      expect(host.textContent).toContain(lang === 'ja' ? '18:15' : '6:15');
      expect(host.textContent).toContain(lang === 'ja' ? '19:10' : '7:10');
      const ask = buttonOf(c.t('card.check.askChange'));
      expect(ask, host.textContent ?? '').toBeDefined();
      await step(() => ask?.click());
      expect(h.routes.at(-1)).toEqual({ name: 'ask', taskKey: ASK, replaces: 'r-grandma' });

      // 頼む文：相手（祖母）の言葉で、前の時間と新しい時間を書く。前のお願いの取り消しとは書かない。
      await step(() => root.render(<AskScreen ctx={c} taskKey={ASK} replaces="r-grandma" />));
      const text = host.textContent ?? '';
      expect(text).toContain(c.t('ask.changeTitle'));
      expect(text).toContain('お願いしていましたが、時間が変わりました');
      expect(text).toContain('18:15');
      expect(text).toContain('19:10');
      await step(() => buttonOf(c.t('ask.sent'))?.click());
      const command = h.sent.at(-1);
      expect(command).toMatchObject({
        type: 'recordSent',
        taskKey: ASK,
        window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T19:10+09:00' },
        replaces: { requestId: 'r-grandma', window: r1?.window },
      });
      // 画面の命令をそのままサーバーに通すと受ける。
      if (!command) throw new Error('命令が無い');
      expect(await h.run('b', command)).toMatchObject({ status: 'ok' });

      // 返事を待つ間：確かめの札は出さず、返事待ちの行に、何を変えてもらうお願いかと「OK だった」の意味を書く。
      const waiting = await h.ctx('b', lang);
      expect(
        waiting.plan.requests.find((r) => r.requestId === 'r-grandma')?.changeAsked,
      ).toBeDefined();
      await step(() => root.render(<TodayScreen ctx={waiting} />));
      const today = host.textContent ?? '';
      expect(buttonOf(waiting.t('card.check.askChange'))).toBeUndefined();
      expect(today).not.toContain(
        lang === 'ja' ? '見てもらう時間が変わりました' : 'The time changed after you asked',
      );
      expect(today).toContain(
        lang === 'ja'
          ? 'OK の返事あり）を、この時間に変えてもらうお願いです'
          : 'they said OK) to this time',
      );
      expect(today).toContain(lang === 'ja' ? '前の時間には戻りません' : 'does not switch back');
    });
  }

  it('変更が断られたら、前のお願いの状態（返事待ち）のまま残っていると書き、もう一度は頼ませない', async () => {
    const h = await lengthened();
    const c = await h.ctx('b');
    const command = (() => {
      const r1 = c.plan.requests.find((r) => r.requestId === 'r-grandma');
      const arrangement = c.plan.arrangements.find((a) => a.key === CARE);
      if (!r1?.window || !arrangement) throw new Error('依頼か手配が無い');
      return {
        type: 'recordSent',
        taskKey: ASK,
        requestId: 'r-change',
        window: { start: arrangement.start, end: arrangement.end },
        replaces: { requestId: 'r-grandma', window: r1.window },
      } as const;
    })();
    expect(await h.run('b', command)).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'no' }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.ctx('b');
    await step(() => root.render(<TodayScreen ctx={after} />));
    const text = host.textContent ?? '';
    expect(text).toContain('時間の変更は断られました');
    expect(text).toContain('返事待ちのまま');
    expect(text).toContain('確かめられていません');
    expect(buttonOf(after.t('card.check.askChange'))).toBeUndefined();
  });

  it('時間のほかも変わったかを確かめられない依頼（条件の控えの無い古い記録）には、変更のお願いの入口を出さない', async () => {
    const h = await lengthened('yes', (events) =>
      events.map((e) => {
        if (e.type !== 'externalRequestSent' || e.requestId !== 'r-grandma' || !e.snapshot)
          return e;
        const copy = structuredClone(e);
        delete copy.snapshot?.condition;
        return copy;
      }),
    );
    const c = await h.ctx('b');
    const r1 = c.plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(r1).toMatchObject({ state: 'confirmed', needsCheck: true });
    expect(r1?.timeOnly).toBeUndefined();
    await step(() => root.render(<TodayScreen ctx={c} />));
    const text = host.textContent ?? '';
    // 前提が変わったと書き、時間だけが変わったとは言わない。入口は「選び直す」だけ。
    expect(text).toContain(c.t('card.check.title', { to: 'おばあちゃん' }));
    expect(text).toContain(c.t('card.check.body'));
    expect(text).not.toContain('見てもらう時間が変わりました');
    expect(buttonOf(c.t('card.check.askChange'))).toBeUndefined();
    // 手は今も選ばれているので「もう要らない」は出さず、決める画面で選び直す道を書く。
    expect(text).toContain(c.t('card.check.stillChosen'));
    expect(buttonOf(c.t('card.check.cancel'))).toBeUndefined();
  });

  it('学童などの所への届けには、時間が変わったと書いても、時間の変更を頼む入口を出さない', async () => {
    // 段「学童にも申し込んだ」：健太（a）が学童に届けた後、見てもらう時間が延びる。
    const h = await lengthened(undefined, undefined, 'backup');
    const c = await h.ctx('a');
    const r = c.plan.requests.find((x) => x.requestId === 'r-gakudo');
    expect(r).toMatchObject({ to: 'gakudo', timeOnly: true, needsCheck: true });
    await step(() => root.render(<TodayScreen ctx={c} />));
    const text = host.textContent ?? '';
    expect(text).toContain('見てもらう時間が変わりました');
    expect(buttonOf(c.t('card.check.askChange'))).toBeUndefined();
    expect(text).toContain(c.t('card.check.stillChosen'));
    expect(buttonOf(c.t('card.check.cancel'))).toBeUndefined();
  });
});
