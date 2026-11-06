// @vitest-environment happy-dom
// 初めの画面で選んだ言葉を、開き直した後も使う：試用を始める前はまだ大人がいないので、大人ごとには覚えられない。
// 端末の言葉として覚え、開き直した時の初めの言葉にする（大人ごとに覚えた言葉があれば、そちらを使う）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Household } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);

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

const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`押す物が無い：${label}`);
  await step(() => button.click());
};

/** 開き直した時と同じく、画面の言葉の部品を読み込み直す（その時の端末の記録で、初めの言葉が決まる）。 */
async function reload() {
  vi.resetModules();
  return (await import('../src/i18n')).default;
}

it('初めの画面で English を選ぶと、開き直した時も英語で始まる', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  await press('English');
  expect(i18n.language).toBe('en');
  expect(host.textContent).toContain('View prepared scenes (for judges)');
  expect((await reload()).language).toBe('en');
});

it('選んでいなければ、開き直しても日本語で始まる', async () => {
  expect((await reload()).language).toBe('ja');
});

const ARRIVED = { id: 'arrived', now: '2026-11-25T19:31+09:00', viewer: 'b' };
const ASKED = { id: 'asked', now: '2026-11-26T12:10+09:00', viewer: 'a' };
/** 始めた試用・場面を返す（画面の中身 view は返さない：言葉の切り替えだけを見る）。 */
const open = async (sessionId: string, extra: Record<string, unknown>) =>
  step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions').respond(200, {
      sessionId,
      household,
      readings: [],
      ...extra,
    }),
  );

it('前の試用で同じ ID の大人に選んだ言葉で、新しい試用の初めの画面で選んだ言葉を上書きしない', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  // 一つ目の試用（見本の家族）で、最初に見る大人に日本語を選ぶ。
  await press(i18n.t('start.sample'));
  await open('s1', { stages: [], trial: 'sample' });
  await press(i18n.t('trial.controls'));
  await press('日本語');
  expect(i18n.language).toBe('ja');
  // 初めの画面に戻り、English を選んで、別の試用を始める（同じ ID の大人がいる）。
  await press(i18n.t('trial.leave'));
  await press('English');
  await press(i18n.t('start.sample'));
  await open('s2', { stages: [], trial: 'sample' });
  expect(i18n.language).toBe('en');
});

it('用意した場面を替えても同じ家族なので、大人ごとに選んだ言葉を使う', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  await press(i18n.t('start.stages'));
  await open('s1', { stages: [ARRIVED, ASKED] });
  // 健太に English、彩に日本語を選ぶ。
  await press('健太');
  await press('English');
  await press('彩');
  await press('日本語');
  expect(i18n.language).toBe('ja');
  // 場面を「11/26」（最初に見るのは健太）に替える：健太が選んだ English に戻す。
  const select = host.querySelector('select');
  if (!select) throw new Error('場面の選び口が無い');
  await step(() => {
    select.value = 'asked';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await open('s2', { stages: [ARRIVED, ASKED] });
  expect(i18n.language).toBe('en');
});
