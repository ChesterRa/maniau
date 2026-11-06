// 「いつにするか」の候補の日を直す（画面）：足す・時間を直す・外す。保存の前に、計画で変わることに添えて、画面にある
// 答えと決めた日から確かに言えること（数えなくなる答え・外れる決めた日・まだ答えの無い足した候補）を書く。保存は、
// 前からある候補の id を付けて全部を送る（サーバーが時間の変わった候補の代を進め、前の代への答えは当てない）。頼んだ・
// 引き受けた後は入口を出さない。見本の家族（架空）の段「見てもらう日を決める」を、サーバーと同じ命令の道で動かす。
import type { Command, DomainEvent, PreviewCommand } from '@maniau/core';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { DEMO_STAGES, demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { StateNeedScreen } from '../src/need';
import { type Ctx, type Route, TodayScreen } from '../src/screens';
import { WhenScreen } from '../src/when';
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

const buttonOf = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 段「見てもらう日を決める」の家庭（サーバーの記録と同じ道）。彩（b）の画面を作る。 */
function household() {
  const now = DEMO_STAGES.find((s) => s.id === 'when')?.now ?? '';
  const store = memoryStore(new Map([['demo', demoEvents('when')]]));
  let op = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()] as DomainEvent[]);
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `w-${++op}`, now, demo: true }, command);
  const sent: Command[] = [];
  const routes: Route[] = [];
  const ctx = async (lang: 'ja' | 'en' = 'ja'): Promise<Ctx> => {
    const me = demoData.household.members.find((m) => m.id === 'b');
    if (!me) throw new Error('大人が無い');
    const view = viewFor(await events(), 'b', now);
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
      previewChange: async (command: PreviewCommand) => {
        const result = previewChange(await events(), { memberId: 'b', now }, command);
        return 'status' in result ? { refused: result.reason ?? 'other' } : { preview: result };
      },
      send: async (command: Command) => {
        sent.push(command);
        return run('b', command);
      },
      go: (route: Route) => {
        routes.push(route);
      },
    } as Ctx;
  };
  const whenOf = async () => {
    const plan = (await ctx()).plan;
    const requirement = plan.requirements.find((r) => r.when);
    const itemId = requirement?.basis.itemIds[0];
    if (!requirement?.when || !itemId) throw new Error('いつにするかが無い');
    return { key: requirement.key, itemId, when: requirement.when };
  };
  return { run, ctx, sent, routes, whenOf, events };
}

