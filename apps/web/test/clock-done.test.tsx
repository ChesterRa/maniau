// @vitest-environment happy-dom
// 試用の時計を進めたら、押した後の一行（「OK の返事を記録しました」など）は消す。日が変わっても、前に押した事の
// 一行を出したままにしない。架空のデモの家の情報だけの家庭に、返事待ちを一つ足した見せる物で試す（DOM の試験
// では、ファイルを読むデモの組み立てを使わない）。
import { DomainEvent, type ExternalRequest } from '@maniau/core';
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
const NEXT_DAY = '2026-11-30T21:00+09:00';
const events = [
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
];
const base = viewFor(events, 'b', AT);
const request: ExternalRequest = {
  requestId: 'r1',
  taskKey: 'task:ask',
  to: 'g',
  kind: 'reply',
  sentAt: '2026-11-29T20:00+09:00',
  sentBy: 'b',
  state: 'awaitingReply',
  basis: { itemIds: [] },
  live: true,
};
const waiting = {
  ...base,
  plan: { ...base.plan, requests: [request] },
  today: { main: [], quiet: [{ kind: 'waiting' as const, request }] },
};

const done = () => host.textContent?.includes(i18n.t('today.done.replyYes')) ?? false;
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`押す物が無い：${label}`);
  await step(() => button.click());
};
const commands = () => calls.filter((c) => c.url === '/api/demo/sessions/s1/commands');

it('返事を記録した後の一行は、時計を進めると消える（進めるまでは出す）', async () => {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  await press(i18n.t('start.stages'));
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions').respond(200, {
      sessionId: 's1',
      household: base.household,
      readings: [],
      stages: [{ id: 'asked', now: AT, viewer: 'b' }],
    }),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, waiting),
  );

  await press(i18n.t('quiet.replyYes'));
  expect(commands().at(-1)?.body?.command).toMatchObject({ type: 'recordReply', reply: 'yes' });
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1/commands').respond(200, {
      result: { status: 'ok', throughSeq: 2 },
      view: base,
    }),
  );
  expect(done()).toBe(true);

  await press(i18n.t('demo.plusDay'));
  expect(commands().at(-1)?.body?.command).toMatchObject({ type: 'advanceClock', to: NEXT_DAY });
  // 押した時に消す（新しい見せる物を待たない）。
  expect(done()).toBe(false);
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1/commands').respond(200, {
      result: { status: 'ok', throughSeq: 3 },
      view: viewFor(events, 'b', NEXT_DAY),
    }),
  );
  expect(done()).toBe(false);
});
