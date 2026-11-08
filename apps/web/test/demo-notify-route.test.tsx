// @vitest-environment happy-dom
// デモの知らせの候補は「きょう」の画面だけに出す：ほかの画面（「うち」、試しの計算の画面など）へ移ったら出さず、
// 戻ったらまた出す（試しの計算の画面で、今の計画の候補を並べない）。架空のデモの家の情報だけの家庭に、候補を
// 添えた見せる物で試す（DOM の試験では、ファイルを読むデモの組み立てを使わない）。
import { DomainEvent } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import household from '../../../data/demo/household.json';
import { viewFor } from '../../server/src/views';
import { App } from '../src/App';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

let calls: Call[] = [];
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  calls = installFetch();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await i18n.changeLanguage('ja');
  try {
    localStorage.clear();
  } catch {
    // 試験の環境に端末の保存が無くても続ける。
  }
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const AT = '2026-11-29T21:00+09:00';
const view = {
  ...viewFor(
    [
      DomainEvent.parse({
        id: 'e-1',
        householdId: household.id,
        seq: 1,
        version: 1,
        occurredAt: AT,
        recordedAt: AT,
        actorId: 'a',
        type: 'householdSet',
        household,
      }),
    ],
    'b',
    AT,
  ),
  notificationPreview: {
    blockedAll: false,
    members: [
      { memberId: 'a', now: [], blocked: 0 },
      { memberId: 'b', now: ['notify.backup'], blocked: 0 },
    ],
  },
};

const summary = () =>
  [...host.querySelectorAll('summary')].find((s) => s.textContent?.startsWith('知らせの候補'))
    ?.textContent ?? null;
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`押す物が無い：${label}`);
  await step(() => button.click());
};

it('「きょう」に出し、「うち」へ移ると出さず、「きょう」に戻るとまた出す', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  // 初めの画面から、用意した場面を開く（審査の入口）。
  await press(i18n.t('start.stages'));
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions').respond(200, {
      sessionId: 's1',
      household: view.household,
      readings: [],
      stages: [{ id: 'chase', now: AT, viewer: 'b' }],
    }),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, view),
  );
  expect(summary()).toBe('知らせの候補（デモでは送りません）：彩さんへ 1 件');

  await press('うち');
  expect(summary()).toBeNull();

  await press('きょう');
  expect(summary()).not.toBeNull();
});
