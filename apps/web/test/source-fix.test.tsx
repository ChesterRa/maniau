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
});
