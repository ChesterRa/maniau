// @vitest-environment happy-dom
// 引き受けの札：一緒に置く中で、ほかに進める手の作業と重ならない時刻を見つけられなかった手の作業は、
// 「ふだんの予定に空きが無い」と書かず、そう書いて、決める画面で見直せるようにする。
// 予備の札：返事を待つ間も、決める画面で全部の手と「選んだら」を見て、選び直せる。
import type { Command, Task } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import type { Route } from '../src/screens';
import { TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const arrangementKey = 'arr:childCare:n1:i6:c';
const gakudo = 'opt:arr:childCare:n1:i6:c:opt-gakudo';
const grandma = 'opt:arr:childCare:n1:i6:c:opt-grandma';

const task: Task = {
  key: `task:${gakudo}:write`,
  titleKey: 'task.gakudoForm.write',
  titleParams: { date: '2026-12-07' },
  basis: {
    itemIds: ['n1:i6'],
    requirementKey: 'req:childCare:n1:i6:c',
    arrangementKey,
    optionKey: gakudo,
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

async function render(
  conflictRefs: string[],
  lang: 'ja' | 'en' = 'ja',
  main: unknown[] = [{ kind: 'proposal', task }],
) {
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-30T12:00+09:00',
    me: { id: 'a', name: '健太', kind: 'adult' },
    household: {
      members: [
        { id: 'a', name: '健太', kind: 'adult', active: true },
        { id: 'b', name: '彩', kind: 'adult', active: true },
      ],
      places: [],
      careOptions: [],
    },
    plan: {
      tasks: [task],
      requirements: [],
      arrangements: [
        {
          key: arrangementKey,
          options: [],
          backupOptionKeys: [],
          reasons: conflictRefs.length > 0 ? [{ code: 'timeConflict', refs: conflictRefs }] : [],
        },
      ],
      requests: [],
      throughSeq: 3,
    },
    today: { main, quiet: [] },
    items: [],
    t: i18n.getFixedT(lang),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route: Route) => went.push(route),
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<TodayScreen ctx={ctx} />));
  const click = (label: string) =>
    step(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)?.click());
  return {
    sent,
    went,
    click,
    text: () => host.textContent ?? '',
    unmount: () => step(() => root.unmount()),
  };
}

it('重ならない時刻を見つけられなかった手の作業は、その理由を書き、決める画面へ行ける', async () => {
  const view = await render([gakudo]);
  expect(view.text()).toContain(
    'ほかに進めている手で同じ人がする作業と重ならない時刻を、今の計算では見つけられなかったので、時刻を決めていません。',
  );
  expect(view.text()).not.toContain('ふだんの予定では');
  // 無いとは言わない。
  expect(view.text()).not.toMatch(/ありません。|できません。/);
  await view.click('決める画面で、手・する人・時間を見直す');
  expect(view.went).toEqual([{ name: 'decide', key: arrangementKey }]);
  expect(view.sent).toEqual([]);
  await view.unmount();
});

it('ほかの手だけが重なっている時は、前のとおり「ふだんの予定に空きが無い」を書く', async () => {
  const view = await render([grandma]);
  expect(view.text()).toContain('あなたのふだんの予定では、決め時までに置ける時間がありません。');
  expect(view.text()).not.toContain('今の計算では見つけられなかった');
  expect(view.text()).not.toContain('決める画面で、手・する人・時間を見直す');
  await view.unmount();
});

it('英語でも同じ理由と見直しの道を出す', async () => {
  const view = await render([gakudo], 'en');
  expect(view.text()).toContain("We couldn't find a time for this that doesn't overlap");
  expect(view.text()).not.toContain('Your usual schedule has no time');
  await view.click('Review the options, who does them, or the times');
  expect(view.went).toEqual([{ name: 'decide', key: arrangementKey }]);
  await view.unmount();
});

it('返事を待つ間の予備の札から、決める画面へ行ける（予備を押さえるだけでなく、選び直せる）', async () => {
  const option = {
    key: gakudo,
    arrangementKey,
    templateId: 'opt-gakudo',
    titleKey: 'option.afterSchoolFullDay',
    decisionDeadline: '2026-11-30T17:20+09:00',
    deadlineCertainty: 'estimate',
    expired: false,
    cost: {},
    taskKeys: [],
  };
  const arrangement = { key: arrangementKey, options: [option], backupOptionKeys: [], reasons: [] };
  const view = await render([], 'ja', [
    { kind: 'backup', arrangement, option, waitingFor: { requestId: 'r-grandma', to: 'g' } },
  ]);
  expect(view.text()).toContain('予備に「学童に預ける」も押さえますか？');
  await view.click('ほかの手も見る・選び直す');
  expect(view.went).toEqual([{ name: 'decide', key: arrangementKey }]);
  expect(view.sent).toEqual([]);
  await view.unmount();
});
