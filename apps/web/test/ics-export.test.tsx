// スマホの暦への書き出し：確かな事だけを書き出す（条件しだい・確かめていない・候補・決め時・返事待ちは入れない）。
// 架空の家族のデモの段で試す。
import type { ExternalRequest, Task } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import { toIcs } from '../src/ics';
import { firmEvents, IcsExportCard } from '../src/ics-export';
import { type Ctx, scheduleLines } from '../src/screens';
import { ctxFor } from './ctx';

it('雨なら延期の発表会が決まるまでは、その日の行事も持ち物の朝も書き出さない', () => {
  const arrived = ctxFor('arrived', 'b', 'ja');
  expect(firmEvents(arrived)).toEqual([]);
  const html = renderToStaticMarkup(<IcsExportCard ctx={arrived} />);
  expect(html).toContain('スマホの暦に書き出す');
  expect(html).toContain('いま書き出せる確かな事はありません。');
  expect(html).not.toContain('<button');
});

it('延期が決まった後は、確かな行事を書き出す（日だけの予定と時刻のある予定）。書かれていない持ち物の朝は入れない', () => {
  const ctx = ctxFor('postponed', 'b', 'ja');
  const events = firmEvents(ctx);
  expect(events.map((e) => e.summary)).toEqual(['1年生の発表', '学習発表会', '通常授業']);
  const ics = toIcs(events, Date.parse(ctx.now), 'まにあう');
  // 12/8 の発表は 9:20（日本時間）から。終わりが書かれていなければ作らない。
  expect(ics).toContain('DTSTART:20261208T002000Z');
  expect(ics).toContain('DTSTART;VALUE=DATE:20261208');
  expect(ics).toContain('SUMMARY:通常授業');
  expect(ics).toContain('DESCRIPTION:お知らせ「');
  // 持ち物の締切はお知らせに書かれていない（朝 8:00 は目安）ので、決まった時刻として暦に置かない。
  expect(ics).not.toContain('持ち物');
  const html = renderToStaticMarkup(<IcsExportCard ctx={ctx} />);
  expect(html).toContain('書き出す（3件）');
  expect(html).toContain('一度きりの写しです。');
  const en = renderToStaticMarkup(<IcsExportCard ctx={ctxFor('postponed', 'b', 'en')} />);
  expect(en).toContain('Export (3 items)');
});

it('お知らせに書かれた持ち物の締切は書き出す（時刻まで書かれていれば時刻、日だけなら終日）', () => {
  const base = ctxFor('postponed', 'b', 'ja');
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
  const timed = firmEvents(written('2026-12-07T17:00+09:00')).find((e) =>
    e.uid.startsWith('prep-'),
  );
  expect(timed).toMatchObject({
    summary: '持ち物：白い長袖シャツ',
    start: Date.parse('2026-12-07T17:00+09:00'),
  });
  expect(timed?.date).toBeUndefined();
  const day = firmEvents(written('2026-12-07T23:59+09:00', true)).find((e) =>
    e.uid.startsWith('prep-'),
  );
  expect(day).toMatchObject({ summary: '持ち物：白い長袖シャツ', date: '2026-12-07' });
  expect(day?.start).toBeUndefined();
});

it('いつにするかで決めた日は書き出す（決めた後に答えが変わった・手が離せない時間と重なる・条件しだいは入れない）', () => {
  const base = ctxFor('when', 'b', 'ja');
  const need = base.plan.requirements.find((r) => r.kind === 'need' && r.when);
  const candidate = need?.when?.candidates[0];
  if (!need?.when || !candidate) throw new Error('いつにするかの「すること」が無い');
  const decided = (
    extra: { stale?: boolean; busy?: boolean; conditional?: boolean } = {},
  ): Ctx => ({
    ...base,
    plan: {
      ...base.plan,
      arrangements: [],
      tasks: [],
      requests: [],
      requirements: [
        {
          ...need,
          ...(extra.conditional ? { conditional: true } : {}),
          when: {
            ...(need.when as NonNullable<typeof need.when>),
            candidates: [
              {
                ...candidate,
                ...(extra.busy
                  ? {
                      unavailable: [
                        {
                          personId: 'a',
                          unavailableId: 'u-1',
                          start: candidate.start,
                          end: candidate.end,
                        },
                      ],
                    }
                  : {}),
              },
            ],
            chosen: {
              candidateId: candidate.id,
              rev: candidate.rev,
              stale: extra.stale === true,
              changes: [],
            },
          },
        },
      ],
    },
  });
  const events = firmEvents(decided()).filter((e) => e.uid.startsWith('when-'));
  expect(events).toEqual([
    {
      uid: `when-${need.key}@maniau`,
      summary: `${need.what}（いつにするかで決めた日。手配の返事とは別）`,
      start: Date.parse(candidate.start),
      end: Date.parse(candidate.end),
    },
  ]);
  for (const extra of [{ stale: true }, { busy: true }, { conditional: true }]) {
    expect(firmEvents(decided(extra)).some((e) => e.uid.startsWith('when-'))).toBe(false);
  }
});

