// @vitest-environment happy-dom
// 空から始める試用の画面：初めの画面（何をするか・試用であること・始め方）、名前だけの家族、見本の家族、開き直し、
// 例のお知らせ、初めの画面へ戻る。架空の家族だけ（DOM の試験では、ファイルを読むデモの組み立てを使わない）。
import { DomainEvent, Household } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { viewFor } from '../../server/src/views';
import { App } from '../src/App';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

const NOW = '2026-11-25T19:31+09:00';
const SET_AT = '2026-11-24T21:00+09:00';
const own = Household.parse({
  id: 'trial-own',
  region: 'JP',
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a1', kind: 'adult', name: '大人A' },
    { id: 'c1', kind: 'child', name: '子H' },
  ],
  places: [],
  routines: [],
  careOptions: [],
});
const emptyView = viewFor(
  [
    DomainEvent.parse({
      id: 'trial-1',
      householdId: own.id,
      seq: 1,
      version: 1,
      occurredAt: SET_AT,
      recordedAt: SET_AT,
      actorId: 'a1',
      type: 'householdSet',
      household: own,
    }),
  ],
  'a1',
  NOW,
);
const info = (trial: 'own' | 'sample') => ({
  sessionId: 's1',
  trial,
  household: own,
  readings: [],
  stages: [{ id: 'arrived', now: NOW, viewer: 'b' }],
  example: { sourceId: 'n1', title: '学習発表会のお知らせ' },
});

let calls: Call[] = [];
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  calls = installFetch();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await i18n.changeLanguage('ja');
  localStorage.clear();
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const text = () => host.textContent ?? '';
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const press = async (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`押す物が無い：${label}`);
  await step(() => found.click());
};
const type = async (label: string, value: string) => {
  const field = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector('input');
  if (!field) throw new Error(`欄が無い：${label}`);
  await step(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const sessionPosts = () => calls.filter((c) => c.url === '/api/demo/sessions');
const open = async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
};
const serve = async (trial: 'own' | 'sample') => {
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions' && c.method === 'POST').respond(
      200,
      info(trial),
    ),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, emptyView),
  );
};

it('初めの画面：何をするか・試用であること・始め方を出し、選ぶまでデモを作らない', async () => {
  await open();
  expect(text()).toContain(t('start.headline'));
  expect(text()).toContain(t('start.note'));
  expect(button(t('start.begin'))).toBeDefined();
  expect(button(t('start.sample'))).toBeDefined();
  expect(sessionPosts()).toEqual([]);
});

it('名前だけの家族：あなたと子の呼び名が無い・同じ呼び名では始められず、入れた名前（前後の空白を除く）だけで始める', async () => {
  await open();
  await press(t('start.begin'));
  expect(button(t('start.family.next'))?.disabled).toBe(true);
  await type(t('start.family.adult'), '  大人A ');
  // 子の呼び名が無いと、まだ始められない（最初の版は子一人のお知らせを扱う）。
  expect(button(t('start.family.next'))?.disabled).toBe(true);
  await type(t('start.family.child'), '大人A');
  expect(text()).toContain(t('start.family.sameName'));
  expect(button(t('start.family.next'))?.disabled).toBe(true);
  await type(t('start.family.child'), '子H');
  expect(button(t('start.family.next'))?.disabled).toBe(false);
  await press(t('start.family.next'));
  expect(sessionPosts().map((c) => c.body)).toEqual([
    { start: 'own', adults: ['大人A'], child: '子H' },
  ]);
  await serve('own');
  expect(text()).toContain(t('trial.badge'));
  expect(text()).toContain(t('start.empty.title'));
  // 読み取りの鍵の無いサーバー（この試験の場）：読めないと書き、例と、手で足す道を出す。
  expect(text()).toContain(t('start.empty.cannotRead'));
  expect(button(t('start.empty.manual'))).toBeDefined();
  expect(button(t('start.empty.input'))).toBeUndefined();
  expect(text()).not.toMatch(/健太|彩|陽菜/);
  // デモの操作は畳んである（押すと出る）。
  expect(button(t('demo.plusDay'))).toBeUndefined();
  await press(t('trial.controls'));
  expect(button(t('demo.plusDay'))).toBeDefined();
  expect(localStorage.getItem('maniau.trial.v1')).toBe('s1');
});

it('見本の家族で始め、例のお知らせは Claude を呼ばずに足して、見せる物を読み直す', async () => {
  await open();
  await press(t('start.sample'));
  expect(sessionPosts().map((c) => c.body)).toEqual([{ start: 'sample' }]);
  await serve('sample');
  expect(text()).toContain(t('start.empty.exampleNote'));
  await press(t('start.empty.example', { title: '学習発表会のお知らせ' }));
  const added = take(calls, (c) => c.url === '/api/demo/sessions/s1/example-notice');
  expect(added.body).toEqual({ memberId: 'a1' });
  await step(() => added.respond(200, { view: emptyView, added: true }));
  // 足せたら、見せる物を読み直す。
  expect(
    calls.filter((c) => c.url.startsWith('/api/demo/sessions/s1/view') && !c.done),
  ).toHaveLength(1);
});

it('開き直すと同じデモに戻る（新しく作らない）', async () => {
  localStorage.setItem('maniau.trial.v1', 's1');
  await open();
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1' && c.method === 'GET').respond(
      200,
      info('own'),
    ),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, emptyView),
  );
  expect(text()).toContain(t('start.empty.title'));
  expect(sessionPosts()).toEqual([]);
});

it('開き直した時に期限が切れていれば、初めの画面で知らせ、この端末の控えを消す', async () => {
  localStorage.setItem('maniau.trial.v1', 's1');
  await open();
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1').respond(404, {
      error: 'unknownSession',
    }),
  );
  expect(text()).toContain(t('start.expired'));
  expect(localStorage.getItem('maniau.trial.v1')).toBeNull();
});

it('初めの画面へ戻ると、この端末の控えを消す', async () => {
  await open();
  await press(t('start.sample'));
  await serve('sample');
  await press(t('trial.controls'));
  await press(t('trial.leave'));
  expect(text()).toContain(t('start.headline'));
  expect(localStorage.getItem('maniau.trial.v1')).toBeNull();
});
