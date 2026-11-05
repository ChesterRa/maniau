// @vitest-environment happy-dom
// デモの画面の言葉：初めは日本語。大人や場面を替えても、まだ言葉を選んでいない大人なら今の言葉のままにし、その人の分
// としては覚えない。言葉を選んだ大人に替えたら、その人の言葉に戻す（英語で見ている審査の人が、案内どおりに大人を
// 替えても日本語に戻らないように）。家族の家庭は、今までどおり人ごとの言葉。架空のデモの家。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Household } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
const pressed = (label: string) =>
  [...host.querySelectorAll('button')]
    .find((b) => b.textContent === label)
    ?.getAttribute('aria-pressed');
const saved = (memberId: string) => localStorage.getItem(`maniau.uiLanguage.${memberId}`);

it('デモ：まだ選んでいない大人には今の言葉を引き継ぎ（覚えない）、選んだ大人にはその人の言葉を戻す', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  // 初めの画面から、用意した場面を開く（審査の入口）。
  await press(i18n.t('start.stages'));
  // 最初の場面は彩の画面（data/demo と同じ）。画面の中身（view）は返さない：言葉の切り替えだけを見る。
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions').respond(200, {
      sessionId: 's1',
      household,
      readings: [],
      stages: [{ id: 'arrived', now: '2026-11-25T19:31+09:00', viewer: 'b' }],
    }),
  );
  expect(i18n.language).toBe('ja');
  expect(pressed('彩')).toBe('true');

  await press('健太');
  await press('English');
  expect(i18n.language).toBe('en');
  expect(saved('a')).toBe('en');

  // 彩はまだ選んでいない：英語のまま、彩の分としては覚えない。
  await press('彩');
  expect(pressed('彩')).toBe('true');
  expect(i18n.language).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(saved('b')).toBeNull();

  await press('日本語');
  expect(i18n.language).toBe('ja');
  expect(saved('b')).toBe('ja');

  // 選んだ人に替えたら、その人の言葉に戻す。
  await press('健太');
  expect(i18n.language).toBe('en');
  await press('彩');
  expect(i18n.language).toBe('ja');
  expect(saved('a')).toBe('en');
});