function withPlan(tasks: Task[], requests: ExternalRequest[]): Ctx {
  const base = ctxFor('postponed', 'b', 'ja');
  return {
    ...base,
    items: [],
    plan: { ...base.plan, requirements: [], arrangements: [], tasks, requests },
  };
}

const task = (extra: Partial<Task>): Task => ({
  key: 't-export',
  titleKey: 'task.familyAction',
  titleParams: { what: '学童へ迎えに行く' },
  basis: { itemIds: [] },
  durationMin: 30,
  after: [],
  segments: ['home'],
  travelBeforeMin: 0,
  travelAfterMin: 0,
  travelSource: 'none',
  commitment: 'accepted',
  live: true,
  start: '2026-12-09T17:30+09:00',
  end: '2026-12-09T18:00+09:00',
  assigneeId: 'b',
  ...extra,
});

it('締切の欄だけの読み取りも書き出し（時刻があれば時刻、日だけなら終日）、始まりの時刻を読み落としたかもしれない行事は書き出さない', () => {
  const base = ctxFor('postponed', 'b', 'ja');
  const [first] = base.items;
  if (!first) throw new Error('事項が無い');
  const entry = (id: string, kind: 'deadline' | 'event', interpretation: object) => ({
    ...first,
    live: true,
    trusted: true,
    conditional: false,
    item: { ...first.item, id, kind, written: '架空の文', interpretation },
  });
  const ctx: Ctx = {
    ...base,
    plan: { ...base.plan, requirements: [], arrangements: [], tasks: [], requests: [] },
    items: [
      entry('n9:i1', 'deadline', { what: '申し込み', deadline: '2026-12-10T17:00+09:00' }),
      entry('n9:i2', 'deadline', {
        what: '提出',
        deadline: '2026-12-11T08:00+09:00',
        deadlineDayOnly: true,
      }),
      entry('n9:i3', 'event', {
        what: '保護者会',
        date: '2026-12-12',
        startTimeUnconfirmed: true,
      }),
    ],
  };
  const events = firmEvents(ctx);
  expect(events.map((e) => e.uid)).toEqual(['item-n9:i1@maniau', 'item-n9:i2@maniau']);
  expect(events[0]).toMatchObject({
    summary: '締切：申し込み',
    start: Date.parse('2026-12-10T17:00+09:00'),
  });
  expect(events[0]?.end).toBeUndefined();
  expect(events[1]).toMatchObject({ summary: '締切：提出', date: '2026-12-11' });
  expect(events[1]?.start).toBeUndefined();
});

it('引き受けた作業は書き出し、まだ引き受けていない・確かめを待つ作業は書き出さない', () => {
  const events = firmEvents(
    withPlan(
      [
        task({}),
        task({ key: 't-proposed', commitment: 'proposed' }),
        task({ key: 't-time', timeUnconfirmed: true }),
      ],
      [],
    ),
  );
  expect(events.map((e) => e.uid)).toEqual(['task-t-export@maniau']);
  expect(events[0]?.summary).toBe('彩：学童へ迎えに行く');
  expect(events[0]?.start).toBe(Date.parse('2026-12-09T17:30+09:00'));
  expect(events[0]?.end).toBe(Date.parse('2026-12-09T18:00+09:00'));
});

it('引き受けの記録が残っても、今進めない案の作業は書き出さない（取り消しの連絡は書き出す）', () => {
  const base = withPlan([], []);
  const real = ctxFor('postponed', 'b', 'ja').plan.arrangements.find((a) => a.options.length > 0);
  const option = real?.options[0];
  if (!real || !option) throw new Error('手配が無い');
  // 家族が使えないとした手（本命が決まって休む予備と同じく、今は進めない案）。
  const arrangement = {
    ...real,
    key: 'arr-export',
    live: true,
    options: [{ ...option, key: 'opt-export', unusable: true }],
  };
  const basis = { itemIds: [], arrangementKey: 'arr-export', optionKey: 'opt-export' };
  const ctx: Ctx = {
    ...base,
    plan: {
      ...base.plan,
      arrangements: [arrangement],
      tasks: [
        task({ key: 't-idle', basis }),
        task({ key: 't-cancel', basis, cancels: 'r-old' }),
        task({ key: 't-own' }),
      ],
    },
  };
  expect(firmEvents(ctx).map((e) => e.uid)).toEqual(['task-t-cancel@maniau', 'task-t-own@maniau']);
});

