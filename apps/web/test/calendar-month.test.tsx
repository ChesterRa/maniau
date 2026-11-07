// よていの月の暦（11/7 作り手 c97aed20）：週と同じ行から、一か月を格子で見せる。同じ日の上で、子を見る手の欠け・
// 決め時・返事待ち・引き受け済み・条件しだいを分ける。空の日は「登録された事が無い」と言い、空いているとは言わない。
// 月をまたいで、きょうから二週より先の日も見える。
import type { Task } from '@maniau/core';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { demoSessions } from '../../server/src/demo-sessions';
import { viewFor } from '../../server/src/views';
import { MonthView, monthGrid, shiftMonth, tonesOf } from '../src/calendar';
import { type Ctx, careNotCovered, scheduleLines, WeekScreen } from '../src/screens';
import { ctxFor } from './ctx';
import { step } from './fake-fetch';

// 見本を Node で読んでから、小さな画面を作る（ほかの画面の試験と同じ）。
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});

it('格子は日曜から始め、前と後ろの月の日で週を埋める', () => {
  const nov = monthGrid('2026-11');
  expect(nov[0]).toBe('2026-11-01');
  expect(nov).toHaveLength(35);
  const dec = monthGrid('2026-12');
  expect(dec[0]).toBe('2026-11-29');
  expect(dec.at(-1)).toBe('2027-01-02');
  expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  expect(shiftMonth('2026-01', -1)).toBe('2025-12');
});

it('子を見る手：選んでいない日は「未選択」、返事待ちの間はお願いの行が「待ち」を示す（選んだことを、見てもらえるとは言わない）', () => {
  const arrived = scheduleLines(ctxFor('arrived', 'b', 'ja')).linesFor('2026-12-07');
  const care = arrived.find((line) => line.kind === 'care');
  expect(care?.text).toBe('陽菜を見る手が未選択（8:10–18:15）');
  expect(care?.tone).toBe('attention');
  // 12/7 の休みは、発表会が 12/5 にある時だけ。条件しだいと書く。
  expect(care?.status).toBe('手を選んでください・条件しだい');
  expect(tonesOf(arrived)).toEqual(['attention', 'event']);
  // 条件しだいは色と別に持つ（子を見る手の欠けにも、行事にも付く）。
  expect(care?.conditional).toBe(true);
  expect(care?.action?.route).toEqual({ name: 'decide', key: expect.any(String) });

  const chase = scheduleLines(ctxFor('chase', 'b', 'ja')).linesFor('2026-12-07');
  expect(chase.some((line) => line.kind === 'care')).toBe(false);
  const grandma = chase.find((line) => line.kind === 'request');
  expect(grandma?.tone).toBe('waiting');
  expect(grandma?.status).toBe('返事は未記録・条件しだい');

  // 予備の学童に OK の記録があり、本命の祖母は返事待ち：一つの日に「待ち」と「OK の記録」を並べる。
  const backup = scheduleLines(ctxFor('backup', 'b', 'ja')).linesFor('2026-12-07');
  expect(tonesOf(backup)).toEqual(['waiting', 'settled', 'event']);
  // 引き受け・返事の色と、条件しだいは同時に成り立つ（どちらかで隠さない）。
  expect(backup.filter((line) => line.kind === 'request').every((line) => line.conditional)).toBe(
    true,
  );
});