describe('候補の日を直す', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`時間を直した候補への前の答えを数えなくなると見せてから保存し、その候補の代だけが進む（${lang}）`, async () => {
      const h = household();
      const { key, when } = await h.whenOf();
      expect(when.candidates.map((c) => [c.id, c.rev, c.date])).toEqual([
        ['c1', 1, '2026-12-12'],
        ['c2', 1, '2026-12-13'],
      ]);
      const answered = (id: string) => when.answers.filter((a) => a.candidateId === id).length;
      expect(answered('c2')).toBeGreaterThan(0);
      const c = await h.ctx(lang);
      await step(() => root.render(<WhenScreen ctx={c} requirementKey={key} />));
      await step(() => buttonOf(c.t('when.candidates.edit'))?.click());
      const times = [...host.querySelectorAll<HTMLInputElement>('input[type=time]')];
      // 候補ごとに始まりと終わり（今の時間を、家庭の時区の時刻で入れて開く）。
      expect(times).toHaveLength(4);
      const end2 = times[3];
      if (!end2) throw new Error('欄が無い');
      const before = end2.value;
      const later = `${String(Number(before.slice(0, 2)) + 1).padStart(2, '0')}${before.slice(2)}`;
      await step(() => enter(end2, later));
      await step(() => buttonOf(c.t('when.candidates.look'))?.click());
      const text = host.textContent ?? '';
      expect(text).toContain(c.t('household.preview.label'));
      // 画面にある答えから数えた、数えなくなる答え（12/13 の分だけ）。決めた日は無いので、外れるとは言わない。
      const n = answered('c2');
      expect(text).toContain(
        lang === 'ja'
          ? `前の答え（${n} 人）は数えません`
          : `earlier answers to this candidate (${n}) no longer count`,
      );
      expect(text.match(lang === 'ja' ? /前の答え（/g : /earlier answers to this/g)).toHaveLength(
        1,
      );
      expect(text).not.toContain(lang === 'ja' ? '決めたことは外れます' : 'the choice is cleared');
      await step(() => buttonOf(c.t('when.candidates.save'))?.click());
      const command = h.sent.at(-1);
      expect(command).toMatchObject({
        type: 'setNeedCandidates',
        candidates: [
          { id: 'c1', date: '2026-12-12' },
          { id: 'c2', date: '2026-12-13', endTime: later },
        ],
      });
      expect(command && 'seen' in command && command.seen).toBeTruthy();
      const after = (await h.whenOf()).when;
      expect(after.candidates.map((x) => [x.id, x.rev])).toEqual([
        ['c1', 1],
        ['c2', 2],
      ]);
      // 時間を変えた候補への前の答えは当てない。変えていない候補の答えはそのまま。
      expect(after.answers.filter((a) => a.candidateId === 'c2')).toEqual([]);
      expect(after.answers.filter((a) => a.candidateId === 'c1')).toEqual(
        when.answers.filter((a) => a.candidateId === 'c1'),
      );
    });
  }

  it('足した候補はまだだれも答えていないと書き、決めた日を変えると決めたことが外れると書く', async () => {
    const h = household();
    const { key, itemId } = await h.whenOf();
    // 先に 12/12 に決める（見てから決める、画面と同じ道）。
    const choose: PreviewCommand = { type: 'chooseCandidate', itemId, candidateId: 'c1', rev: 1 };
    const look = previewChange(
      await h.events(),
      { memberId: 'b', now: (await h.ctx()).now },
      choose,
    );
    if ('status' in look) throw new Error(`見られない：${look.reason}`);
    expect(
      await h.run('b', { ...choose, seen: { throughSeq: look.throughSeq, changes: look.seen } }),
    ).toMatchObject({ status: 'ok' });
    const c = await h.ctx();
    const chosen = c.plan.requirements.find((r) => r.key === key)?.when?.chosen;
    expect(chosen).toMatchObject({ candidateId: 'c1', rev: 1 });
    await step(() => root.render(<WhenScreen ctx={c} requirementKey={key} />));
    await step(() => buttonOf(c.t('when.candidates.edit'))?.click());
    await step(() => buttonOf(c.t('when.candidates.add'))?.click());
    const dates = [...host.querySelectorAll<HTMLInputElement>('input[type=date]')];
    expect(dates).toHaveLength(3);
    const start1 = host.querySelectorAll<HTMLInputElement>('input[type=time]')[0];
    if (!start1 || !dates[2]) throw new Error('欄が無い');
    await step(() => enter(dates[2] as HTMLInputElement, '2026-12-14'));
    await step(() => enter(start1, '12:00'));
    // 確かに言えることは、計画で変わることと一緒に、見た時に書く。
    await step(() => buttonOf(c.t('when.candidates.look'))?.click());
    const text = host.textContent ?? '';
    expect(text).toContain(c.t('when.candidates.added', { count: 1 }));
    expect(text).toContain('決めたことは外れます');
    // 保存すると、時間を変えた決めた候補の代が進み、決めたことは外れる。足した候補は新しい ID で、答えはまだ無い。
    await step(() => buttonOf(c.t('when.candidates.save'))?.click());
    expect(h.sent.at(-1)).toMatchObject({
      type: 'setNeedCandidates',
      candidates: [
        { id: 'c1', date: '2026-12-12', startTime: '12:00' },
        { id: 'c2', date: '2026-12-13' },
        { date: '2026-12-14' },
      ],
    });
    const after = (await h.whenOf()).when;
    expect(after.candidates.map((x) => [x.id, x.rev, x.date])).toEqual([
      ['c1', 2, '2026-12-12'],
      ['c2', 1, '2026-12-13'],
      ['c3', 1, '2026-12-14'],
    ]);
    expect(after.chosen).toBeUndefined();
    expect(after.answers.filter((a) => a.candidateId !== 'c2')).toEqual([]);
  });

  it('頼んだ・引き受けた後は、候補を直す入口を出さない', async () => {
    const h = household();
    const { key } = await h.whenOf();
    const c = await h.ctx();
    const plan = structuredClone(c.plan);
    const requirement = plan.requirements.find((r) => r.key === key);
    if (!requirement?.when) throw new Error('いつにするかが無い');
    requirement.when.inUse = true;
    await step(() => root.render(<WhenScreen ctx={{ ...c, plan }} requirementKey={key} />));
    expect(buttonOf(c.t('when.candidates.edit'))).toBeUndefined();
    expect(host.textContent).not.toContain(c.t('when.candidates.label'));
  });

  it('「きょう」の「みんなの都合を聞いて日を決める」から、候補の日を出す形で「すること」を足す画面を開く', async () => {
    const h = household();
    const c = await h.ctx();
    await step(() => root.render(<TodayScreen ctx={c} />));
    await step(() => buttonOf(c.t('today.decideDay'))?.click());
    expect(h.routes.at(-1)).toEqual({ name: 'stateNeed', byAnswers: true });
    await step(() => root.render(<StateNeedScreen ctx={c} byAnswers />));
    const box = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((b) =>
      b.parentElement?.textContent?.includes(c.t('need.add.byAnswers')),
    );
    expect(box?.checked).toBe(true);
    // 候補の欄（2 つから）が開いている。
    expect(host.textContent).toContain(c.t('need.add.candidatesNote'));
    expect(host.querySelectorAll('input[type=date]')).toHaveLength(2);
  });
});

