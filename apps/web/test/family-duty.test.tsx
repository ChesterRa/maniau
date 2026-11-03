// @vitest-environment happy-dom
// 当番と家の人がすることの札：書かれた時間・場所を、担当を決める前から見せる。書かれていない終わり・時刻・日は
// 作らず、そう書く。うちの番か分からない物は対象を添え、「うちの番ではない」で外せる。時刻の書かれていない
// 物は、時刻なしで引き受けられる。どの札からも元の文へ戻れる。一言で済んだと言った時の候補は、同じ日の二つの
// 当番を書かれた時間で見分け、見分けられなければ記録させない。
import type { Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Heard } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayReply, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = {
  members: [
    { id: 'a', name: '健太', kind: 'adult', active: true },
    { id: 'b', name: '彩', kind: 'adult', active: true },
    { id: 'c', name: '陽菜', kind: 'child', active: true },
  ],
  places: [],
  careOptions: [],
};

const duty = (over: Partial<Task>): Task =>
  ({
    key: 'task:duty:n3:d1',
    titleKey: 'task.duty',
    titleParams: { what: 'お茶当番', date: '2026-12-13', start: '08:30', end: '10:00' },
    basis: { itemIds: ['n3:d1'], requirementKey: 'req:duty:n3:d1' },
    durationMin: 90,
    earliestStart: '2026-12-13T08:30+09:00',
    deadline: '2026-12-13T10:00+09:00',
    after: [],
    segments: ['home', 'away'],
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    timing: 'fixed',
    commitment: 'proposed',
    live: true,
    ...over,
  }) as Task;

const itemOf = (interpretation: object) => ({
  item: {
    id: 'n3:d1',
    sourceId: 'n3',
    sentenceIds: ['n3#1'],
    kind: 'duty',
    written: '',
    interpretation,
    evidence: 'stated',
    effects: [],
  },
  live: true,
  conditional: false,
  trusted: true,
});

function ctxWith(card: { kind: 'unowned' | 'proposal'; task: Task }, interpretation: object = {}) {
  const sent: unknown[] = [];
  const went: unknown[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[0],
    household,
    plan: {
      tasks: [card.task],
      requirements: [],
      arrangements: [],
      requests: [],
      questions: [],
      throughSeq: 5,
    },
    today: { main: [card], quiet: [] },
    items: [itemOf(interpretation)],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route: unknown) => {
      went.push(route);
    },
  } as unknown as Ctx;
  return { ctx, sent, went };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('当番の札', () => {
  it('担当を決める前から、書かれた時間と場所を見せ、元の文へ戻れる（締切とは書かない）', async () => {
    const task = duty({
      titleParams: {
        what: 'お茶当番',
        date: '2026-12-13',
        start: '08:30',
        end: '10:00',
        place: 'みらい橋小学校（架空）',
      },
    });
    const { ctx, went } = ctxWith({ kind: 'unowned', task });
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('8:30〜10:00');
    expect(host.textContent).toContain('場所：みらい橋小学校（架空）');
    expect(host.textContent).not.toContain('締切');
    await step(() => button('元の文を見る')?.click());
    expect(went).toEqual([{ name: 'sources', sourceId: 'n3', highlight: ['n3#1'] }]);
  });

  it('日をまたぐ時は終わりの日も、終わりが読めない時は目安だと書く', async () => {
    const night = duty({
      earliestStart: '2026-12-13T23:00+09:00',
      deadline: '2026-12-14T01:00+09:00',
    });
    await step(() =>
      root.render(<TodayScreen ctx={ctxWith({ kind: 'unowned', task: night }).ctx} />),
    );
    expect(host.textContent).toMatch(/23:00〜12\/14.*1:00/);
    const estimated = duty({ timing: 'fixedEndEstimated', deadline: '2026-12-13T09:30+09:00' });
    await step(() =>
      root.render(<TodayScreen ctx={ctxWith({ kind: 'unowned', task: estimated }).ctx} />),
    );
    expect(host.textContent).toContain('8:30から（終わりの時刻は確かめられません');
    expect(host.textContent).not.toContain('9:30');
  });

  it('うちの番と読んだ当番も、対象を見せ、「うちの番ではない」で直せる', async () => {
    const { ctx, sent } = ctxWith(
      { kind: 'unowned', task: duty({}) },
      { audience: '陽菜さんのおうち' },
    );
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('対象：陽菜さんのおうち');
    expect(host.textContent).not.toContain('確かめてください');
    await step(() => button('うちの番ではない')?.click());
    expect(sent).toEqual([
      { type: 'stateTurn', itemId: 'n3:d1', ours: false, seen: { throughSeq: 5 } },
    ]);
  });

  it('うちの番か分からない当番は、対象を添え、「うちの番ではない」と言える', async () => {
    const task = duty({ turnUnconfirmed: true });
    const { ctx, sent } = ctxWith({ kind: 'unowned', task }, { audience: '保護者全員' });
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('対象：保護者全員');
    await step(() => button('うちの番ではない')?.click());
    expect(sent).toEqual([
      { type: 'stateTurn', itemId: 'n3:d1', ours: false, seen: { throughSeq: 5 } },
    ]);
  });

  it('書かれた時間にふさがっていて置けない当番は、ずらさず、そう書く（引き受けは出さない）', async () => {
    const task = duty({ assigneeId: 'a' });
    await step(() => root.render(<TodayScreen ctx={ctxWith({ kind: 'proposal', task }).ctx} />));
    expect(host.textContent).toContain('8:30〜10:00');
    expect(host.textContent).toContain('書かれた時間に、ふだんの予定');
    expect(button('やります')).toBeUndefined();
  });

  it('置いた当番には、行き帰りの時間が入っていないことを添える', async () => {
    const task = duty({
      assigneeId: 'a',
      start: '2026-12-13T08:30+09:00',
      end: '2026-12-13T10:00+09:00',
    });
    await step(() => root.render(<TodayScreen ctx={ctxWith({ kind: 'proposal', task }).ctx} />));
    expect(host.textContent).toContain('行き帰りの時間は、入っていません。');
    expect(button('やります')).toBeDefined();
  });
});

