// よていは、引き受け・外への返事・置けた時刻を分ける。架空の計画を画面に通し、未定を確定した予定にしない。
import type { ExternalRequest, Task } from '@maniau/core';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { formatTime } from '../src/format';
import { type Ctx, type Route, WeekScreen } from '../src/screens';
import { ctxFor } from './ctx';
import { step } from './fake-fetch';

const browser = new Window({ url: 'http://localhost/' });
const globals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'MouseEvent',
] as const;
const previous = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globals) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: browser[key] ?? browser,
  });
}
const { createRoot } = await import('react-dom/client');
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const task = (key: string, what: string, extra: Partial<Task> = {}): Task => ({
  key,
  titleKey: 'task.familyAction',
  titleParams: { what },
  basis: { itemIds: [] },
  durationMin: 15,
  after: [],
  segments: ['home'],
  travelBeforeMin: 0,
  travelAfterMin: 0,
  travelSource: 'none',
  commitment: 'proposed',
  live: true,
  ...extra,
});

function withPlan(ctx: Ctx, tasks: Task[], requests: ExternalRequest[] = []): Ctx {
  return {
    ...ctx,
    items: [],
    plan: { ...ctx.plan, arrangements: [], requirements: [], tasks, requests },
  };
}

describe('よていの作業と頼み事', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`提案・引き受け・再確認を分け、済みと使わない案を予定にしない（${lang}）`, () => {
      const base = ctxFor('chase', 'b', lang);
      const start = '2026-11-30T18:00+09:00';
      const ctx = withPlan(base, [
        task('proposed', 'PROPOSED', { start, assigneeId: 'b' }),
        task('accepted', 'ACCEPTED', { start, assigneeId: 'a', commitment: 'accepted' }),
        task('reconfirm', 'RECONFIRM', {
          start,
          assigneeId: 'a',
          commitment: 'accepted',
          reconfirm: true,
        }),
        task('done', 'DONE', { start, assigneeId: 'a', commitment: 'done' }),
        task('declined', 'DECLINED', { start, assigneeId: 'a', commitment: 'declined' }),
        task('withdrawn', 'WITHDRAWN', { start, assigneeId: 'a', commitment: 'withdrawn' }),
        task('inactive', 'INACTIVE', {
          start,
          basis: { itemIds: [], arrangementKey: 'arr:absent', optionKey: 'opt:absent' },
        }),
        task('cancel', 'CANCELCONTACT', {
          start,
          assigneeId: 'b',
          cancels: 'old-request',
          basis: { itemIds: [], arrangementKey: 'arr:absent', optionKey: 'opt:absent' },
        }),
        task('day', 'DAYONLY', {
          timing: 'day',
          earliestStart: '2026-11-30T00:00+09:00',
          commitment: 'accepted',
          assigneeId: 'a',
        }),
        task('no-date', 'UNDATED', {
          timing: 'undated',
          start,
          assigneeId: 'b',
        }),
        task('not-placed', 'UNPLACED', { assigneeId: 'a' }),
      ]);
      const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
      const shownTime = formatTime(start, lang, ctx.tz);
      expect(shown).toContain(`PROPOSED ${shownTime} ${ctx.t('week.statusProposed')}`);
      expect(shown).toContain(`ACCEPTED ${shownTime} ${ctx.t('week.statusAccepted')}`);
      expect(shown).toContain(`RECONFIRM ${shownTime} ${ctx.t('week.statusReconfirm')}`);
      expect(shown).not.toContain('DONE');
      expect(shown).not.toContain('INACTIVE');
      expect(shown).toContain(`CANCELCONTACT ${shownTime} ${ctx.t('week.statusProposed')}`);
      expect(shown).toContain('DAYONLY');
      const later = shown.indexOf(ctx.t('week.later'));
      const unplaced = shown.indexOf(ctx.t('week.unplacedTitle'));
      expect(later).toBeGreaterThan(0);
      expect(unplaced).toBeGreaterThan(later);
      expect(shown.slice(0, unplaced)).not.toContain('UNDATED');
      expect(shown.slice(unplaced)).toContain('UNDATED');
      expect(shown.slice(unplaced)).toContain('UNPLACED');
      expect(shown.slice(unplaced)).toContain(`DECLINED ${ctx.t('week.statusNeedsOwner')}`);
      expect(shown.slice(unplaced)).toContain(`WITHDRAWN ${ctx.t('week.statusNeedsOwner')}`);
      expect(shown.slice(unplaced)).not.toContain(`DECLINED ${shownTime}`);
      expect(shown.slice(unplaced)).not.toContain(`UNDATED ${shownTime}`);
    });

    it(`条件しだい・読み取り未確認の作業は、引き受け済みだけで確定と見せない（${lang}）`, () => {
      const base = ctxFor('chase', 'b', lang);
      const example = base.items[0];
      if (!example) throw new Error('架空の事項が無い');
      const conditional = task('conditional', 'CONDITIONAL', {
        start: '2026-11-30T18:00+09:00',
        assigneeId: 'a',
        commitment: 'accepted',
        basis: { itemIds: [example.item.id] },
      });
      const ctx = {
        ...withPlan(base, [conditional]),
        items: [{ ...example, conditional: true, trusted: false }],
      };
      const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
      const status = ctx.t('week.statusUnconfirmed', {
        status: ctx.t('week.statusConditional', { status: ctx.t('week.statusAccepted') }),
      });
      expect(shown).toContain(status);
    });

    it(`当番と時刻を確かめられない作業は、引き受けと別にそのまま示す（${lang}）`, () => {
      const base = ctxFor('chase', 'b', lang);
      const ctx = withPlan(base, [
        task('unsure-duty', 'DUTY', {
          timing: 'day',
          earliestStart: '2026-11-30T00:00+09:00',
          assigneeId: 'a',
          commitment: 'accepted',
          timeUnconfirmed: true,
          turnUnconfirmed: true,
        }),
      ]);
      const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
      const status = ctx.t('week.statusTurnUnconfirmed', {
        status: ctx.t('week.statusTimeUnconfirmed', { status: ctx.t('week.statusAccepted') }),
      });
      expect(shown).toContain(status);
      expect(shown).not.toContain(formatTime('2026-11-30T00:00+09:00', lang, ctx.tz));
    });

    it(`依頼の控えの日と返事の状態を出し、確認待ちを確定としない（${lang}）`, () => {
      const base = ctxFor('chase', 'b', lang);
      const original = base.plan.requests.find((request) => request.requestId === 'r-grandma');
      if (!original) throw new Error('架空の依頼が無い');
      const at = (start: string, end: string) => ({ start, end });
      const unmarked = {
        ...original,
        conditional: undefined,
        needsCheck: undefined,
        standalone: undefined,
      };
      const requests: ExternalRequest[] = [
        {
          ...unmarked,
          requestId: 'waiting',
          state: 'awaitingReply',
          live: true,
          window: at('2026-11-30T08:10+09:00', '2026-11-30T12:00+09:00'),
        },
        {
          ...unmarked,
          requestId: 'yes',
          state: 'confirmed',
          live: true,
          window: at('2026-12-01T08:10+09:00', '2026-12-01T17:00+09:00'),
        },
        {
          ...unmarked,
          requestId: 'check',
          state: 'confirmed',
          live: true,
          needsCheck: true,
          conditional: true,
          window: at('2026-12-02T08:10+09:00', '2026-12-02T16:00+09:00'),
        },
        {
          ...unmarked,
          requestId: 'no-window',
          state: 'awaitingReply',
          live: true,
          window: undefined,
        },
        {
          ...unmarked,
          requestId: 'cancelled',
          state: 'cancelled',
          live: false,
          window: at('2026-12-03T08:10+09:00', '2026-12-03T15:00+09:00'),
        },
      ];
      const ctx = withPlan(base, [], requests);
      const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
      const name = base.household.members.find((member) => member.id === original.to)?.name ?? '';
      const window = (from: string, to: string) =>
        ctx.t('week.requestWindow', {
          name,
          from: formatTime(`2026-11-30T${from}+09:00`, lang, ctx.tz),
          to: formatTime(`2026-11-30T${to}+09:00`, lang, ctx.tz),
        });
      expect(shown).toContain(`${window('08:10', '12:00')} ${ctx.t('week.replyWaiting')}`);
      expect(shown).toContain(`${window('08:10', '17:00')} ${ctx.t('week.replyYes')}`);
      const checkStatus = ctx.t('week.statusConditional', { status: ctx.t('week.replyYesCheck') });
      expect(shown).toContain(`${window('08:10', '16:00')} ${checkStatus}`);
      expect(shown).not.toContain(window('08:10', '15:00'));
      const noDate = shown.indexOf(ctx.t('week.undatedRequestsTitle'));
      expect(noDate).toBeGreaterThan(0);
      expect(shown.slice(noDate)).toContain(ctx.t('week.requestNoWindow', { name }));
      expect(shown.slice(noDate)).toContain(ctx.t('week.replyWaiting'));
    });

    it(`時間変更の返事待ちは前の依頼と分け、変更側に疑いが出たら確認待ちに戻す（${lang}）`, () => {
      const base = ctxFor('chase', 'b', lang);
      const original = base.plan.requests.find((request) => request.requestId === 'r-grandma');
      const arrangement = base.plan.arrangements.find(
        (entry) => entry.live && entry.key === original?.basis.arrangementKey,
      );
      if (!original?.window || !arrangement) throw new Error('架空の依頼か手配が無い');
      const oldWindow = { ...original.window, end: '2026-12-07T17:15+09:00' };
      const old: ExternalRequest = {
        ...original,
        window: oldWindow,
        conditional: undefined,
        state: 'confirmed',
        live: true,
        needsCheck: true,
        changeAsked: 'change',
      };
      const change: ExternalRequest = {
        ...original,
        requestId: 'change',
        window: { start: arrangement.start, end: arrangement.end },
        conditional: undefined,
        state: 'awaitingReply',
        live: true,
        needsCheck: undefined,
        replaces: { requestId: old.requestId, window: oldWindow },
      };
      const ctx = { ...base, plan: { ...base.plan, requests: [old, change] } };
      const waiting = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
      expect(waiting).toContain(ctx.t('week.oldYesChange'));
      expect(waiting).toContain(
        ctx.t('week.statusTimeChange', { status: ctx.t('week.replyWaiting') }),
      );
      const doubted = {
        ...ctx,
        plan: { ...ctx.plan, requests: [old, { ...change, needsCheck: true }] },
      };
      const checking = text(renderToStaticMarkup(<WeekScreen ctx={doubted} />));
      expect(checking).not.toContain(ctx.t('week.oldYesChange'));
      expect(checking).toContain(ctx.t('week.replyYesCheck'));
      expect(checking).toContain(ctx.t('week.replyWaitingCheck'));
    });
  }

  it('実際の見本の返事待ちと、学童の OK を、同じ状態として見せない', () => {
    const waiting = ctxFor('chase', 'b', 'ja');
    const accepted = ctxFor('backup', 'b', 'ja');
    const pendingText = text(renderToStaticMarkup(<WeekScreen ctx={waiting} />));
    const acceptedText = text(renderToStaticMarkup(<WeekScreen ctx={accepted} />));
    expect(pendingText).toContain(waiting.t('week.replyWaiting'));
    expect(acceptedText).toContain(accepted.t('week.replyYes'));
    expect(acceptedText).toContain('選んだ予備');
  });

  it.each(['ja', 'en'] as const)('作業から元のお知らせの文へ戻れる（%s）', async (lang) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const base = ctxFor('chase', 'b', lang);
    const example = base.items.find(({ item }) => base.sources.has(item.sourceId));
    if (!example) throw new Error('架空のお知らせが無い');
    const source = base.sources.get(example.item.sourceId);
    if (!source) throw new Error('出典が無い');
    const routes: Route[] = [];
    const ctx: Ctx = {
      ...withPlan(base, [
        task('with-source', 'SOURCE-TASK', {
          start: '2026-11-30T18:00+09:00',
          basis: { itemIds: [example.item.id] },
        }),
      ]),
      items: [{ ...example, live: false }],
      go: (route) => routes.push(route),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await step(() => root.render(<WeekScreen ctx={ctx} />));
      const label = ctx.t('week.source', {
        title: source.title?.trim() || ctx.t('week.untitledSource'),
      });
      const link = [...host.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === label,
      );
      expect(link).toBeDefined();
      expect(link?.textContent).toBe(ctx.t('week.sourceShort'));
      await step(() => link?.click());
      expect(routes).toEqual([
        { name: 'sources', sourceId: source.id, highlight: example.item.sentenceIds },
      ]);
    } finally {
      await step(() => root.unmount());
      host.remove();
    }
  });
});
