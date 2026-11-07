// @vitest-environment happy-dom
// 元の文と直す日付、見る→保存、誤って入れたお知らせと依頼の後始末を画面で確かめる。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Command,
  Household,
  type HouseholdPreview,
  type PreviewCommand,
  type Source,
} from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { AskScreen, type Ctx, SourcesScreen, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);
const source = {
  id: 'n1',
  sender: 'school',
  version: 1,
  medium: 'text',
  title: '架空の予定',
  receivedAt: '2026-11-25T19:31+09:00',
  sentences: [{ id: 'n1#1', text: '12月8日（火）はお休みです。' }],
} as Source;
const item = {
  id: 'n1:i1',
  sourceId: 'n1',
  sentenceIds: ['n1#1'],
  kind: 'dayChange',
  written: '12月8日（火）はお休みです。',
  evidence: 'stated',
  interpretation: { date: '2026-12-07', dayType: 'noSchool' },
  effects: [],
} as const;
const changes = {
  added: [],
  removed: [],
  moved: [],
  unplaced: [],
  placed: [],
  reassigned: [],
  changed: [],
  relocated: [],
  reconfirm: [],
  released: [],
  cancels: [],
  checks: [],
  deadlines: [],
  windows: [],
  preparations: [],
  unusedResources: [],
  recommendations: [],
  conflicts: [],
  rechoose: [],
};
const preview: HouseholdPreview = {
  changes,
  issues: [],
  unverified: [],
  seen: 'shown-hash',
  throughSeq: 7,
};
function context(lang: 'ja' | 'en' = 'ja') {
  const sent: unknown[] = [];
  const looked: PreviewCommand[] = [];
  const ctx = {
    household,
    me: household.members.find((m) => m.id === 'b'),
    plan: {
      throughSeq: 7,
      requirements: [],
      arrangements: [],
      tasks: [],
      requests: [],
      questions: [],
    },
    today: { main: [], quiet: [] },
    items: [{ item, live: true, conditional: false, trusted: true }],
    sources: new Map([[source.id, source]]),
    readings: [{ sourceId: 'n1', origin: 'live', model: 'fixture' }],
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-29T21:00+09:00',
    t: i18n.getFixedT(lang),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      sent.push(command);
      return { status: 'ok' };
    },
    previewChange: async (command: PreviewCommand) => {
      looked.push(command);
      return { preview };
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, sent, looked };
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
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
function enter(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('お知らせの直し', () => {
  it.each(['ja', 'en'] as const)(
    '送った画面の後で担当の記録が更新された時、記録できない理由と次の連絡先を示す (%s)',
    async (lang) => {
      const { ctx: base } = context(lang);
      const key = 'arr:childCare:n1:i1:c';
      const optionKey = `opt:${key}:opt-grandma`;
      const task = {
        key: `task:${optionKey}:ask`,
        live: true,
        titleKey: 'task.helper.ask',
        titleParams: {},
        assigneeId: 'b',
        basis: { itemIds: ['n1:i1'], arrangementKey: key, optionKey },
        external: { to: 'g', kind: 'reply' },
      } as Ctx['plan']['tasks'][number];
      const arrangement = {
        key,
        kind: 'childCare',
        live: true,
        childId: 'c',
        start: '2026-12-07T08:10+09:00',
        end: '2026-12-07T18:15+09:00',
        chosenOptionKey: optionKey,
        backupOptionKeys: [],
        reasons: [],
        options: [{ key: optionKey, templateId: 'opt-grandma', taskKeys: [task.key] }],
      } as Ctx['plan']['arrangements'][number];
      const ctx: Ctx = {
        ...base,
        plan: { ...base.plan, tasks: [task], arrangements: [arrangement] },
        send: async () => ({ status: 'conflict', reason: 'assignmentChanged' }),
      };
      await step(() => root.render(<AskScreen ctx={ctx} taskKey={task.key} />));
      await step(() => button(ctx.t('ask.sent'))?.click());
      expect(host.textContent).toContain(ctx.t('ask.assignmentChanged'));
      expect(button(ctx.t('ask.sent'))).toBeUndefined();
      expect(button(ctx.t('ask.copy'))).toBeUndefined();
      const stale: Ctx = { ...ctx, plan: { ...ctx.plan, tasks: [] } };
      await step(() => root.render(<AskScreen ctx={stale} taskKey={task.key} />));
      expect(host.textContent).toContain(ctx.t('ask.assignmentChanged'));
      expect(host.textContent).not.toContain(ctx.t('ask.gone'));
      expect(button(ctx.t('ask.sent'))).toBeUndefined();
    },
  );

  it.each(['ja', 'en'] as const)(
    '画面を開いたまま記録を断られた時も、送った相手に直接確かめるよう伝える (%s)',
    async (lang) => {
      const { ctx: base } = context(lang);
      const key = 'arr:childCare:n1:i1:c';
      const optionKey = `opt:${key}:opt-grandma`;
      const task = {
        key: `task:${optionKey}:ask`,
        live: true,
        titleKey: 'task.helper.ask',
        titleParams: {},
        assigneeId: 'b',
        basis: { itemIds: ['n1:i1'], arrangementKey: key, optionKey },
        external: { to: 'g', kind: 'reply' },
      } as Ctx['plan']['tasks'][number];
      const arrangement = {
        key,
        kind: 'childCare',
        live: true,
        childId: 'c',
        start: '2026-12-07T08:10+09:00',
        end: '2026-12-07T18:15+09:00',
        chosenOptionKey: optionKey,
        backupOptionKeys: [],
        reasons: [],
        options: [{ key: optionKey, templateId: 'opt-grandma', taskKeys: [task.key] }],
      } as Ctx['plan']['arrangements'][number];
      const ctx: Ctx = {
        ...base,
        plan: { ...base.plan, tasks: [task], arrangements: [arrangement] },
        send: async () => ({ status: 'failed', reason: 'taskGone' }),
      };
      await step(() => root.render(<AskScreen ctx={ctx} taskKey={task.key} />));
      await step(() => button(ctx.t('ask.sent'))?.click());
      expect(host.textContent).toContain(ctx.t('ask.recordUncertain'));
    },
  );

  it.each(['ja', 'en'] as const)(
    '外部から戻って画面が更新され作業が消えても、送った事実を元の版で記録できる (%s)',
    async (lang) => {
      const { ctx: base } = context(lang);
      const optionKey = 'opt:arr:childCare:n1:i1:c:opt-grandma';
      const arrangementKey = 'arr:childCare:n1:i1:c';
      const task = {
        key: `task:${optionKey}:ask`,
        live: true,
        titleKey: 'task.helper.ask',
        titleParams: {},
        assigneeId: 'b',
        basis: { itemIds: ['n1:i1'], arrangementKey, optionKey },
        external: { to: 'g', kind: 'reply' },
      } as Ctx['plan']['tasks'][number];
      const arrangement = {
        key: arrangementKey,
        kind: 'childCare',
        live: true,
        childId: 'c',
        start: '2026-12-07T08:10+09:00',
        end: '2026-12-07T18:15+09:00',
        chosenOptionKey: optionKey,
        backupOptionKeys: [],
        reasons: [],
        options: [{ key: optionKey, templateId: 'opt-grandma', taskKeys: [task.key] }],
      } as Ctx['plan']['arrangements'][number];
      const sent: Command[] = [];
      const initial: Ctx = {
        ...base,
        plan: { ...base.plan, tasks: [task], arrangements: [arrangement] },
        send: async (command) => {
          sent.push(command);
          return { status: 'ok' };
        },
      };
      await step(() => root.render(<AskScreen ctx={initial} taskKey={task.key} />));
      expect(button(initial.t('ask.copy'))).toBeDefined();
      const original = host.querySelector('p.whitespace-pre-line')?.textContent;
      const changed: Ctx = {
        ...initial,
        now: '2026-12-01T12:00+09:00',
        plan: {
          ...initial.plan,
          throughSeq: initial.plan.throughSeq + 1,
          arrangements: initial.plan.arrangements.map((entry) => ({
            ...entry,
            start: '2026-12-08T08:10+09:00',
            end: '2026-12-08T18:15+09:00',
          })),
        },
      };
      await step(() => root.render(<AskScreen ctx={changed} taskKey={task.key} />));
      expect(host.textContent).toContain(changed.t('ask.changed'));
      expect(host.querySelector('p.whitespace-pre-line')?.textContent).toBe(original);
      expect(button(changed.t('ask.copy'))).toBeUndefined();
      await step(() => button(changed.t('ask.sent'))?.click());
      expect(sent[0]).toMatchObject({
        type: 'recordSent',
        taskKey: task.key,
        shown: { throughSeq: initial.plan.throughSeq, at: initial.now },
        window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
      });
      const later: Ctx = {
        ...changed,
        plan: {
          ...changed.plan,
          tasks: changed.plan.tasks.filter((entry) => entry.key !== task.key),
        },
      };
      await step(() => root.render(<AskScreen ctx={later} taskKey={task.key} />));
      expect(host.textContent).toContain(later.t('ask.gone'));
      expect(button(later.t('ask.copy'))).toBeUndefined();
      await step(() => button(later.t('ask.sent'))?.click());
      expect(sent[1]).toMatchObject({
        type: 'recordSent',
        taskKey: task.key,
        shown: { throughSeq: initial.plan.throughSeq, at: initial.now },
      });
      // 原文が削除されたら、この画面に残した文も見せない。
      await step(() =>
        root.render(<AskScreen ctx={{ ...later, sources: new Map() }} taskKey={task.key} />),
      );
      expect(host.textContent).not.toContain(later.t('ask.gone'));
      expect(button(later.t('ask.sent'))).toBeUndefined();
    },
  );
  it.each(['ja', 'en'] as const)(
    '控えの足りない以前のお願いがある時は、外せないことを %s で伝える',
    async (lang) => {
      const { ctx, sent } = context(lang);
      ctx.previewChange = async () => ({ refused: 'legacyRequestUnclear' });
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const discard = [...host.querySelectorAll('details')].find((section) =>
        section.textContent?.includes(ctx.t('sourceFix.discard.body')),
      );
      const misread = discard?.querySelector<HTMLInputElement>('input[type=radio][value=misread]');
      await step(() => misread?.click());
      const look = [...(discard?.querySelectorAll('button') ?? [])].find(
        (entry) => entry.textContent === ctx.t('sourceFix.look'),
      );
      await step(() => look?.click());
      expect(host.textContent).toContain(ctx.t('sourceFix.discard.legacy'));
      expect(button(ctx.t('sourceFix.discard.save'))).toBeUndefined();
      expect(sent).toEqual([]);
    },
  );

  it.each(['ja', 'en'] as const)(
    '今は条件が合わない事項も、原文と見比べて日付を直せる (%s)',
    async (lang) => {
      const { ctx: base, looked } = context(lang);
      const ctx = {
        ...base,
        items: base.items.map((entry) => ({ ...entry, live: false })),
      };
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      expect(host.textContent).toContain(ctx.t('sourceFix.date.open'));
      expect(host.textContent).toContain(ctx.t('sourceFix.date.inactive'));
      const input = host.querySelector<HTMLInputElement>('input[type=date]');
      if (!input) throw Error('日付欄が無い');
      await step(() => enter(input, '2026-12-14'));
      await step(() => button(ctx.t('sourceFix.look'))?.click());
      expect(looked[0]).toMatchObject({
        type: 'correctItem',
        itemId: 'n1:i1',
        interpretation: { date: '2026-12-14' },
      });
    },
  );

  it('日付の欄を開いた後にもう一人が日付を直したら、前の日付を直しとして見せず、入れ直してもらう', async () => {
    const { ctx, looked } = context();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const [entry] = ctx.items;
    if (!entry) throw Error('事項が無い');
    const moved = {
      ...ctx,
      items: [
        {
          ...entry,
          item: {
            ...entry.item,
            interpretation: { ...entry.item.interpretation, date: '2026-12-14' },
          },
        },
      ],
    } as Ctx;
    await step(() => root.render(<SourcesScreen ctx={moved} sourceId="n1" />));
    const edit = [...host.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('読み取った日付を直す'),
    );
    expect(edit?.textContent).toContain('この事項は、開いた後に直されました。');
    const look = () =>
      [...(edit?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === '変わることを見る',
      );
    expect(look()?.disabled).toBe(true);
    await step(() => button('今の内容を入れ直す')?.click());
    expect(edit?.querySelector<HTMLInputElement>('input[type=date]')?.value).toBe('2026-12-14');
    expect(edit?.textContent).not.toContain('この事項は、開いた後に直されました。');
    expect(looked).toEqual([]);
  });

  it('原文と読み取った日を見せ、別の日に直す時はその日で見直してから保存する', async () => {
    const { ctx, looked, sent } = context();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    expect(host.textContent).toContain('12月8日（火）はお休みです。');
    expect(host.textContent).toContain('読み取った日付：12/7（月）');
    const input = host.querySelector<HTMLInputElement>('input[type=date]');
    if (!input) throw Error('日付欄が無い');
    await step(() => enter(input, '2026-12-08'));
    await step(() => button('変わることを見る')?.click());
    expect(looked[0]).toMatchObject({
      type: 'correctItem',
      itemId: 'n1:i1',
      interpretation: { date: '2026-12-08' },
    });
    expect(button('この日付で記録する')).toBeDefined();
    await step(() => enter(input, '2026-12-09'));
    expect(button('この日付で記録する')).toBeUndefined();
    await step(() => button('変わることを見る')?.click());
    await step(() => button('この日付で記録する')?.click());
    expect(sent).toEqual([
      {
        type: 'correctItem',
        itemId: 'n1:i1',
        interpretation: { date: '2026-12-09' },
        seen: { throughSeq: 7, changes: 'shown-hash' },
      },
    ]);
  });

  it.each(['ja', 'en'] as const)(
    '読み取った曜日と違う日付では、原文を確かめる説明を出して記録を進めない (%s)',
    async (lang) => {
      const { ctx: base, looked } = context(lang);
      const ctx = {
        ...base,
        items: base.items.map((entry) => ({
          ...entry,
          item: {
            ...entry.item,
            interpretation: { ...entry.item.interpretation, writtenWeekday: 1 },
          },
        })),
      };
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const input = host.querySelector<HTMLInputElement>('input[type=date]');
      if (!input) throw Error('日付欄が無い');
      await step(() => enter(input, '2026-12-08'));
      expect(host.textContent).toContain(ctx.t('sourceFix.date.weekdayMismatch'));
      expect(button(ctx.t('sourceFix.look'))?.disabled).toBe(true);
      expect(looked).toEqual([]);
      await step(() => enter(input, '2026-12-14'));
      expect(button(ctx.t('sourceFix.look'))?.disabled).toBe(false);
    },
  );

  it.each(['ja', 'en'] as const)(
    '以前の依頼の控えが足りず日付を直せない時は、相手への確認を案内する (%s)',
    async (lang) => {
      const { ctx: base } = context(lang);
      const ctx: Ctx = {
        ...base,
        previewChange: async () => ({ refused: 'legacyRequestUnclear' }),
      };
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const input = host.querySelector<HTMLInputElement>('input[type=date]');
      if (!input) throw Error('日付欄が無い');
      await step(() => enter(input, '2026-12-14'));
      await step(() => button(ctx.t('sourceFix.look'))?.click());
      expect(host.textContent).toContain(ctx.t('sourceFix.date.legacy'));
      expect(button(ctx.t('sourceFix.date.save'))).toBeUndefined();
    },
  );

  it('読み取りの誤りは入れ間違いと分け、影響を見てから外す', async () => {
    const { ctx, looked, sent } = context();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    expect(host.textContent).toContain('行事が取り消されたとは扱いません');
    const summaries = [...host.querySelectorAll('summary')];
    await step(() =>
      summaries.find((s) => s.textContent?.includes('お知らせを計画から外す'))?.click(),
    );
    const sections = [...host.querySelectorAll('details')];
    const discard = sections.find((s) =>
      s.textContent?.includes('行事が取り消されたとは扱いません'),
    );
    const misread = discard?.querySelector<HTMLInputElement>('input[type=radio][value=misread]');
    await step(() => misread?.click());
    const look = [...(discard?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '変わることを見る',
    );
    await step(() => look?.click());
    expect(looked).toContainEqual({ type: 'discardSource', sourceId: 'n1', reason: 'misread' });
    await step(() => button('計画から外す')?.click());
    expect(sent).toContainEqual({
      type: 'discardSource',
      sourceId: 'n1',
      reason: 'misread',
      seen: { throughSeq: 7, changes: 'shown-hash' },
    });
  });

  it('外す理由は家族が選び、見た後に理由を替えたら再び影響を見る', async () => {
    const { ctx, looked } = context();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const discard = [...host.querySelectorAll('details')].find((s) =>
      s.textContent?.includes('行事が取り消されたとは扱いません'),
    );
    const look = () =>
      [...(discard?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === '変わることを見る',
      );
    expect(look()?.disabled).toBe(true);
    expect(discard?.querySelector('input[type=radio]:checked')).toBeNull();
    await step(() => discard?.querySelector<HTMLInputElement>('input[value=misfiled]')?.click());
    await step(() => look()?.click());
    expect(looked).toContainEqual({ type: 'discardSource', sourceId: 'n1', reason: 'misfiled' });
    expect(discard?.textContent).toContain('計画から外す');
    await step(() => discard?.querySelector<HTMLInputElement>('input[value=misread]')?.click());
    expect(
      [...(discard?.querySelectorAll('button') ?? [])].some(
        (b) => b.textContent === '計画から外す',
      ),
    ).toBe(false);
    expect(look()?.disabled).toBe(false);
  });

  it.each(['ja', 'en'] as const)(
    '別の画面で条件が増えたら、断った理由と更新する操作を見せる (%s)',
    async (lang) => {
      const { ctx } = context(lang);
      let refreshed = false;
      ctx.refresh = () => {
        refreshed = true;
      };
      ctx.previewChange = async () => ({ refused: 'dateLinkedCondition' });
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const input = host.querySelector<HTMLInputElement>('input[type=date]');
      if (!input) throw Error('日付欄が無い');
      await step(() => enter(input, '2026-12-08'));
      await step(() => button(lang === 'ja' ? '変わることを見る' : 'See what changes')?.click());
      expect(host.textContent).toContain(
        lang === 'ja'
          ? '条件・選択肢や答えが見つかったため'
          : 'A condition, choice or answer using this date',
      );
      await step(() => button(lang === 'ja' ? '画面を更新する' : 'Refresh the screen')?.click());
      expect(refreshed).toBe(true);
    },
  );

  it.each(['ja', 'en'] as const)(
    '同じ日を使う条件があれば、名前と値を示して日付だけの保存を止める (%s)',
    async (lang) => {
      const { ctx, looked } = context(lang);
      const first = ctx.items[0];
      if (!first) throw Error('事項が無い');
      ctx.items[0] = {
        ...first,
        dateLinks: [{ label: '発表会の実施日', value: '2026-12-07' }],
      };
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const input = host.querySelector<HTMLInputElement>('input[type=date]');
      if (!input) throw Error('日付欄が無い');
      await step(() => enter(input, '2026-12-08'));
      expect(host.textContent).toContain('発表会の実施日');
      expect(host.textContent).toContain(
        lang === 'ja' ? '同じ日を指すかは分かりません' : 'may or may not be the same date',
      );
      expect(host.textContent).toContain(
        lang === 'ja' ? 'お知らせを新しく読み込めません' : 'cannot read a new notice',
      );
      const parent = input.closest('div');
      const look = [...(parent?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent?.trim() === (lang === 'ja' ? '変わることを見る' : 'See what changes'),
      );
      expect(look?.disabled).toBe(true);
      await step(() => look?.click());
      expect(looked).toEqual([]);
    },
  );

  it('読み取れる時は、入れ直しにも回数が要ると外す前に伝える', async () => {
    const { ctx } = context();
    ctx.read = async () => ({ status: 'limit' });
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    expect(host.textContent).toContain('計画から外した後は、元に戻せません');
    expect(host.textContent).toContain('入れ直しにも読み取りの回数が要ります');
  });

  it('外したお知らせでも原文は見せ、計画から外した理由を示し、重ねて外させない', async () => {
    const { ctx } = context();
    ctx.excludedSources = new Map([['n1', 'misread']]);
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    expect(host.textContent).toContain('12月8日（火）はお休みです。');
    expect(host.textContent).toContain('読み取りの誤りとして、計画から外しました');
    expect(host.textContent).not.toContain('正しい日付');
    expect(host.textContent).not.toContain('外す理由');
  });

  it('家族が直接書いたすることに、お知らせの読み間違いの操作を出さない', async () => {
    const { ctx } = context();
    ctx.readings = [];
    ctx.sources = new Map([['n1', { ...source, sender: 'family' }]]);
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    expect(host.textContent).not.toContain('お知らせを計画から外す');
    expect(host.textContent).not.toContain('読み取った日付を直す');
  });

  it.each(['ja', 'en'] as const)(
    '手配の無い旧依頼を控えとともに見せ、本人の判断を送る (%s)',
    async (lang) => {
      const { ctx, sent } = context(lang);
      const request = {
        requestId: 'r1',
        taskKey: 'task1',
        to: 'g',
        kind: 'reply',
        sentBy: 'b',
        sentAt: '2026-11-25T20:00+09:00',
        state: 'awaitingReply',
        live: true,
        needsCheck: true,
        childId: 'c',
        window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        basis: { itemIds: ['n1:i1'], arrangementKey: 'arr:childCare:n1:i1:c' },
      };
      ctx.plan.requests = [request] as Ctx['plan']['requests'];
      ctx.today.main = [{ kind: 'check', request }] as Ctx['today']['main'];
      await step(() => root.render(<TodayScreen ctx={ctx} />));
      expect(host.textContent).toContain(
        lang === 'ja' ? '新しい手配の確保には数えません' : 'does not secure a new arrangement',
      );
      const label = lang === 'ja' ? 'このお願いはまだ要る' : 'Still need this request';
      await step(() => button(label)?.click());
      expect(sent).toEqual([
        { type: 'resolveRequestCheck', requestId: 'r1', decision: 'keep', seen: { throughSeq: 7 } },
      ]);
    },
  );

  it.each(['ja', 'en'] as const)(
    '依頼の手が選ばれているため断られたら、決める画面を案内する (%s)',
    async (lang) => {
      const { ctx: base } = context(lang);
      const request = {
        requestId: 'r1',
        taskKey: 'task1',
        to: 'g',
        kind: 'reply',
        sentBy: 'b',
        sentAt: '2026-11-25T20:00+09:00',
        state: 'confirmed',
        live: true,
        needsCheck: true,
        childId: 'c',
        window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        basis: { itemIds: ['n1:i1'], arrangementKey: 'arr:childCare:n1:i1:c' },
      };
      const ctx = {
        ...base,
        plan: { ...base.plan, requests: [request] as Ctx['plan']['requests'] },
        today: { ...base.today, main: [{ kind: 'check', request }] as Ctx['today']['main'] },
        send: async () => ({ status: 'conflict' as const, reason: 'optionStillChosen' }),
      };
      await step(() => root.render(<TodayScreen ctx={ctx} />));
      await step(() => button(ctx.t('card.check.cancel'))?.click());
      expect(host.textContent).toContain(ctx.t('card.check.stillChosen'));
    },
  );

  it.each(['ja', 'en'] as const)(
    '同じ日の選択中の手は決める画面に戻し、別の日の旧依頼は本人が外せる (%s)',
    async (lang) => {
      const { ctx, sent } = context(lang);
      const key = 'arr:childCare:n1:i1:c';
      const optionKey = `opt:${key}:opt-grandma`;
      const request = {
        requestId: 'r1',
        taskKey: 'task1',
        to: 'g',
        kind: 'reply',
        sentBy: 'b',
        sentAt: '2026-11-25T20:00+09:00',
        state: 'confirmed',
        live: true,
        needsCheck: true,
        childId: 'c',
        window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        basis: { itemIds: ['n1:i1'], arrangementKey: key, optionKey },
      };
      const option = { key: optionKey, templateId: 'opt-grandma', taskKeys: [] };
      const arrangement = {
        key,
        kind: 'childCare',
        live: true,
        childId: 'c',
        start: '2026-12-07T08:10+09:00',
        end: '2026-12-07T19:15+09:00',
        chosenOptionKey: optionKey,
        backupOptionKeys: [],
        reasons: [],
        options: [option],
      };
      ctx.plan.requests = [request] as Ctx['plan']['requests'];
      ctx.plan.arrangements = [arrangement] as Ctx['plan']['arrangements'];
      ctx.today.main = [{ kind: 'check', request }] as Ctx['today']['main'];
      await step(() => root.render(<TodayScreen ctx={ctx} />));
      expect(button(ctx.t('card.check.action'))).toBeDefined();
      expect(button(ctx.t('card.check.cancel'))).toBeUndefined();
      const unusable = { ...option, unusable: true };
      const nowUnusable = { ...arrangement, options: [unusable] };
      await step(() =>
        root.render(
          <TodayScreen
            ctx={{
              ...ctx,
              plan: { ...ctx.plan, arrangements: [nowUnusable] as Ctx['plan']['arrangements'] },
            }}
          />,
        ),
      );
      expect(button(ctx.t('card.unowned.dropPrimary'))).toBeDefined();
      const oldDay = {
        ...nowUnusable,
        start: '2026-12-14T08:10+09:00',
        end: '2026-12-14T19:15+09:00',
      };
      await step(() =>
        root.render(
          <TodayScreen
            ctx={{
              ...ctx,
              plan: { ...ctx.plan, arrangements: [oldDay] as Ctx['plan']['arrangements'] },
            }}
          />,
        ),
      );
      expect(button(ctx.t('card.unowned.dropPrimary'))).toBeUndefined();
      await step(() => button(ctx.t('card.check.cancel'))?.click());
      expect(sent).toEqual([
        {
          type: 'resolveRequestCheck',
          requestId: 'r1',
          decision: 'cancel',
          seen: { throughSeq: 7 },
        },
      ]);
    },
  );

  // 11/7 体検：画面が日付の直ししか出していなかった。時刻・名前の直しと、一件だけ外すことを足した。
  function withEvent(
    lang: 'ja' | 'en' = 'ja',
    times: { startTime?: string; endTime?: string } = {},
  ) {
    const made = context(lang);
    const event = {
      ...item,
      kind: 'event',
      written: '1年生の発表は9時20分からです。',
      interpretation: {
        date: '2026-12-05',
        startTime: '09:20',
        what: '1年生の発表',
        ...times,
      },
    };
    const ctx = {
      ...made.ctx,
      items: [{ item: event, live: true, conditional: false, trusted: true }],
    };
    return { ...made, ctx: ctx as unknown as Ctx };
  }
  const section = (summary: string) =>
    [...host.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes(summary),
    );

  it('時刻と名前を直す：変わることを見てから記録し、変えた欄だけを送る', async () => {
    const { ctx, looked, sent } = withEvent();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const edit = section('時刻・名前を直す');
    expect(edit?.textContent).toContain('読み取った名前：1年生の発表');
    expect(edit?.textContent).toContain('時刻：09:20–');
    const start = edit?.querySelector<HTMLInputElement>('input[type=time]');
    if (!start) throw Error('時刻の欄が無い');
    await step(() => enter(start, '10:00'));
    const look = [...(edit?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '変わることを見る',
    );
    await step(() => look?.click());
    expect(looked).toContainEqual({
      type: 'correctItem',
      itemId: 'n1:i1',
      interpretation: { startTime: '10:00' },
    });
    await step(() => button('この内容で記録する')?.click());
    expect(sent).toContainEqual({
      type: 'correctItem',
      itemId: 'n1:i1',
      interpretation: { startTime: '10:00' },
      seen: { throughSeq: 7, changes: 'shown-hash' },
    });
  });

  it('終わりが始まりより前なら、理由を出して見ることも記録もさせない', async () => {
    const { ctx, looked } = withEvent();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const edit = section('時刻・名前を直す');
    const [start, end] = [...(edit?.querySelectorAll<HTMLInputElement>('input[type=time]') ?? [])];
    if (!start || !end) throw Error('時刻の欄が無い');
    await step(() => enter(start, '10:00'));
    await step(() => enter(end, '09:00'));
    expect(edit?.textContent).toContain('終わりは、始まりより後にしてください（日をまたぐ');
    const look = [...(edit?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '変わることを見る',
    );
    expect(look?.disabled).toBe(true);
    expect(looked).toEqual([]);
  });

  it('読み取った欄は空にできない：結びを空にして始まりを替える・名前を空にして時刻を替えると、見ることも記録もさせない', async () => {
    const { ctx, looked } = withEvent('ja', { startTime: '10:00', endTime: '12:00' });
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const edit = section('時刻・名前を直す');
    const [start, end] = [...(edit?.querySelectorAll<HTMLInputElement>('input[type=time]') ?? [])];
    const name = edit?.querySelector<HTMLInputElement>('input:not([type])');
    if (!start || !end || !name) throw Error('欄が無い');
    const look = () =>
      [...(edit?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === '変わることを見る',
      );
    // 10–12 を、始まり 13:00・終わり空に：前の終わり 12:00 が残るので、記録させない。
    await step(() => enter(start, '13:00'));
    await step(() => enter(end, ''));
    expect(edit?.textContent).toContain('読み取った時刻や名前を、空にはできません。');
    expect(look()?.disabled).toBe(true);
    // 終わりを戻しても、始まり 13:00 は前の終わり 12:00 より後：順が逆なので記録させない。
    await step(() => enter(end, '12:00'));
    expect(edit?.textContent).toContain('終わりは、始まりより後にしてください（日をまたぐ');
    expect(look()?.disabled).toBe(true);
    // 名前だけを空にして時刻を正しく替えても、記録させない。
    await step(() => enter(end, '14:00'));
    await step(() => enter(name, ''));
    expect(edit?.textContent).toContain('読み取った時刻や名前を、空にはできません。');
    expect(look()?.disabled).toBe(true);
    // 名前を入れれば見られる（変えた欄だけを送る）。
    await step(() => enter(name, '1年生の発表'));
    expect(look()?.disabled).toBe(false);
    await step(() => look()?.click());
    expect(looked).toContainEqual({
      type: 'correctItem',
      itemId: 'n1:i1',
      interpretation: { startTime: '13:00', endTime: '14:00' },
    });
  });

  it('見た後に記録が進んだら見せ直し、開いた後にもう一人が直した事項は、前の値を直しとして送らない', async () => {
    const { ctx, looked } = withEvent();
    await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
    const edit = () => section('時刻・名前を直す');
    const start = edit()?.querySelector<HTMLInputElement>('input[type=time]');
    if (!start) throw Error('時刻の欄が無い');
    await step(() => enter(start, '10:00'));
    const look = () =>
      [...(edit()?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === '変わることを見る',
      );
    await step(() => look()?.click());
    expect(button('この内容で記録する')).toBeDefined();
    // 見た後に、もう一人の記録で計画の版が進んだ：前の見た物で記録させない。
    const later = { ...ctx, plan: { ...ctx.plan, throughSeq: 8 } } as Ctx;
    await step(() => root.render(<SourcesScreen ctx={later} sourceId="n1" />));
    expect(host.textContent).toContain('この画面を開いた後に家族の記録が変わりました。');
    expect(button('この内容で記録する')).toBeUndefined();
    // もう一人が同じ事項の名前を直した：開いた時の値を直しとして送らず、入れ直してもらう。
    const [entry] = ctx.items;
    if (!entry) throw Error('事項が無い');
    const renamed = {
      ...later,
      items: [
        {
          ...entry,
          item: {
            ...entry.item,
            interpretation: { ...entry.item.interpretation, what: '1年生の発表（直された）' },
          },
        },
      ],
    } as Ctx;
    await step(() => root.render(<SourcesScreen ctx={renamed} sourceId="n1" />));
    expect(edit()?.textContent).toContain('この事項は、開いた後に直されました。');
    expect(look()?.disabled).toBe(true);
    await step(() => button('今の内容を入れ直す')?.click());
    expect(edit()?.querySelector<HTMLInputElement>('input:not([type])')?.value).toBe(
      '1年生の発表（直された）',
    );
    expect(edit()?.textContent).not.toContain('この事項は、開いた後に直されました。');
    expect(looked).toHaveLength(1);
  });

  it.each(['ja', 'en'] as const)(
    '一件だけ外す：理由を選び、変わることを見てから外す（お知らせごと外すのとは別）(%s)',
    async (lang) => {
      const { ctx, looked, sent } = withEvent(lang);
      await step(() => root.render(<SourcesScreen ctx={ctx} sourceId="n1" />));
      const remove = section(ctx.t('sourceFix.item.dismissOpen'));
      expect(remove?.textContent).toContain(ctx.t('sourceFix.item.dismissNote'));
      const misread = remove?.querySelector<HTMLInputElement>('input[type=radio][value=misread]');
      await step(() => misread?.click());
      const look = [...(remove?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === ctx.t('sourceFix.look'),
      );
      await step(() => look?.click());
      expect(looked).toContainEqual({ type: 'dismissItem', itemId: 'n1:i1', reason: 'misread' });
      await step(() => button(ctx.t('sourceFix.item.dismissSave'))?.click());
      expect(sent).toContainEqual({
        type: 'dismissItem',
        itemId: 'n1:i1',
        reason: 'misread',
        seen: { throughSeq: 7, changes: 'shown-hash' },
      });
    },
  );

  it('条件が合わず今の計画に無い事項は、日付の欄にだけ出し、時刻・名前の直しと外す欄には出さない', async () => {
    const { ctx } = withEvent();
    const [entry] = ctx.items;
    if (!entry) throw Error('事項が無い');
    const inactive = { ...ctx, items: [{ ...entry, live: false }] };
    await step(() => root.render(<SourcesScreen ctx={inactive} sourceId="n1" />));
    expect(section('読み取った日付を直す')?.textContent).toContain('条件が合わないため');
    expect(section('時刻・名前を直す')).toBeUndefined();
    expect(section('一件だけ計画から外す')).toBeUndefined();
  });
});
