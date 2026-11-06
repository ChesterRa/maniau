// 子の居場所の手で、手配の時間のうち見てもらえない時間がある時の画面：足りない手は理由を書いて選ぶボタンを出さず、
// 今使う手が後から足りなくなれば、決める画面と「きょう」の札にその時間を書く。休みを引き受ける本人には、その日の
// その時間に子を見ることを、引き受ける札に書く。見本の家族（架空）を、サーバーと同じ命令の道で動かす。
import {
  afterSchoolOption,
  type Command,
  type DomainEvent,
  type Household,
  leaveOption,
  proposalSnapshot,
} from '@maniau/core';
import { keys } from '@maniau/core/engine';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { DEMO_STAGES, demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, careNotCovered, DecideScreen, TodayScreen } from '../src/screens';
import { demoData } from './ctx';
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

const CARE = 'arr:childCare:n1:i6:c';
let host: HTMLDivElement;
let root: Root;

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

/** 文字の合うボタン（無ければ undefined）。 */
const buttonOf = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

/**
 * 見本の段から始め、画面と同じ命令で家の情報を直し（edit が無ければ直さない）、手を選ぶ（サーバーの道）。start は、
 * 始める前の架空の家（手は消せないので、消した形や前からの記録の形から始める時に使う）。
 */