it('OK の記録がある頼み事だけを書き出す（返事待ち・条件しだい・確かめが要る物は入れない）', () => {
  const backup = ctxFor('backup', 'b', 'ja');
  const confirmed = backup.plan.requests.find((r) => r.live && r.state === 'confirmed');
  if (!confirmed?.window) throw new Error('OK の記録がある依頼が無い');
  // デモの段では 12/7 の休みが条件しだいなので、書き出さない。
  expect(confirmed.conditional).toBe(true);
  expect(firmEvents(withPlan([], [confirmed]))).toEqual([]);
  // 条件が解けた同じ依頼なら書き出す。返事待ちの依頼は書き出さない。
  const settled = { ...confirmed, conditional: false };
  const waiting = { ...confirmed, requestId: 'r-waiting', state: 'awaitingReply' as const };
  const events = firmEvents(withPlan([], [settled, waiting]));
  expect(events.map((e) => e.uid)).toEqual([`request-${confirmed.requestId}@maniau`]);
  expect(events[0]?.summary).toMatch(/に頼んだ時間（OK の記録あり）$/);
  expect(events[0]?.start).toBe(Date.parse(confirmed.window.start));
});

it('終わりの日を決められない行事は始まりだけを書き出し（同じ日の範囲にしない）、終わりだけの行事は書き出さない', () => {
  const base = ctxFor('postponed', 'b', 'ja');
  const [first] = base.items;
  if (!first) throw new Error('事項が無い');
  const entry = (id: string, written: string, interpretation: object) => ({
    ...first,
    live: true,
    trusted: true,
    conditional: false,
    item: { ...first.item, id, kind: 'event' as const, written, interpretation },
  });
  const ctx: Ctx = {
    ...base,
    plan: { ...base.plan, requirements: [], arrangements: [], tasks: [], requests: [] },
    items: [
      entry('n9:i1', '12月10日9:00から翌日10:00まで合宿', {
        what: '合宿',
        date: '2026-12-10',
        startTime: '09:00',
        endTime: '10:00',
      }),
      entry('n9:i2', '16時まで', { what: '片付け', date: '2026-12-10', endTime: '16:00' }),
      entry('n9:i3', '9時から12時まで', {
        what: '練習',
        date: '2026-12-11',
        startTime: '09:00',
        endTime: '12:00',
      }),
    ],
  };
  const events = firmEvents(ctx);
  expect(events.map((e) => e.uid)).toEqual(['item-n9:i1@maniau', 'item-n9:i3@maniau']);
  expect(events[0]).toMatchObject({ start: Date.parse('2026-12-10T09:00+09:00') });
  expect(events[0]?.end).toBeUndefined();
  expect(events[1]).toMatchObject({
    start: Date.parse('2026-12-11T09:00+09:00'),
    end: Date.parse('2026-12-11T12:00+09:00'),
  });
});

it('始まりを読み落とした行事に家族が始まりを入れると、よていの確かめが消え、書き出せるようになる（正式の直し）', async () => {
  const now = '2026-12-04T18:10+09:00';
  // 延期の後の 12/8 の発表（n1:i4）を、始まりの時刻を読み落とした読み取りにする。
  const events = demoEvents('postponed').map((event) => {
    if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') return event;
    const output = event.output as { items?: { id: string; interpretation: object }[] };
    if (!output.items?.some((item) => item.id === 'n1:i4')) return event;
    return {
      ...event,
      output: {
        ...output,
        items: output.items.map((item) => {
          if (item.id !== 'n1:i4') return item;
          const { startTime: _, ...rest } = item.interpretation as { startTime?: string };
          return { ...item, interpretation: { ...rest, startTimeUnconfirmed: true } };
        }),
      },
    } as typeof event;
  });
  const store = memoryStore(new Map([['demo', events]]));
  const all = () => store.withHousehold('demo', (log) => [...log.events()]);
  const ctxOf = async (): Promise<Ctx> => {
    const view = viewFor(await all(), 'b', now);
    return {
      ...ctxFor('postponed', 'b', 'ja'),
      plan: view.plan,
      household: view.household,
      items: view.items,
      sources: new Map(view.sources.map((source) => [source.id, source])),
    };
  };
  const before = await ctxOf();
  expect(
    scheduleLines(before)
      .linesFor('2026-12-08')
      .map((line) => line.text),
  ).toContain('1年生の発表（時刻は元の文で確かめてください）');
  expect(firmEvents(before).some((e) => e.uid === 'item-n1:i4@maniau')).toBe(false);
  const command = {
    type: 'correctItem' as const,
    itemId: 'n1:i4',
    interpretation: { startTime: '09:20' },
  };
  const shown = previewChange(await all(), { memberId: 'b', now }, command);
  if ('reason' in shown) throw new Error(`見られない：${shown.reason}`);
  const result = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'ics-correct-1', now, demo: true },
    { ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } },
  );
  expect(result.status).toBe('ok');
  const after = await ctxOf();
  expect(
    scheduleLines(after)
      .linesFor('2026-12-08')
      .map((line) => line.text),
  ).toContain('1年生の発表 9:20〜');
  expect(firmEvents(after).find((e) => e.uid === 'item-n1:i4@maniau')).toMatchObject({
    start: Date.parse('2026-12-08T09:20+09:00'),
  });
});