describe('候補の日を直す：ほかの人の答えと行き違う時', () => {
  /** 画面を開いた彩（b）の 12/13 の終わりを 1 時間遅らせる。答えていない人と、今の答えの数も返す。 */
  async function opened(h: ReturnType<typeof household>) {
    const { key, itemId, when } = await h.whenOf();
    const before = when.answers.filter((a) => a.candidateId === 'c2');
    const person = when.people.find((p) => !before.some((a) => a.personId === p.id));
    if (!person) throw new Error('12/13 に答えていない人がいない');
    const c = await h.ctx();
    await step(() => root.render(<WhenScreen ctx={c} requirementKey={key} />));
    await step(() => buttonOf(c.t('when.candidates.edit'))?.click());
    const end2 = host.querySelectorAll<HTMLInputElement>('input[type=time]')[3];
    if (!end2) throw new Error('欄が無い');
    const later = `${String(Number(end2.value.slice(0, 2)) + 1).padStart(2, '0')}${end2.value.slice(2)}`;
    await step(() => enter(end2, later));
    const answer = () =>
      h.run('a', {
        type: 'recordAvailability',
        itemId,
        candidateId: 'c2',
        rev: 1,
        personId: person.id,
        answer: 'yes',
      });
    return { key, c, count: before.length, answer };
  }
  const answersNote = (n: number) => `前の答え（${n} 人）は数えません`;

  it('開いた後・見る前に答えが届いたら、古い答えで数えた書き添えも保存も出さず、更新してから見せる', async () => {
    const h = household();
    const { key, c, count, answer } = await opened(h);
    expect(await answer()).toMatchObject({ status: 'ok' });
    await step(() => buttonOf(c.t('when.candidates.look'))?.click());
    let text = host.textContent ?? '';
    expect(text).toContain(c.t('when.candidates.stale'));
    expect(text).not.toContain(answersNote(count));
    expect(buttonOf(c.t('when.candidates.save'))).toBeUndefined();
    // 画面を更新する（新しい計画で描き直す。直しかけた欄と見た物は残る）と、今の答えで数えて保存できる。
    const fresh = await h.ctx();
    await step(() => root.render(<WhenScreen ctx={fresh} requirementKey={key} />));
    text = host.textContent ?? '';
    expect(text).not.toContain(c.t('when.candidates.stale'));
    expect(text).toContain(answersNote(count + 1));
    await step(() => buttonOf(c.t('when.candidates.save'))?.click());
    expect(h.sent.at(-1)).toMatchObject({ type: 'setNeedCandidates' });
    const after = (await h.whenOf()).when;
    expect(after.candidates.find((x) => x.id === 'c2')?.rev).toBe(2);
  });

  it('見た後に答えが届いたら、サーバーが保存を断り、候補も答えもそのまま残る', async () => {
    const h = household();
    const { c, count, answer } = await opened(h);
    await step(() => buttonOf(c.t('when.candidates.look'))?.click());
    expect(host.textContent).toContain(answersNote(count));
    expect(await answer()).toMatchObject({ status: 'ok' });
    await step(() => buttonOf(c.t('when.candidates.save'))?.click());
    expect(h.sent.at(-1)).toMatchObject({ type: 'setNeedCandidates' });
    const after = (await h.whenOf()).when;
    expect(after.candidates.find((x) => x.id === 'c2')?.rev).toBe(1);
    expect(after.answers.filter((a) => a.candidateId === 'c2')).toHaveLength(count + 1);
    // 見た物は捨て、もう一度見てもらう（保存は出さない）。
    expect(buttonOf(c.t('when.candidates.save'))).toBeUndefined();
    expect(buttonOf(c.t('when.candidates.look'))).toBeDefined();
  });
});
