// @vitest-environment happy-dom
// 引き受けの札：自分の作業で、置けていない・時刻が来た物は、引き受けを経ずに、した事実（済んだ・送る）を
// 記録できる。過ぎた時刻は引き受けさせない。まだ先の時刻なら、引き受ける。
import type { Command, Task } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import type { Route } from '../src/screens';
import { TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const base: Task = {
  key: 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:write',
  titleKey: 'task.gakudo.write',
  titleParams: { date: '2026-12-07' },
  basis: {
    itemIds: ['n1:i6'],
    requirementKey: 'req:childCare:n1:i6:c',
    arrangementKey: 'arr:childCare:n1:i6:c',
    optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
  },
  durationMin: 10,
  after: [],
  segments: ['work'],
  travelBeforeMin: 0,
  travelAfterMin: 0,
  travelSource: 'none',
  assigneeId: 'a',
  commitment: 'proposed',
  live: true,
};

async function render(task: Task, now: string) {
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now,
    me: { id: 'a', name: '健太', kind: 'adult' },
    household: {
      members: [
        { id: 'a', name: '健太', kind: 'adult', active: true },
        { id: 'b', name: '彩', kind: 'adult', active: true },
      ],
      places: [],
      careOptions: [],
    },
    plan: { tasks: [task], requirements: [], arrangements: [], requests: [], throughSeq: 3 },
    today: { main: [{ kind: 'proposal', task }], quiet: [] },
    items: [],
    t: i18n.getFixedT('ja'),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route: Route) => went.push(route),
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
  const click = (label: string) =>
    step(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)?.click());
  return {
    sent,
    went,
    buttons,
    click,
    text: () => host.textContent ?? '',
    unmount: () => step(() => root.unmount()),
  };
}

it('置けていない自分の作業は、引き受けずに「済んだ」と記録できる', async () => {
  const view = await render(base, '2026-11-30T17:31+09:00');
  expect(view.buttons()).toContain('済んだ');
  expect(view.buttons()).not.toContain('やります');
  await view.click('済んだ');
  expect(view.sent).toEqual([
    {
      type: 'commitment',
      taskKey: base.key,
      action: 'done',
      seen: { titleKey: base.titleKey, titleParams: base.titleParams },
    },
  ]);
  await view.unmount();
});

it('時刻が来た自分の作業は、過ぎた時刻を引き受けさせず、「済んだ」を出す', async () => {
  const task = { ...base, start: '2026-11-30T17:20+09:00', end: '2026-11-30T17:30+09:00' };
  const view = await render(task, '2026-11-30T17:31+09:00');
  expect(view.buttons()).toContain('済んだ');
  expect(view.buttons()).not.toContain('やります');
  await view.unmount();
});

it('まだ先の時刻なら、やります（引き受け）を出す（済んだは出さない）', async () => {
  const task = { ...base, start: '2026-11-30T17:20+09:00', end: '2026-11-30T17:30+09:00' };
  const view = await render(task, '2026-11-30T15:00+09:00');
  expect(view.buttons()).toContain('やります');
  expect(view.buttons()).not.toContain('済んだ');
  await view.unmount();
});

it('引き受けた後に置き直した作業（見せ直し）は、新しい時刻を引き受けるか、今の用件を済ませた事を記録できる', async () => {
  const task = {
    ...base,
    commitment: 'accepted' as const,
    reconfirm: true,
    start: '2026-11-30T17:40+09:00',
    end: '2026-11-30T17:50+09:00',
  };
  const view = await render(task, '2026-11-30T17:31+09:00');
  expect(view.buttons()).toContain('やります');
  expect(view.buttons()).toContain('済んだ');
  await view.click('済んだ');
  expect(view.sent.at(-1)).toMatchObject({ type: 'commitment', taskKey: base.key, action: 'done' });
  await view.unmount();
});

it('日が直されて見せ直しになった作業では、記録するのは今の日の用件だと示し、前の日の分を済ませた事と取り違えさせない', async () => {
  const task: Task = {
    ...base,
    titleKey: 'task.gakudoForm.write',
    titleParams: { date: '2026-12-14' },
    commitment: 'accepted',
    reconfirm: true,
    start: '2026-11-30T17:40+09:00',
    end: '2026-11-30T17:50+09:00',
  };
  const view = await render(task, '2026-11-30T17:31+09:00');
  const text = view.text();
  expect(text).toContain('「学童の申込書を書く（12/14（月）の分）」をもう済ませていれば');
  expect(text).toContain('変わる前の内容の分を済ませただけなら、押さないでください');
  expect(text).not.toContain('前の約束のとおり');
  await view.click('済んだ');
  expect(view.sent.at(-1)).toEqual({
    type: 'commitment',
    taskKey: base.key,
    action: 'done',
    seen: { titleKey: 'task.gakudoForm.write', titleParams: { date: '2026-12-14' } },
  });
  await view.unmount();
});

it('人に頼む作業の見せ直しでは、「送る」は今の頼む文を開くだけで、送ったと記録するのはその画面', async () => {
  const task: Task = {
    ...base,
    external: { to: 'b', kind: 'reply' },
    commitment: 'accepted',
    reconfirm: true,
    start: '2026-11-30T17:40+09:00',
    end: '2026-11-30T17:50+09:00',
  };
  const view = await render(task, '2026-11-30T17:31+09:00');
  expect(view.text()).toContain(
    '「送る」で、今の頼む文を開きます。同じ文をもう送っていれば、そこで送ったと記録できます。',
  );
  await view.click('送る');
  expect(view.sent).toEqual([]);
  expect(view.went).toEqual([{ name: 'ask', taskKey: base.key }]);
  await view.unmount();
});
