// @vitest-environment happy-dom
// 押した後：記録できたら、きょうに戻って、何を記録したかを一行で出す（送ったと記録した・OK・断られた）。記録できな
// かった時は出さない。家と計画は、要る所だけを手で組む（この環境ではサーバーのデモを読み込めない）。
import type { Command, ExternalRequest, Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { AskScreen, type Ctx, type Route, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const ja = i18n.getFixedT('ja');
const members = [
  { id: 'a1', kind: 'adult', name: '大人A' },
  { id: 'h1', kind: 'helper', name: 'サトウさん' },
];
const task: Task = {
  key: 'task:ask',
  titleKey: 'task.helper.ask',
  titleParams: { name: 'サトウさん' },
  basis: { itemIds: [] },
  durationMin: 5,
  after: [],
  segments: ['home'],
  start: '2026-11-25T19:40+09:00',
  end: '2026-11-25T19:45+09:00',
  travelBeforeMin: 0,
  travelAfterMin: 0,
  travelSource: 'none',
  external: { to: 'h1', kind: 'reply' },
  assigneeId: 'a1',
  commitment: 'accepted',
  live: true,
} as Task;
const request: ExternalRequest = {
  requestId: 'r1',
  taskKey: task.key,
  to: 'h1',
  kind: 'reply',
  sentAt: '2026-11-25T19:45+09:00',
  sentBy: 'a1',
  state: 'awaitingReply',
  basis: { itemIds: [] },
  live: true,
};

function probe(result: 'ok' | 'refused' = 'ok') {
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T19:50+09:00',
    me: members[0],
    household: { members, places: [] },
    plan: { tasks: [task], requirements: [], arrangements: [], requests: [request], questions: [] },
    today: { main: [], quiet: [{ kind: 'waiting', request }] },
    items: [],
    sources: new Map(),
    t: ja,
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return { status: result };
    },
    go: (route: Route) => {
      went.push(route);
    },
  } as unknown as Ctx;
  return { ctx, sent, went };
}

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
const press = async (label: string) => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`押す物が無い：${label}`);
  await step(() => found.click());
};

describe('返事を記録した後', () => {
  it('「OK だった」「断られた」を記録できたら、きょうに戻って一行を出す', async () => {
    const { ctx, sent, went } = probe();
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('頼んだこと');
    await press(ja('quiet.replyYes'));
    expect(sent).toEqual([{ type: 'recordReply', requestId: 'r1', reply: 'yes' }]);
    expect(went).toEqual([{ name: 'today', done: 'replyYes' }]);
    await press(ja('quiet.replyNo'));
    expect(went.at(-1)).toEqual({ name: 'today', done: 'replyNo' });
  });

  it('記録できなかった時は、一行を出さない', async () => {
    const { ctx, went } = probe('refused');
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    await press(ja('quiet.replyYes'));
    expect(went).toEqual([]);
  });
});

describe('送ったと記録した後', () => {
  it('「送ったことを記録」で記録できたら、きょうに戻って一行を出す（コピー・共有では記録しない）', async () => {
    const { ctx, sent, went } = probe();
    await step(() => root.render(<AskScreen ctx={ctx} taskKey={task.key} />));
    await press(ja('ask.copy'));
    expect(sent).toEqual([]);
    await press(ja('ask.sent'));
    expect(sent.map((c) => c.type)).toEqual(['recordSent']);
    expect(went).toEqual([{ name: 'today', done: 'sent' }]);
  });
});
