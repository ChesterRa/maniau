// @vitest-environment happy-dom
// 返事待ちを追う札の押す物：頼んだことの行と同じ命令（返事の記録・押し間違いの訂正）を送り、「断られたら？」へ
// 進む。架空のデモの家の情報だけの家庭に、追う札を一つ置いた見せる物で試す（DOM の試験では、ファイルを読むデモの
// 組み立てを使わない）。
import { Arrangement, DomainEvent, type ExternalRequest } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import household from '../../../data/demo/household.json';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const AT = '2026-12-06T08:10+09:00';
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
  sentAt: '2026-11-25T19:40+09:00',
  sentBy: 'b',
  state: 'awaitingReply',
  basis: { itemIds: [], arrangementKey: 'arr:care' },
  window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
  live: true,
};
const arrangement = Arrangement.parse({
  key: 'arr:care',
  requirementKey: 'req:care',
  kind: 'childCare',
  start: request.window?.start,
  end: request.window?.end,
  status: 'dependsOnReply',
  options: [],
  live: true,
});

it('OK だった・断られた・押し間違いは頼んだことの行と同じ命令を送り、断られたら？へ進む', async () => {
  const sent: unknown[] = [];
  const went: unknown[] = [];
  const t = i18n.getFixedT('ja');
  const ctx: Ctx = {
    plan: { ...base.plan, requests: [request] },
    household: base.household,
    today: { main: [{ kind: 'noReply', arrangement, request }], quiet: [] },
    items: base.items,
    sources: new Map(base.sources.map((s) => [s.id, s])),
    readings: [],
    me: base.household.members.find((m) => m.id === 'b') ?? base.household.members[0],
    lang: 'ja',
    tz: base.household.timeZone,
    now: AT,
    t,
    outbound: (lng) => i18n.getFixedT(lng),
    send: async (command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route) => went.push(route),
  };
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  expect(host.textContent).toContain(t('card.noReply.title', { to: 'おばあちゃん' }));
  expect(host.textContent).not.toContain(t('today.nothing'));
  const press = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    if (!button) throw new Error(`押す物が無い：${label}`);
    await step(() => button.click());
  };
  await press(t('quiet.replyYes'));
  await press(t('quiet.replyNo'));
  await press(t('quiet.notSent'));
  await press(t('whatIf.link'));
  expect(sent).toEqual([
    { type: 'recordReply', requestId: 'r1', reply: 'yes' },
    { type: 'recordReply', requestId: 'r1', reply: 'no' },
    { type: 'correctSentRecord', requestId: 'r1' },
  ]);
  expect(went).toEqual([
    { name: 'today', done: 'replyYes' },
    { name: 'today', done: 'replyNo' },
    { name: 'whatIf', requestId: 'r1' },
  ]);
});
