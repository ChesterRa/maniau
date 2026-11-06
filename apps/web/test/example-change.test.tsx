// @vitest-environment happy-dom
// 例のお知らせの続き（架空の延期の連絡）を、試用の操作から足す：一通目の例の後で、試用の時計が届いた時より前は
// いつから足せるかだけを書き（時計は動かさない）、過ぎたら足す口を出す。足した後は出さない。架空の家族だけ（DOM の
// 試験では、ファイルを読むデモの組み立てを使わない）。
import { DomainEvent, Household, type Source } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { viewFor } from '../../server/src/views';
import { App } from '../src/App';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

const NOW = '2026-11-25T19:31+09:00';
const LATER = '2026-12-04T18:00+09:00';
const SET_AT = '2026-11-24T21:00+09:00';
const AT = '2026-12-04T17:52+09:00';
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
const baseView = viewFor(
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
const source = (id: string, title: string, receivedAt: string): Source => ({
  id,
  version: 1,
  receivedAt,
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title,
  sentences: [],
});
const FIRST = source('n1', '学習発表会のお知らせ', '2026-11-25T19:30+09:00');
const CHANGE = source('n2', '学習発表会の延期について', AT);
/** 見せる物のうち、この所が見る物（お知らせの一覧と時計）だけを替える。 */
const viewWith = (sources: Source[], now: string) => ({ ...baseView, sources, now });
const info = {
  sessionId: 's1',
  trial: 'own',
  household: own,
  readings: [],
  stages: [{ id: 'arrived', now: NOW, viewer: 'b' }],
  example: { sourceId: 'n1', title: '学習発表会のお知らせ' },
  exampleChange: { sourceId: 'n2', title: '学習発表会の延期について', at: AT },
};

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
/** 開き直した試用（同じデモ）を、指定の見せる物で開き、操作を広げる。 */
const reopen = async (view: unknown) => {
  localStorage.setItem('maniau.trial.v1', 's1');
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1' && c.method === 'GET').respond(200, info),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, view),
  );
  await press(t('trial.controls'));
};
const addLabel = t('trial.change.add', { title: '学習発表会の延期について' });

it('一通目の例の後、届いた時より前は、いつから足せるかだけを書く（足す口は出さない）', async () => {
  await reopen(viewWith([FIRST], NOW));
  expect(text()).toContain('例の続き「学習発表会の延期について」（架空）は、試用の時計が');
  expect(text()).toContain('になったら足せます');
  expect(button(addLabel)).toBeUndefined();
});

it('届いた時を過ぎたら足す口を出し、押すと続きを足すよう頼む', async () => {
  await reopen(viewWith([FIRST], LATER));
  expect(text()).toContain(t('trial.change.note'));
  await press(addLabel);
  const added = take(calls, (c) => c.url === '/api/demo/sessions/s1/example-notice');
  expect(added.body).toEqual({ memberId: 'a1', which: 'change' });
  await step(() => added.respond(200, { view: viewWith([FIRST, CHANGE], LATER), added: true }));
  // 足せたら、見せる物を読み直す。
  expect(
    calls.filter((c) => c.url.startsWith('/api/demo/sessions/s1/view') && !c.done),
  ).toHaveLength(1);
});

it('一通目の例の前と、続きを足した後は出さない', async () => {
  await reopen(viewWith([], LATER));
  expect(button(addLabel)).toBeUndefined();
  expect(text()).not.toContain('例の続き');
  await step(() => root.unmount());
  root = createRoot(host);
  calls.length = 0;
  await reopen(viewWith([FIRST, CHANGE], LATER));
  expect(button(addLabel)).toBeUndefined();
  expect(text()).not.toContain('例の続き');
});
