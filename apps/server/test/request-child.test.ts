// 子の居場所の依頼は、だれの分かを送った時の控えに持つ（架空のデモ・正式な命令）。手配が無くなった後の取り消しの
// 文も、控えの子で書く（家の最初の子にしない）。控えに子の無い古い依頼は、同じキーの手配が今あれば、その手配の子。
import type { Command } from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';

const care = 'arr:childCare:n1:i6:c';
const ask = keys.task(keys.option(care, 'opt-grandma'), 'ask');
const NEW_DAY = { date: '2026-12-14', writtenWeekday: 1 };

function household() {
  const now = DEMO_STAGES.find((s) => s.id === 'chase')?.now ?? '';
  const store = memoryStore(new Map([['demo', demoEvents('chase')]]));
  let seq = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `child-${++seq}`, now, demo: true },
      command,
    );
  const state = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      return { events, plan: computePlan(events, now) };
    });
  return { run, state };
}

describe('依頼のだれの分か', () => {
  it('送った時の控えに手配の子を持ち、手配が無くなっても依頼はその子の分のまま', async () => {
    const h = household();
    // デモで送った依頼（控えに子がある）。
    let { events, plan } = await h.state();
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')?.childId).toBe('c');
    // 日が直された後に今の日の分を送る：控えに手配の子を書く。
    expect(
      await h.run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: NEW_DAY }),
    ).toMatchObject({ status: 'ok' });
    const arrangement = (await h.state()).plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('子の居場所の手配が無い');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-new',
        window: { start: arrangement.start, end: arrangement.end },
      }),
    ).toMatchObject({ status: 'ok' });
    ({ events } = await h.state());
    const sent = events.find((e) => e.type === 'externalRequestSent' && e.requestId === 'r-new');
    expect(sent?.type === 'externalRequestSent' && sent.snapshot?.childId).toBe('c');
    // お知らせを取り下げると手配は無くなるが、依頼はだれの分かを持ったまま（取り消しの文に使う）。
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n1' })).toMatchObject({
      status: 'ok',
    });
    ({ plan } = await h.state());
    expect(plan.arrangements.some((a) => a.key === care)).toBe(false);
    expect(plan.requests.find((r) => r.requestId === 'r-new')).toMatchObject({
      childId: 'c',
      live: false,
    });
  });

  it('控えに子の無い古い依頼は、同じキーの手配が今あればその子、無ければ分からないまま（推さない）', async () => {
    const h = household();
    const { events } = await h.state();
    // 控えから子を除いた古い形の事象。
    const old = events.map((e) =>
      e.type === 'externalRequestSent' && e.snapshot
        ? { ...e, snapshot: { ...e.snapshot, childId: undefined } }
        : e,
    );
    const now = DEMO_STAGES.find((s) => s.id === 'chase')?.now ?? '';
    expect(computePlan(old, now).requests.find((r) => r.requestId === 'r-grandma')?.childId).toBe(
      'c',
    );
    const withdrawn = [
      ...old,
      {
        ...events[events.length - 1],
        seq: (events[events.length - 1]?.seq ?? 0) + 1,
        type: 'sourceWithdrawn',
        sourceId: 'n1',
      },
    ] as typeof events;
    const request = computePlan(withdrawn, now).requests.find((r) => r.requestId === 'r-grandma');
    expect(request).toBeDefined();
    expect(request?.childId).toBeUndefined();
  });
});