async function family(
  edit: ((h: Household) => Household) | undefined,
  start: (h: Household) => Household = (h) => h,
  stage: Parameters<typeof demoEvents>[0] = 'arrived',
) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const initial = demoEvents(stage).map((event) =>
    event.type === 'householdSet' ? { ...event, household: start(event.household) } : event,
  );
  const store = memoryStore(new Map([['demo', initial]]));
  let op = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()] as DomainEvent[]);
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `w-${++op}`, now, demo: true }, command);
  const home = async () => {
    const set = (await events()).findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家庭が無い');
    return set.household;
  };
  const save = async (next: Household) => {
    const preview = previewChange(
      await events(),
      { memberId: 'a', now },
      {
        type: 'updateHousehold',
        household: next,
      },
    );
    if ('status' in preview) throw new Error(`preview: ${preview.status}`);
    expect(
      await run('a', {
        type: 'updateHousehold',
        household: next,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
  };
  if (edit) await save(edit(structuredClone(await home())));
  /** その大人・その言葉の画面の材料。 */
  const ctx = async (memberId: string, lang: 'ja' | 'en' = 'ja'): Promise<Ctx> => {
    const me = demoData.household.members.find((m) => m.id === memberId);
    if (!me) throw new Error('大人が無い');
    const view = viewFor(await events(), memberId, now);
    return {
      plan: view.plan,
      household: view.household,
      today: view.today,
      ...(view.changes ? { changes: view.changes } : {}),
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: demoData.readings,
      me,
      lang,
      tz: view.household.timeZone,
      now: view.now,
      t: i18n.getFixedT(lang),
      outbound: (lng) => i18n.getFixedT(lng),
      preview: async () => undefined,
      send: async () => ({ status: 'ok' }),
      go: () => {},
    };
  };
  return { run, home, save, ctx };
}

/** 見本の家族にあらかじめある休みの手を除く（休みの手を家族が足す形で入れる、架空の初期条件）。 */
const withoutLeave = (h: Household): Household => ({
  ...h,
  careOptions: h.careOptions.filter((o) => o.kind !== 'paidLeave'),
});

describe('学童の一日利用の時間が、手配の時間より短い', () => {
  it('足りない時間を書き、その手には選ぶボタンを出さない（見本の学童は選べる）', async () => {
    const { ctx } = await family((h) => {
      h.places.push({ id: 'p-short', kind: 'afterSchoolCare', name: '架空の短い学童', goods: [] });
      h.careOptions.push(
        afterSchoolOption(
          'opt-short',
          'p-short',
          { type: 'daysBefore', days: 3, at: '21:00' },
          500,
          false,
          { start: '09:00', end: '16:00' },
        ),
      );
      return h;
    });
    for (const lang of ['ja', 'en'] as const) {
      const c = await ctx('a', lang);
      await step(() => root.render(<DecideScreen ctx={c} arrangementKey={CARE} />));
      const arrangement = c.plan.arrangements.find((a) => a.key === CARE);
      const short = arrangement?.options.find((o) => o.templateId === 'opt-short');
      const full = arrangement?.options.find((o) => o.templateId === 'opt-gakudo');
      if (!short || !full) throw new Error('手が無い');
      const spans =
        lang === 'ja' ? ['8:10–9:00', '16:00–18:15'] : ['8:10 AM–9:00 AM', '4:00 PM–6:15 PM'];
      const gaps = new Intl.ListFormat(lang, { type: 'conjunction' }).format(spans);
      const cards = [...host.querySelectorAll('div.rounded-\\[18px\\]')];
      const shortCard = cards.find((card) =>
        card.textContent?.includes(c.t('decide.careCoverGaps', { gaps })),
      );
      expect(shortCard, `${lang}: ${host.textContent}`).toBeDefined();
      expect(shortCard?.querySelector('button')).toBeNull();
      // 「いま選べる手」に数えない（見本の学童・二人の休み・祖母の四つ）。
      const summary = c.t('clock.summary', {
        count: 4,
        option: c.t('option.afterSchoolFullDay.title'),
        when: '',
      });
      expect(host.textContent).toContain(summary.split(lang === 'ja' ? '。' : '.')[0]);
      // 足りない時間の無い見本の学童には、選ぶボタンがある。
      expect(cards.filter((card) => card.querySelector('button')).length).toBeGreaterThan(0);
    }
  });
});

describe('今使う手が、後から足りなくなる', () => {
  it('休む大人にその日の手が離せない時間を足すと、決める画面と「きょう」の札にその時間を書く', async () => {
    const { run, home, save, ctx } = await family(
      (h) => ({
        ...h,
        careOptions: [...h.careOptions, leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00')],
      }),
      withoutLeave,
    );
    const optionKey = keys.option(CARE, 'opt-leave-new');
    expect(
      await run('a', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const busy = structuredClone(await home());
    busy.unavailable = [
      ...(busy.unavailable ?? []),
      { id: 'u-busy', memberId: 'a', date: '2026-12-07', start: '11:00', end: '12:00' },
    ];
    await save(busy);
    const c = await ctx('a');
    await step(() => root.render(<DecideScreen ctx={c} arrangementKey={CARE} />));
    const option = c.t('option.paidLeave.title', { name: '健太' });
    expect(host.textContent).toContain(
      c.t('decide.careNotCovered', { option, gaps: '11:00–12:00' }),
    );
    await step(() => root.render(<TodayScreen ctx={c} />));
    expect(host.textContent).toContain(c.t('card.decide.careNotCovered', { gaps: '11:00–12:00' }));
  });
});

describe('休みを引き受ける本人', () => {
  it('もう一人が休みを提案すると、引き受ける札に、その日のその時間に子を見ることを書く', async () => {
    const { run, ctx } = await family(
      (h) => ({
        ...h,
        careOptions: [...h.careOptions, leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00')],
      }),
      withoutLeave,
    );
    // 大人 B（美咲）が、健太の休みを本命に選ぶ（休みを伝えるのは健太だけ）。
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: keys.option(CARE, 'opt-leave-new'),
        role: 'primary',
      }),
    ).toMatchObject({ status: 'ok' });
    const c = await ctx('a');
    await step(() => root.render(<TodayScreen ctx={c} />));
    const arrangement = c.plan.arrangements.find((a) => a.key === CARE);
    if (!arrangement) throw new Error('手配が無い');
    const child = c.household.members.find((m) => m.id === arrangement.childId)?.name ?? '';
    expect(host.textContent).toContain(
      c.t('card.proposal.careWatch', {
        name: '健太',
        child,
        day: '12/7（月）',
        from: '8:10',
        to: '18:15',
      }),
    );
  });
});

describe('使えないとした手', () => {
  it('選んでいない手は、使えないとした手と書き、選ぶボタンを出さない。今使う手なら、決める画面と札にそう書く', async () => {
    const mark =
      (id: string) =>
      (h: Household): Household => ({
        ...h,
        unusableCareOptionIds: [...(h.unusableCareOptionIds ?? []), id],
      });
    const unchosen = await family(mark('opt-gakudo'));
    const c = await unchosen.ctx('a');
    await step(() => root.render(<DecideScreen ctx={c} arrangementKey={CARE} />));
    const cards = [...host.querySelectorAll('div.rounded-\\[18px\\]')];
    const gakudo = cards.find((card) => card.textContent?.includes(c.t('decide.careUnusable')));
    expect(gakudo, host.textContent ?? '').toBeDefined();
    expect(gakudo?.querySelector('button')).toBeNull();

    // 見本の段 asked：祖母に頼んで返事待ちの本命を、使えないとする。
    const inUse = await family(mark('opt-grandma'), undefined, 'asked');
    for (const lang of ['ja', 'en'] as const) {
      const d = await inUse.ctx('b', lang);
      const arrangement = d.plan.arrangements.find((a) => a.key === CARE);
      if (!arrangement) throw new Error('手配が無い');
      const uncovered = careNotCovered(d, arrangement);
      expect(uncovered?.unusable).toBe(true);
      await step(() => root.render(<DecideScreen ctx={d} arrangementKey={CARE} />));
      expect(host.textContent).toContain(
        d.t('decide.careNotCoveredUnusable', { option: uncovered?.option }),
      );
      await step(() => root.render(<TodayScreen ctx={d} />));
      expect(host.textContent).toContain(d.t('card.decide.careNotCoveredUnusable'));
      // 頼み事を確かめる札は、お知らせが変わったとは言わず、使えないとしたからと書き、その手をやめられる。
      expect(host.textContent).toContain(d.t('card.check.bodyUnusableDrop'));
      expect(host.textContent).not.toContain(d.t('card.check.body'));
      expect(buttonOf(d.t('card.unowned.dropPrimary'))).toBeDefined();
    }
  });

  it('使えないとした予備の頼み事の札から、その予備をやめる（見せた作業と頼み事を付けて送る）', async () => {
    // 見本の段 backup：学童を予備に押さえ、「はい」をもらってある。
    const backup = await family(
      (h) => ({ ...h, unusableCareOptionIds: ['opt-gakudo'] }),
      undefined,
      'backup',
    );
    // 札は、頼んだ本人に出す。
    const sender = (await backup.ctx('a')).plan.requests.find(
      (r) => r.requestId === 'r-gakudo',
    )?.sentBy;
    if (!sender) throw new Error('頼んだ人が無い');
    const d = await backup.ctx(sender);
    const sent: Command[] = [];
    const c: Ctx = {
      ...d,
      send: async (command) => {
        sent.push(command);
        return { status: 'ok' };
      },
    };
    await step(() => root.render(<TodayScreen ctx={c} />));
    expect(host.textContent).toContain(c.t('card.check.bodyUnusableDrop'));
    await step(() => buttonOf(c.t('card.unowned.dropBackup'))?.click());
    const gakudo = keys.option(CARE, 'opt-gakudo');
    expect(sent).toEqual([
      {
        type: 'dropOption',
        arrangementKey: CARE,
        optionKey: gakudo,
        seen: {
          tasks: c.plan.tasks
            .filter((t) => t.live && t.basis.optionKey === gakudo)
            .map((t) => ({
              taskKey: t.key,
              assigneeId: t.assigneeId ?? null,
              commitment: t.commitment,
            })),
          requests: [{ requestId: 'r-gakudo', state: 'confirmed' }],
        },
      },
    ]);
  });

  it('引き受けていた作業が、使えないとした手の物なら、別の手を選んだとは言わない', async () => {
    const f = await family(undefined);
    const grandma = keys.option(CARE, 'opt-grandma');
    expect(
      await f.run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: grandma,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const ask = (await f.ctx('a')).plan.tasks.find((t) => t.key === `task:${grandma}:ask`);
    const shown = ask && proposalSnapshot(ask);
    if (!ask || !shown) throw new Error('頼む作業が無い');
    expect(await f.run('a', { type: 'accept', taskKey: ask.key, shown })).toMatchObject({
      status: 'ok',
    });
    await f.save({ ...(await f.home()), unusableCareOptionIds: ['opt-grandma'] });
    for (const lang of ['ja', 'en'] as const) {
      const d = await f.ctx('a', lang);
      await step(() => root.render(<TodayScreen ctx={d} />));
      expect(host.textContent).toContain(d.t('card.released.unusable'));
      expect(host.textContent).not.toContain(d.t('card.released.inactive'));
    }
  });
});

describe('見てもらえる時間の記録が無い、前からの手', () => {
  it('今使う手に時間の記録が無ければ、見てもらえないとは言わず、確かめられないと書く', async () => {
    // 前からの記録の形：祖母に頼む手から見てもらえる時間を外して始める（見本の段 asked：祖母に頼んで返事待ち）。
    const legacy = (h: Household): Household => ({
      ...h,
      careOptions: h.careOptions.map((o) => {
        if (o.id !== 'opt-grandma') return o;
        const { covers: _covers, ...rest } = o;
        return rest;
      }),
    });
    const { ctx } = await family(undefined, legacy, 'asked');
    for (const lang of ['ja', 'en'] as const) {
      const c = await ctx('b', lang);
      const arrangement = c.plan.arrangements.find((a) => a.key === CARE);
      if (!arrangement) throw new Error('手配が無い');
      const uncovered = careNotCovered(c, arrangement);
      expect(uncovered?.unknown).toBe(true);
      expect(uncovered?.gaps).toBe(lang === 'ja' ? '8:10–18:15' : '8:10 AM–6:15 PM');
      const said = { option: uncovered?.option, gaps: uncovered?.gaps };
      await step(() => root.render(<DecideScreen ctx={c} arrangementKey={CARE} />));
      expect(host.textContent).toContain(c.t('decide.careNotCoveredUnknown', said));
      expect(host.textContent).not.toContain(c.t('decide.careNotCovered', said));
      await step(() => root.render(<TodayScreen ctx={c} />));
      expect(host.textContent).toContain(
        c.t('card.decide.careNotCoveredUnknown', { gaps: uncovered?.gaps }),
      );
    }
  });
});

describe('学童の作業を頼まれた人', () => {
  it('引き受ける札に、だれの・どの日の見守りの作業かを書き、時間は書かない', async () => {
    const { run, ctx } = await family(undefined);
    // 美咲（b）が見本の学童を本命に選び、作業を健太（a）に頼む。
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: keys.option(CARE, 'opt-gakudo'),
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const c = await ctx('a');
    await step(() => root.render(<TodayScreen ctx={c} />));
    const arrangement = c.plan.arrangements.find((a) => a.key === CARE);
    if (!arrangement) throw new Error('手配が無い');
    const child = c.household.members.find((m) => m.id === arrangement.childId)?.name ?? '';
    expect(host.textContent).toContain(c.t('card.proposal.careFor', { child, day: '12/7（月）' }));
    // 学童の作業（申し込み・お弁当）には、見る時間を付けない（引き受けた約束に見せない）。
    const gakudo = arrangement.options.find((o) => o.templateId === 'opt-gakudo');
    const tasks = c.plan.tasks.filter((t) => gakudo?.taskKeys.includes(t.key));
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.watch === undefined)).toBe(true);
  });
});