it('月で見る：格子・印・この月のまだ決まっていない事・次の月・日を押す（日本語）', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<WeekScreen ctx={ctxFor('arrived', 'b', 'ja')} />));
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  const cell = (prefix: string) =>
    [...host.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.startsWith(prefix),
    );
  // 始めは週。
  expect(host.textContent).toContain('その後の7日');
  await step(() => button('月')?.click());
  expect(host.textContent).toContain('2026年11月');
  expect(host.textContent).not.toContain('その後の7日');
  // 11/30 の格子に、決め時の印と件数。
  expect(cell('11/30（月）')?.getAttribute('aria-label')).toBe(
    '11/30（月）：1件 決め時・条件しだいの事がある日',
  );
  // この月のまだ決まっていない事に、学童の決め時（きょうより前の日は並べない）。
  expect(host.textContent).toContain('2026年11月の、まだ決まっていない事');
  expect(host.textContent).toContain('「学童に預ける」の決め時');
  // きょう（11/25）は登録が無い：空いているとは言わない。
  expect(host.textContent).toContain(
    'この日に登録された事はありません（空いているとは限りません）。',
  );

  // 次の月へ：二週より先（12/8）も見え、12/7 の子を見る手の欠けが、まだ決まっていない事に出る。
  await step(() =>
    [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '次の月')
      ?.click(),
  );
  expect(host.textContent).toContain('2026年12月');
  expect(host.textContent).toContain('陽菜を見る手が未選択（8:10–18:15）');
  expect(cell('12/8（火）')?.getAttribute('aria-label')).toBe(
    '12/8（火）：2件 行事・条件しだいの事がある日',
  );
  await step(() => cell('12/7（月）')?.click());
  expect(host.textContent).toContain('12月7日');
  expect(host.textContent).toContain('振替休業日（学習発表会の実施日が12/5（土）なら）');
  // 元の文へ戻る口がある。
  expect(host.textContent).toContain('元の文を見る');
  await step(() => root.unmount());
});

it('英語でも同じ（Week / Month、月の名と、まだ決まっていない事）', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<WeekScreen ctx={ctxFor('arrived', 'b', 'en')} />));
  await step(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Month')?.click(),
  );
  expect(host.textContent).toContain('November 2026');
  expect(host.textContent).toContain('Still open in November 2026');
  await step(() =>
    [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Next month')
      ?.click(),
  );
  expect(host.textContent).toContain('No care chosen yet for 陽菜 (8:10 AM–6:15 PM)');
  await step(() => root.unmount());
});

it('持ち物は、計画が出した日（行事の朝）に出し、家にあるか・買ったかを添える。延期すれば一緒に動く', () => {
  const arrived = scheduleLines(ctxFor('arrived', 'b', 'ja')).linesFor('2026-12-05');
  const bring = arrived.find((line) => line.key.startsWith('prep:'));
  // お知らせに締切の時刻は書かれていない：8:00 は目安で、書かれた時刻としては見せない。
  expect(bring?.text).toBe('持ち物：白い長袖シャツ（この日の朝までに用意・目安）');
  expect(bring?.status).toBe('家にあるか、まだ答えていません');
  expect(bring?.tone).toBe('attention');
  // 延期の後は 12/8 の朝。買ってあるので、決まった色。
  const postponed = scheduleLines(ctxFor('postponed', 'b', 'ja'));
  expect(postponed.linesFor('2026-12-05').some((line) => line.key.startsWith('prep:'))).toBe(false);
  const moved = postponed.linesFor('2026-12-08').find((line) => line.key.startsWith('prep:'));
  expect(moved?.status).toBe('買ってあります');
  expect(moved?.tone).toBe('settled');
  const en = scheduleLines(ctxFor('arrived', 'b', 'en')).linesFor('2026-12-05');
  expect(en.find((line) => line.key.startsWith('prep:'))?.text).toBe(
    'Bring: 白い長袖シャツ (ready by the morning of this day · estimate)',
  );
  // 締切の時刻が書かれていれば、その時刻を書く（日だけなら日だけ）。
  const base = ctxFor('arrived', 'b', 'ja');
  const written = (deadline: string, dayOnly?: true): Ctx => ({
    ...base,
    items: base.items.map((entry) =>
      entry.item.kind === 'belongings'
        ? {
            ...entry,
            item: {
              ...entry.item,
              interpretation: {
                ...entry.item.interpretation,
                deadline,
                ...(dayOnly ? { deadlineDayOnly: dayOnly } : {}),
              },
            },
          }
        : entry,
    ),
    plan: {
      ...base.plan,
      requirements: base.plan.requirements.map((r) =>
        r.kind === 'belongings' ? { ...r, by: deadline } : r,
      ),
    },
  });
  const timed = scheduleLines(written('2026-12-04T17:00+09:00'))
    .linesFor('2026-12-04')
    .find((line) => line.key.startsWith('prep:'));
  expect(timed?.text).toBe('持ち物：白い長袖シャツ（17:00までに）');
  const dayOnly = scheduleLines(written('2026-12-04T23:59+09:00', true))
    .linesFor('2026-12-04')
    .find((line) => line.key.startsWith('prep:'));
  expect(dayOnly?.text).toBe('持ち物：白い長袖シャツ（この日までに）');
});

