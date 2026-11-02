// @vitest-environment happy-dom
// 「済んだ」は、札で見せている用件を付けて送る（直されて別の物になった後の古い札で、別の物を済みに
// しない。違えば、サーバーが断って見せ直す）。
import type { Command, Task } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import { TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

it('きょうの「やること」の「済んだ」は、見せている用件を付ける', async () => {
  const sent: Command[] = [];
  const task: Task = {
    key: 'task:opt:arr:purchase:n1:i5:buy:buy',
    titleKey: 'task.buy',
    titleParams: { what: '白い長袖シャツ' },
    basis: {
      itemIds: ['n1:i5'],
      requirementKey: 'req:belongings:n1:i5',
      arrangementKey: 'arr:purchase:n1:i5',
      optionKey: 'opt:arr:purchase:n1:i5:buy',
    },
    durationMin: 15,
    after: [],
    segments: ['commute'],
    start: '2026-11-26T18:55+09:00',
    end: '2026-11-26T19:10+09:00',
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    assigneeId: 'a',
    commitment: 'accepted',
    live: true,
  };
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-26T12:10+09:00',
    me: { id: 'a', name: '健太', kind: 'adult' },
    household: { members: [{ id: 'a', name: '健太', kind: 'adult' }] },
    plan: { tasks: [task], requirements: [], arrangements: [], requests: [] },
    today: { main: [], quiet: [{ kind: 'todo', task }] },
    items: [],
    t: i18n.getFixedT('ja'),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: () => {},
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '済んだ');
  expect(button).toBeDefined();
  await step(() => button?.click());
  expect(sent).toEqual([
    {
      type: 'commitment',
      taskKey: task.key,
      action: 'done',
      seen: { titleKey: 'task.buy', titleParams: { what: '白い長袖シャツ' } },
    },
  ]);
  await step(() => root.unmount());
});

it('手配の手順の行は、どの日の分かを書き、「済んだ」はその日を含む用件を付ける', async () => {
  const sent: Command[] = [];
  const task: Task = {
    key: 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:write',
    step: { templateId: 'opt-gakudo', stepId: 'write' },
    titleKey: 'task.gakudoForm.write',
    titleParams: { date: '2026-12-07' },
    basis: {
      itemIds: ['n1:i6'],
      requirementKey: 'req:childCare:n1:i6:c',
      arrangementKey: 'arr:childCare:n1:i6:c',
      optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
    },
    durationMin: 10,
    after: [],
    segments: ['home', 'work'],
    start: '2026-11-30T17:20+09:00',
    end: '2026-11-30T17:30+09:00',
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    assigneeId: 'a',
    commitment: 'accepted',
    live: true,
  };
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-30T12:00+09:00',
    me: { id: 'a', name: '健太', kind: 'adult' },
    household: { members: [{ id: 'a', name: '健太', kind: 'adult' }], careOptions: [] },
    plan: { tasks: [task], requirements: [], arrangements: [], requests: [] },
    today: { main: [], quiet: [{ kind: 'todo', task }] },
    items: [],
    t: i18n.getFixedT('ja'),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: () => {},
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  expect(host.textContent).toContain('学童の申込書を書く');
  expect(host.textContent).toContain('12/7（月）の分');
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '済んだ');
  await step(() => button?.click());
  expect(sent).toEqual([
    {
      type: 'commitment',
      taskKey: task.key,
      action: 'done',
      seen: { titleKey: 'task.gakudoForm.write', titleParams: { date: '2026-12-07' } },
    },
  ]);
  await step(() => root.unmount());
});
