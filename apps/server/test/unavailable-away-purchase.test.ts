// 架空の家庭で、家の情報を見てから記録する正式な道を通す。
import type { Command, Household } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { notificationPreview } from '../src/notify-preview';
import { previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

it('外出の最初がふさがっても、その外出の中の買い物を見てから記録する', async () => {
  const now = '2026-11-25T20:00+09:00';
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const household = async () => {
    const h = foldEvents(await events()).household;
    if (!h) throw new Error('家の情報が無い');
    return h;
  };
  let operation = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      'demo',
      {
        memberId: 'a',
        now,
        demo: true,
        operationId: `away-purchase-${++operation}`,
      },
      command,
    );
  const change = async (edited: Household) => {
    const before = await events();
    const shown = previewHousehold(before, { memberId: 'a', now }, edited);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(await events()).toEqual(before);
    const saved = await run({
      type: 'updateHousehold',
      household: edited,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    expect(saved.status).toBe('ok');
    return shown;
  };
  const picture = async () => {
    const log = await events();
    const h = await household();
    const plan = computePlan(log, now);
    const arr = plan.arrangements.find((a) => a.key === 'arr:purchase:n1:i5');
    const task = plan.tasks.find((t) => t.basis.arrangementKey === arr?.key);
    if (!arr) throw new Error('買い物の手配が無い');
    const report = verifyPlan({ household: h, events: log, plan });
    expect(report.issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
    expect(notificationPreview(log, plan, h).blockedAll).toBe(false);
    return { task, deadline: arr.options[0]?.decisionDeadline };
  };

  const seq = (await events()).at(-1)?.seq ?? 0;
  expect(
    await run({
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: seq },
    }),
  ).toMatchObject({ status: 'ok' });
  const h = await household();
  const date = '2026-11-26';
  const routine = [
    { start: '00:00', end: '09:00', kind: 'home' as const, placeId: 'home', viaStationIds: [] },
    { start: '09:00', end: '18:00', kind: 'work' as const, placeId: 'home', viaStationIds: [] },
    { start: '18:00', end: '23:59', kind: 'home' as const, placeId: 'home', viaStationIds: [] },
  ];
  await change({
    ...h,
    routines: h.routines.map((r) =>
      ['a', 'b'].includes(r.memberId) ? { ...r, segments: routine } : r,
    ),
    routineExceptions: [
      ...h.routineExceptions.filter((r) => !(r.memberId === 'a' && r.date === date)),
      {
        memberId: 'a',
        date,
        segments: [
          {
            start: '13:00',
            end: '16:00',
            kind: 'away',
            placeId: 'st-toyosu',
            viaStationIds: [],
          },
        ],
      },
    ],
  });
  const before = await picture();
  expect(before.task).toMatchObject({
    start: '2026-11-26T13:05+09:00',
    end: '2026-11-26T13:20+09:00',
  });
  expect(before.deadline).toBe('2026-11-26T13:05+09:00');

  await change({
    ...(await household()),
    unavailable: [
      {
        id: 'u1',
        memberId: 'a',
        date,
        start: '14:00',
        end: '14:30',
      },
    ],
  });
  const irrelevant = await picture();
  expect(irrelevant.task?.start).toBe(before.task?.start);
  expect(irrelevant.deadline).toBe(before.deadline);

  const shown = await change({
    ...(await household()),
    unavailable: [
      {
        id: 'u1',
        memberId: 'a',
        date,
        start: '13:00',
        end: '13:30',
      },
    ],
  });
  expect(shown.changes.moved).toContainEqual(
    expect.objectContaining({
      before: { start: '2026-11-26T13:05+09:00', end: '2026-11-26T13:20+09:00' },
      after: { start: '2026-11-26T13:35+09:00', end: '2026-11-26T13:50+09:00' },
    }),
  );
  const during = await picture();
  expect(during.task).toMatchObject({
    start: '2026-11-26T13:35+09:00',
    end: '2026-11-26T13:50+09:00',
  });
  expect(during.deadline).toBe('2026-11-26T13:35+09:00');

  const { unavailable: _removed, ...withoutBusy } = await household();
  await change(withoutBusy);
  const restored = await picture();
  expect(restored.task?.start).toBe(before.task?.start);
  expect(restored.deadline).toBe(before.deadline);
});