// 11/7 見直しの反例（正式の命令・古い記録の形）を、直した後の振る舞いとして試す。
function pendingTask(extra: Partial<Task> = {}): Task {
  return {
    key: 'pending',
    titleKey: 'task.familyAction',
    titleParams: { what: 'PENDING_TEST' },
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
  };
}

function withTask(task: Task): Ctx {
  const base = ctxFor('arrived', 'b', 'ja');
  return {
    ...base,
    items: [],
    plan: { ...base.plan, arrangements: [], requirements: [], requests: [], tasks: [task] },
  };
}

it('いつにするか：決める前は候補の日を候補として、正式に決めた後は決めた日に出す（いつにするかへ続ける）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('when');
  const before = await sessions.view(id, 'b');
  if (!before) throw new Error('view missing');
  const need = before.plan.requirements.find((r) => r.what === '陽菜を見てもらう' && r.when);
  const itemId = need?.basis.itemIds[0];
  const selected = need?.when?.candidates.find((c) => c.date === '2026-12-13');
  if (!need || !itemId || !selected) throw new Error('candidate missing');
  const base = ctxFor('when', 'b', 'ja');
  const candidates = scheduleLines(base)
    .linesFor('2026-12-13')
    .filter((line) => line.kind === 'when');
  expect(candidates.map((line) => line.text)).toEqual([
    '候補の日：陽菜を見てもらう（13:00–15:00）',
  ]);
  expect(candidates[0]?.tone).toBe('candidate');
  expect(candidates[0]?.action?.route).toEqual({ name: 'when', key: need.key });
  const command = {
    type: 'chooseCandidate' as const,
    itemId,
    candidateId: selected.id,
    rev: selected.rev,
  };
  const preview = await sessions.changePreview(id, 'b', command);
  if (!preview || 'reason' in preview) throw new Error('preview refused');
  const after = await sessions.command(id, 'b', 'calendar-candidate', {
    ...command,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
  if (after?.result.status !== 'ok') throw new Error('save refused');
  const ctx: Ctx = {
    ...base,
    plan: after.view.plan,
    household: after.view.household,
    items: after.view.items,
    sources: new Map(after.view.sources.map((s) => [s.id, s])),
  };
  const chosen = scheduleLines(ctx)
    .linesFor('2026-12-13')
    .filter((line) => line.kind === 'when');
  expect(chosen.map((line) => line.text)).toEqual(['陽菜を見てもらう（13:00–15:00）']);
  // 決めなかった候補の日には、もう出さない。
  expect(
    scheduleLines(ctx)
      .linesFor('2026-12-12')
      .some((line) => line.kind === 'when'),
  ).toBe(false);
});

it('月のまだ決まっていない事に、まだ引き受けていない作業も入れる', () => {
  const ctx = withTask(pendingTask({ start: '2026-11-26T18:00+09:00', assigneeId: 'b' }));
  const html = renderToStaticMarkup(<MonthView ctx={ctx} schedule={scheduleLines(ctx)} />);
  expect(html).toContain('PENDING_TEST');
  expect(html).not.toContain('この月の日付に、まだ決まっていない事はありません。');
});

it('時刻の無い作業は、月で見る時も出す', async () => {
  const ctx = withTask(pendingTask({ timing: 'undated', assigneeId: 'b' }));
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<WeekScreen ctx={ctx} />));
  await step(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === '月')?.click(),
  );
  expect(host.textContent).toContain('時刻を決めていない作業');
  expect(host.textContent).toContain('PENDING_TEST');
  await step(() => root.unmount());
});

