// @vitest-environment happy-dom
// 送り迎えの札：置いた往復の目安ではなく、行事に書かれた始まり・終わりを見せ、往復は目安で道のりを確かめて
// いないと書く。根拠（家の決まりか、今回の言明か）を書き、「今回は要らない」で外せる。時刻の無い方は、
// 書かれていない・確かめてと書き分ける。出典の画面から「要る」に言い直せる。
import type { Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { type Ctx, SourcesScreen, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = {
  members: [
    { id: 'a', name: '健太', kind: 'adult', active: true },
    { id: 'b', name: '彩', kind: 'adult', active: true },
    { id: 'c', name: '陽菜', kind: 'child', active: true, clubEscort: { to: true, from: true } },
  ],
  places: [],
  careOptions: [],
};

const escort = (leg: 'to' | 'from', over: Partial<Task> = {}): Task =>
  ({
    key: `task:escort:${leg}:k1:e1`,
    titleKey: leg === 'to' ? 'task.escortTo' : 'task.escortFrom',
    titleParams: {
      what: 'サッカー練習',
      date: '2026-12-05',
      at: leg === 'to' ? '09:00' : '11:00',
      place: '若洲グラウンド（架空）',
    },
    basis: { itemIds: ['k1:e1'], requirementKey: 'req:escort:k1:e1' },
    durationMin: 60,
    earliestStart: leg === 'to' ? '2026-12-05T08:30+09:00' : '2026-12-05T10:30+09:00',
    deadline: leg === 'to' ? '2026-12-05T09:30+09:00' : '2026-12-05T11:30+09:00',
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

const TEXT = '12月5日(土)9:00〜11:00 サッカー練習（若洲グラウンド）';

const practice = (legs: { leg: 'to' | 'from'; needed: boolean; stated?: true }[]) => ({
  item: {
    id: 'k1:e1',
    sourceId: 'k1',
    sentenceIds: ['k1#1'],
    kind: 'event',
    written: TEXT,
    interpretation: { what: 'サッカー練習', date: '2026-12-05' },
    evidence: 'stated',
    effects: [],
  },
  live: true,
  conditional: false,
  trusted: true,
  escort: { childId: 'c', legs },
});

const RULE = [
  { leg: 'to' as const, needed: true },
  { leg: 'from' as const, needed: true },
];

function ctxWith(tasks: Task[], legs = RULE) {
  const sent: unknown[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[0],
    household,
    plan: { tasks, requirements: [], arrangements: [], requests: [], questions: [], throughSeq: 7 },
    today: { main: tasks.map((task) => ({ kind: 'unowned', task })), quiet: [] },
    items: [practice(legs)],
    sources: new Map([
      [
        'k1',
        {
          id: 'k1',
          version: 1,
          receivedAt: '2026-11-25T20:00+09:00',
          sender: 'club',
          language: 'ja',
          medium: 'text',
          title: '（架空）サッカークラブ',
          sentences: [{ id: 'k1#1', text: TEXT }],
        },
      ],
    ]),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, sent };
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

const buttons = (text: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('送り迎えの札', () => {
  it('書かれた始まり・終わりと場所を見せ、往復は目安と書き、家の決まりからだと示す', async () => {
    const { ctx } = ctxWith([escort('to'), escort('from')]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('サッカー練習の送り');
    expect(text).toContain('サッカー練習の迎え');
    expect(text).toContain('9:00に始まる');
    expect(text).toContain('11:00に終わる');
    expect(text).toContain(
      '8:30〜9:30は目安です（片道30分の往復として。道のりは確かめていません）',
    );
    expect(text).toContain('場所：若洲グラウンド（架空）');
    expect(text).toContain('陽菜の送り迎えの決まりから（行く前提です）');
    // 当番の「行き帰りの時間は入っていません」は、送り迎えには出さない（往復そのものが作業）。
    expect(text).not.toContain('行き帰りの時間は、入っていません');
    expect(text).not.toContain('締切');
  });

  it('「今回は要らない」は、その方だけを、見せた計画の番号を付けて言う', async () => {
    const { ctx, sent } = ctxWith([escort('from')]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const [off] = buttons('今回は要らない');
    await step(() => off?.click());
    expect(sent).toEqual([
      {
        type: 'stateEscort',
        itemId: 'k1:e1',
        leg: 'from',
        needed: false,
        seen: { throughSeq: 7 },
      },
    ]);
  });

  it('今回は要ると言った方は、そう示す', async () => {
    const legs = [
      { leg: 'to' as const, needed: false },
      { leg: 'from' as const, needed: true, stated: true as const },
    ];
    const { ctx } = ctxWith([escort('from')], legs);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('今回は要ると言いました');
    expect(host.textContent).not.toContain('決まりから');
  });

  it('時刻の無い方は、書かれていない・確かめてを書き分け、往復の目安を出さない', async () => {
    const day = {
      timing: 'day' as const,
      durationMin: 0,
      earliestStart: '2026-12-05T00:00+09:00',
      deadline: '2026-12-06T00:00+09:00',
      titleParams: { what: 'サッカー練習', date: '2026-12-05' },
    };
    const { ctx } = ctxWith([escort('from', day)]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('（時刻は書かれていません）');
    expect(host.textContent).not.toContain('目安です');
    const unsure = ctxWith([escort('from', { ...day, timeUnconfirmed: true })]).ctx;
    await step(() => root.render(<TodayScreen ctx={unsure} />));
    expect(host.textContent).toContain('（時刻は、元の文で確かめてください）');
    expect(host.textContent).not.toContain('書かれていません');
  });
});

describe('日を決められない迎え', () => {
  it('行事の日を迎えの日として見せず、日時を元の文で確かめてもらう（往復の目安も出さない）', async () => {
    const undated = escort('from', {
      timing: 'undated',
      timeUnconfirmed: true,
      durationMin: 0,
      earliestStart: undefined,
      deadline: undefined,
      titleParams: { what: 'サッカー練習', eventDate: '2026-12-05' },
    });
    const { ctx } = ctxWith([undated]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('12/5');
    expect(text).toContain('の行事の迎えです。迎えの日時は、元の文で確かめてください');
    expect(text).not.toContain('に終わる');
    expect(text).not.toContain('目安です');
  });
});

describe('出典の画面', () => {
  it('「今回は要らない」と言った方を、「要る」に言い直せる', async () => {
    const legs = [
      { leg: 'to' as const, needed: true },
      { leg: 'from' as const, needed: false, stated: true as const },
    ];
    const { ctx, sent } = ctxWith([escort('to')], legs);
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="k1" />));
    expect(buttons('送りは要る（今回は要らないとしました）')).toHaveLength(0);
    const [on] = buttons('迎えは要る（今回は要らないとしました）');
    await step(() => on?.click());
    expect(sent).toEqual([
      { type: 'stateEscort', itemId: 'k1:e1', leg: 'from', needed: true, seen: { throughSeq: 7 } },
    ]);
  });
});

describe('もう要らなくなった、引き受けた作業', () => {
  const released = {
    taskKey: 'task:escort:to:k1:e1',
    assigneeId: 'a',
    content: {
      titleKey: 'task.escortTo',
      titleParams: { what: 'サッカー練習', date: '2026-12-05', at: '09:00' },
    },
    start: '2026-12-05T08:30+09:00',
    end: '2026-12-05T09:30+09:00',
    reason: 'gone' as const,
  };

  it('約束した用件と時間を見せ、「分かりました」で引き受けを取り下げる', async () => {
    const { ctx, sent } = ctxWith([]);
    const shown = {
      ...ctx,
      plan: { ...ctx.plan, released: [released] },
      today: { main: [{ kind: 'released', released }], quiet: [] },
    } as unknown as Ctx;
    await step(() => root.render(<TodayScreen ctx={shown} />));
    const text = host.textContent ?? '';
    expect(text).toContain('もう要りません');
    expect(text).toContain('サッカー練習の送り（12/5');
    expect(text).toContain('8:30–9:30 にする約束でした。');
    expect(text).toContain('出かける前に確かめてください');
    const [ok] = buttons('分かりました');
    await step(() => ok?.click());
    expect(sent).toEqual([
      {
        type: 'acknowledgeReleased',
        taskKey: 'task:escort:to:k1:e1',
        seen: { throughSeq: 7 },
      },
    ]);
  });

  it('控えの無い引き受けは、中身が分からないと書き、時間を作らない', async () => {
    const { ctx } = ctxWith([]);
    const unknown = { taskKey: 'task:x', assigneeId: 'a', reason: 'gone' as const };
    const shown = {
      ...ctx,
      today: { main: [{ kind: 'released', released: unknown }], quiet: [] },
    } as unknown as Ctx;
    await step(() => root.render(<TodayScreen ctx={shown} />));
    expect(host.textContent).toContain('引き受けていた作業（中身の控えがありません）');
    expect(host.textContent).not.toContain('約束でした');
  });
});