describe('時刻の書かれていない物', () => {
  it('日の書かれていないサインは、いつまでか書かれていないと見せ、時刻なしで引き受けられる', async () => {
    const task = duty({
      key: 'task:submit:n3:h3',
      titleKey: 'task.familyAction',
      titleParams: { what: '音読カードのはんこ' },
      timing: 'undated',
      durationMin: 20,
      segments: ['home'],
      assigneeId: 'a',
    });
    delete task.earliestStart;
    delete task.deadline;
    const { ctx, sent } = ctxWith({ kind: 'proposal', task });
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('いつまでか、書かれていません');
    await step(() => button('やります')?.click());
    expect(sent).toEqual([
      {
        type: 'accept',
        taskKey: 'task:submit:n3:h3',
        shown: {
          titleKey: 'task.familyAction',
          titleParams: { what: '音読カードのはんこ' },
          travelBeforeMin: 0,
          travelAfterMin: 0,
        },
      },
    ]);
    // もう済ませていれば、引き受けずに済んだと記録できる。
    expect(button('済んだ')).toBeDefined();
  });

  it('日だけの当番は、時刻が書かれていないと見せる', async () => {
    const task = duty({
      timing: 'day',
      earliestStart: '2026-12-11T00:00+09:00',
      deadline: '2026-12-12T00:00+09:00',
      titleParams: { what: '学級文庫の本の修理当番', date: '2026-12-11' },
    });
    await step(() => root.render(<TodayScreen ctx={ctxWith({ kind: 'unowned', task }).ctx} />));
    expect(host.textContent).toContain('（時刻は書かれていません）');
    expect(host.textContent).not.toContain('0:00');
  });

  it('読み取りの始まりを確かめられなかった当番は、書かれていないと言わず、元の文で確かめてもらう', async () => {
    const task = duty({
      timing: 'day',
      timeUnconfirmed: true,
      earliestStart: '2026-12-13T00:00+09:00',
      deadline: '2026-12-14T00:00+09:00',
      titleParams: { what: 'お茶当番', date: '2026-12-13' },
    });
    await step(() => root.render(<TodayScreen ctx={ctxWith({ kind: 'unowned', task }).ctx} />));
    expect(host.textContent).toContain('（時刻は、元の文で確かめてください）');
    expect(host.textContent).not.toContain('書かれていません');
    expect(button('元の文を見る')).toBeDefined();
  });
});

describe('一言で当番を記録する', () => {
  const afternoon = duty({
    key: 'task:duty:n3:d2',
    basis: { itemIds: ['n3:d2'], requirementKey: 'req:duty:n3:d2' },
    titleParams: { what: 'お茶当番', date: '2026-12-13', start: '13:00', end: '14:00' },
    earliestStart: '2026-12-13T13:00+09:00',
    deadline: '2026-12-13T14:00+09:00',
  });
  const withTasks = (tasks: Task[]) => {
    const { ctx } = ctxWith({ kind: 'unowned', task: duty({}) });
    return { ...ctx, plan: { ...ctx.plan, tasks } } as Ctx;
  };
  const done = (taskKey: string): Heard => ({
    kind: 'change',
    proposals: [{ id: 'p-1', command: { type: 'commitment', taskKey, action: 'done' } }],
  });
  const show = (ctx: Ctx, heard: Heard) =>
    step(() =>
      root.render(
        <SayReply ctx={ctx} reply={heard} busy={false} onRecord={() => {}} onClear={() => {}} />,
      ),
    );

  it('同じ日の二つの当番は、候補に書かれた時間を添えて見分ける', async () => {
    const ctx = withTasks([duty({}), afternoon]);
    await show(ctx, done('task:duty:n3:d1'));
    expect(host.textContent).toContain('8:30〜10:00');
    expect(host.textContent).not.toContain('13:00');
    expect(button('記録する')).toBeDefined();
    await show(ctx, done('task:duty:n3:d2'));
    expect(host.textContent).toContain('13:00〜14:00');
    expect(button('記録する')).toBeDefined();
  });

  it('同じ題・同じ日・同じ時間の当番がほかにもあれば、記録させず、札から記録してもらう', async () => {
    const twin = duty({
      key: 'task:duty:n4:d1',
      basis: { itemIds: ['n4:d1'], requirementKey: 'req:duty:n4:d1' },
    });
    await show(withTasks([duty({}), twin]), done('task:duty:n3:d1'));
    expect(host.textContent).toContain('どれを記録するか見分けられません');
    expect(button('記録する')).toBeUndefined();
    // 済んだ・取り下げた作業は数えない（今の作業だけと比べる）。
    await show(withTasks([duty({}), { ...twin, live: false }]), done('task:duty:n3:d1'));
    expect(button('記録する')).toBeDefined();
  });

  it('当番の札の元の文へのつなぎに、どのお知らせの物かを書く', async () => {
    const { ctx } = ctxWith({ kind: 'unowned', task: duty({}) });
    const titled = { ...ctx, sources: new Map([['n3', { id: 'n3', title: '（架空）連絡帳' }]]) };
    await step(() => root.render(<TodayScreen ctx={titled as unknown as Ctx} />));
    expect(button('「（架空）連絡帳」の文を見る')).toBeDefined();
  });
});