it('見てもらえる時間の記録が無い手（前からの記録）は、見てもらえないとは言わず、確かめられないと書く', () => {
  const events = demoEvents('asked').map((event) => {
    if (event.type !== 'householdSet') return event;
    return {
      ...event,
      household: {
        ...event.household,
        careOptions: event.household.careOptions.map((option) => {
          if (option.id !== 'opt-grandma') return option;
          const { covers: _covers, ...legacy } = option;
          return legacy;
        }),
      },
    };
  });
  const view = viewFor(events, 'b', '2026-11-26T12:10+09:00');
  const ctx: Ctx = {
    ...ctxFor('asked', 'b', 'ja'),
    plan: view.plan,
    household: view.household,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
  };
  const arrangement = view.plan.arrangements.find(
    (a) => a.kind === 'childCare' && a.live && a.inUseOptionKey,
  );
  if (!arrangement) throw new Error('selected care missing');
  expect(careNotCovered(ctx, arrangement)?.unknown).toBe(true);
  const care = scheduleLines(ctx)
    .linesFor(arrangement.start.slice(0, 10))
    .filter((line) => line.kind === 'care');
  expect(care.map((line) => line.text).join(' ')).toContain('見てもらえると確かめられません');
  expect(care.map((line) => line.text).join(' ')).not.toContain('見てもらえない');
});

it('買い物の決め時は、子の居場所の決める画面へ続けない（何を買うかを書き、決める画面の口を出さない）', () => {
  const ctx = ctxFor('asked', 'a', 'ja');
  const purchase = ctx.plan.arrangements.find(
    (a) => a.live && a.kind === 'purchase' && a.recommendedOptionKey,
  );
  const option = purchase?.options.find((o) => o.key === purchase.recommendedOptionKey);
  if (!purchase || !option?.decisionDeadline) throw new Error('purchase deadline missing');
  const line = scheduleLines(ctx)
    .linesFor(option.decisionDeadline.slice(0, 10))
    .find((entry) => entry.key === `deadline:${option.key}`);
  expect(line?.text).toBe('「白い長袖シャツを買う」の決め時');
  expect(line?.action).toBeUndefined();
  // 子の居場所の決め時は、これまでどおり決める画面へ。
  const care = scheduleLines(ctxFor('arrived', 'b', 'ja'))
    .linesFor('2026-11-30')
    .find((entry) => entry.kind === 'deadline');
  expect(care?.action?.route).toEqual({ name: 'decide', key: expect.any(String) });
});

it('条件しだいは、格子の点線だけでなく行にも書く（決め時・持ち物・いつにするか）', async () => {
  // 学童の決め時（12/7 の休みは、発表会が 12/5 にある時だけ）。月の未定の一覧と週の行で、条件しだいを落とさない。
  const ctx = ctxFor('arrived', 'b', 'ja');
  const deadline = scheduleLines(ctx)
    .linesFor('2026-11-30')
    .find((line) => line.kind === 'deadline');
  expect(deadline?.conditional).toBe(true);
  expect(deadline?.status).toBe('条件しだい');
  const html = renderToStaticMarkup(<MonthView ctx={ctx} schedule={scheduleLines(ctx)} />);
  const open = html.slice(html.indexOf('2026年11月の、まだ決まっていない事'));
  expect(open).toContain('「学童に預ける」の決め時');
  expect(open).toContain('条件しだい');

  // 持ち物と、いつにするかの候補の行（計画の要件が条件しだいの時）。
  const base = ctxFor('when', 'b', 'ja');
  const conditional: Ctx = {
    ...base,
    plan: {
      ...base.plan,
      requirements: base.plan.requirements.map((r) =>
        r.kind === 'need' && r.when ? { ...r, conditional: true } : r,
      ),
    },
  };
  const candidate = scheduleLines(conditional)
    .linesFor('2026-12-13')
    .find((line) => line.kind === 'when');
  expect(candidate?.conditional).toBe(true);
  expect(candidate?.status).toBe('まだ決めていない候補・条件しだい');
  const bring = scheduleLines({
    ...ctx,
    plan: {
      ...ctx.plan,
      requirements: ctx.plan.requirements.map((r) =>
        r.kind === 'belongings' ? { ...r, conditional: true } : r,
      ),
    },
  })
    .linesFor('2026-12-05')
    .find((line) => line.key.startsWith('prep:'));
  expect(bring?.status).toBe('家にあるか、まだ答えていません・条件しだい');
});

