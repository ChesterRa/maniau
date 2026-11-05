// 依頼を送った後に家の時間を変え、頼んだ窓の確認と復帰を正式な命令で確かめる。
import type { Command, Household } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { notificationPreview } from '../src/notify-preview';
import { previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

it('頼んだ時間が占用で延びると確かめを残し、占用を外した後に元の控えと照らす', async () => {
  const now = '2026-11-29T21:00+09:00';
  const store = memoryStore(new Map([['demo', demoEvents('chase')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let count = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', now, demo: true, operationId: `busy-request-${++count}` },
      command,
    );
  const current = async () => {
    const log = await events();
    const h = foldEvents(log).household;
    if (!h) throw new Error('家が無い');
    const p = computePlan(log, now);
    return { log, h, p };
  };
  const check = async () => {
    const state = await current();
    expect(
      verifyPlan({ household: state.h, plan: state.p, events: state.log }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    expect(notificationPreview(state.log, state.p, state.h).blockedAll).toBe(false);
    return state;
  };
  const update = async (h: Household) => {
    const before = await events();
    const shown = previewHousehold(before, { memberId: 'b', now }, h);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(await events()).toEqual(before);
    expect(
      await run({
        type: 'updateHousehold',
        household: h,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    return shown;
  };
  const before = await check();
  const request = before.p.requests.find((r) => r.requestId === 'r-grandma');
  expect(request).toMatchObject({ state: 'awaitingReply', live: true });
  expect(request?.needsCheck).not.toBe(true);
  const busy = { id: 'u-late', memberId: 'a', date: '2026-12-07', start: '18:15', end: '18:45' };
  const shown = await update({ ...before.h, unavailable: [busy] });
  expect(shown.changes.windows).toContainEqual(
    expect.objectContaining({
      before: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
      after: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:45+09:00' },
    }),
  );
  expect(shown.changes.checks.map((r) => r.requestId)).toContain('r-grandma');
  const during = await check();
  expect(during.p.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
    state: 'awaitingReply',
    live: true,
    needsCheck: true,
  });
  const { unavailable: _removed, ...restored } = during.h;
  await update(restored);
  const after = await check();
  expect(after.p.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
    state: 'awaitingReply',
    live: true,
  });
  expect(after.p.requests.find((r) => r.requestId === 'r-grandma')?.needsCheck).not.toBe(true);
});