it('いつにするか：記録した手が離せない時間と重なる候補と、そこに決めた日は、重なると書く（重ならないとは言わない）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('busy');
  const before = await sessions.view(id, 'a');
  if (!before) throw new Error('view missing');
  const club = before.plan.requirements.find((r) => r.what === 'クラブの練習' && r.when);
  const itemId = club?.basis.itemIds[0];
  const busy = club?.when?.candidates.find((c) => c.date === '2026-12-19');
  if (!club || !itemId || !busy?.unavailable) throw new Error('busy candidate missing');
  const base = ctxFor('busy', 'a', 'ja');
  const candidate = scheduleLines(base)
    .linesFor('2026-12-19')
    .find((line) => line.kind === 'when');
  expect(candidate?.tone).toBe('candidate');
  expect(candidate?.status).toBe('まだ決めていない候補・記録した手が離せない時間と重なります');
  const command = {
    type: 'chooseCandidate' as const,
    itemId,
    candidateId: busy.id,
    rev: busy.rev,
  };
  const preview = await sessions.changePreview(id, 'a', command);
  if (!preview || 'reason' in preview) throw new Error('preview refused');
  const after = await sessions.command(id, 'a', 'calendar-busy', {
    ...command,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
  if (after?.result.status !== 'ok') throw new Error('save refused');
  const ctx: Ctx = {
    ...base,
    plan: after.view.plan,
    household: after.view.household,
    items: after.view.items,
    sources: new Map(after.view.sources.map((s) => [s.id, s])),
  };
  const chosen = scheduleLines(ctx)
    .linesFor('2026-12-19')
    .find((line) => line.kind === 'when');
  expect(chosen?.text).toContain('クラブの練習');
  expect(chosen?.tone).toBe('attention');
  expect(chosen?.status).toBe('決めた日が、記録した手が離せない時間と重なります。確かめてください');
});

it('締切の欄だけの読み取り（日付の欄が無い）も、締切の日に出す。時刻は書かれた時だけ書く', () => {
  const base = ctxFor('arrived', 'b', 'ja');
  const [first] = base.items;
  if (!first) throw new Error('事項が無い');
  const due = (deadline: string, dayOnly?: true) => ({
    ...first,
    live: true,
    trusted: true,
    conditional: false,
    item: {
      ...first.item,
      id: 'n9:i1',
      kind: 'deadline' as const,
      written: '申し込みは11月30日17時まで。',
      interpretation: {
        what: '申し込み',
        deadline,
        ...(dayOnly ? { deadlineDayOnly: dayOnly } : {}),
      },
    },
  });
  const timed = scheduleLines({ ...base, items: [due('2026-11-30T17:00+09:00')] }).linesFor(
    '2026-11-30',
  );
  expect(timed.map((line) => line.text)).toContain('締切：申し込み（17:00までに）');
  const dayOnly = scheduleLines({
    ...base,
    items: [due('2026-11-30T08:00+09:00', true)],
  }).linesFor('2026-11-30');
  expect(dayOnly.map((line) => line.text)).toContain('締切：申し込み');
  expect(dayOnly.map((line) => line.text).join(' ')).not.toContain('8:00');
});

it('行事・テストは書かれた始まり（分かれば終わり）を書き、終わりを作らない。始まりを読み落としたかもしれない時は確かめてもらう', () => {
  // 延期の後の 12/8：1年生の発表は 9時20分から（終わりは書かれていない）。
  const postponed = scheduleLines(ctxFor('postponed', 'b', 'ja')).linesFor('2026-12-08');
  expect(postponed.map((line) => line.text)).toContain('1年生の発表 9:20〜');
  const en = scheduleLines(ctxFor('postponed', 'b', 'en')).linesFor('2026-12-08');
  expect(en.map((line) => line.text)).toContain('1年生の発表 from 9:20 AM');
  const base = ctxFor('postponed', 'b', 'ja');
  const entry = base.items.find((e) => e.live && e.item.interpretation.startTime === '09:20');
  if (!entry) throw new Error('時刻のある行事が無い');
  const withTimes = (interpretation: object) =>
    scheduleLines({
      ...base,
      items: [
        {
          ...entry,
          item: {
            ...entry.item,
            interpretation: { ...entry.item.interpretation, ...interpretation },
          },
        },
      ],
    })
      .linesFor('2026-12-08')
      .map((line) => line.text);
  expect(withTimes({ endTime: '11:00' })).toContain('1年生の発表 9:20–11:00');
  // 終わりを読み落としたかもしれない時は、終わりを書かず、確かめてもらう。
  expect(withTimes({ endTime: '11:00', endTimeUnconfirmed: true })).toContain(
    '1年生の発表 9:20〜（終わりの日時は元の文で確かめてください）',
  );
  expect(withTimes({ startTime: undefined, startTimeUnconfirmed: true })).toContain(
    '1年生の発表（時刻は元の文で確かめてください）',
  );
  // 確かめた・条件の無い行事でも、時刻を確かめる事は、月の印（未定・要確認）と未定の一覧に出す。
  const unsure: Ctx = {
    ...base,
    items: [
      {
        ...entry,
        trusted: true,
        conditional: false,
        item: {
          ...entry.item,
          interpretation: {
            ...entry.item.interpretation,
            startTime: undefined,
            startTimeUnconfirmed: true,
          },
        },
      },
    ],
  };
  const line = scheduleLines(unsure)
    .linesFor('2026-12-08')
    .find((l) => l.key === `item:${entry.item.id}`);
  expect(line?.tone).toBe('attention');
  const html = renderToStaticMarkup(<MonthView ctx={unsure} schedule={scheduleLines(unsure)} />);
  const open = html.slice(html.indexOf('の、まだ決まっていない事'));
  expect(open).toContain('1年生の発表（時刻は元の文で確かめてください）');
});

it('終わりの日を決められない時（「翌日」と書かれた・終わりが始まり以前）は終わりを書かず、終わりだけの時は時刻を確かめてもらう', () => {
  const base = ctxFor('postponed', 'b', 'ja');
  const entry = base.items.find((e) => e.live && e.item.interpretation.startTime === '09:20');
  if (!entry) throw new Error('時刻のある行事が無い');
  const lineOf = (written: string, interpretation: object) => {
    const ctx: Ctx = {
      ...base,
      items: [
        {
          ...entry,
          trusted: true,
          conditional: false,
          item: {
            ...entry.item,
            written,
            interpretation: { date: '2026-12-08', what: '練習', ...interpretation },
          },
        },
      ],
    };
    return scheduleLines(ctx)
      .linesFor('2026-12-08')
      .find((line) => line.key === `item:${entry.item.id}`);
  };
  // 9:00 から翌日 10:00 まで：同じ日の 9:00–10:00 にしない。
  const nextDay = lineOf('12月8日9:00から翌日10:00まで練習します。', {
    startTime: '09:00',
    endTime: '10:00',
  });
  expect(nextDay?.text).toBe('練習 9:00〜（終わりの日時は元の文で確かめてください）');
  expect(nextDay?.tone).toBe('attention');
  // 終わりの時刻が無くても「翌朝まで」とあれば、終わりを確かめてもらう（core の escort の試験と同じ場面）。
  const nextMorning = lineOf('12月8日22:00から翌朝まで練習します。', { startTime: '22:00' });
  expect(nextMorning?.text).toBe('練習 22:00〜（終わりの日時は元の文で確かめてください）');
  expect(nextMorning?.tone).toBe('attention');
  // 終わりの時刻も次の日の言葉も無ければ、始まりだけを書く（確かめは求めない）。
  const fromOnly = lineOf('22時から練習します。', { startTime: '22:00' });
  expect(fromOnly?.text).toBe('練習 22:00〜');
  expect(fromOnly?.tone).not.toBe('attention');
  // 終わりが始まり以前（23:00 から 1:00）も、同じ日の範囲にしない。
  expect(lineOf('23時から1時まで', { startTime: '23:00', endTime: '01:00' })?.text).toBe(
    '練習 23:00〜（終わりの日時は元の文で確かめてください）',
  );
  // 同じ日と読める終わりは書く。
  expect(lineOf('9時から12時まで', { startTime: '09:00', endTime: '12:00' })?.text).toBe(
    '練習 9:00–12:00',
  );
  // 終わりだけ・終わりを読み落としただけ（始まりが無い）：時刻を確かめてもらう。
  for (const interpretation of [{ endTime: '16:00' }, { endTimeUnconfirmed: true }]) {
    const line = lineOf('16時まで', interpretation);
    expect(line?.text).toBe('練習（時刻は元の文で確かめてください）');
    expect(line?.tone).toBe('attention');
  }
});
