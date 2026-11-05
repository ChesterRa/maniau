// 要らなくなった手配の依頼に取り消しを伝えた後も、済ませた頼む作業を「引き受けた」に戻さない。手配がまだ要る時
// だけ、取り消した依頼の手順を開き直し、頼み直せる。デモの家（架空）の事象で確かめる。
import type { Command, DomainEvent, PlanResult } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { notificationPreview } from '../src/notify-preview';
import { memoryStore } from '../src/store';

const CARE = 'arr:childCare:n1:i6:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const GAKUDO = `opt:${CARE}:opt-gakudo`;
const ASK = `task:${GRANDMA}:ask`;
const SUBMIT = `task:${GAKUDO}:submit`;
const DEMO_WINDOW = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };

function harness(events: DomainEvent[], now: string) {
  const store = memoryStore(new Map([['h', events]]));
  let op = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'h', { memberId, operationId: `c-${++op}`, now, demo: false }, command);
  const check = async () => {
    const recorded = await store.withHousehold('h', (log) => [...log.events()]);
    const plan = computePlan(recorded, now);
    const household = foldEvents(recorded).household;
    if (!household) throw new Error('家の情報が無い');
    return {
      plan,
      violations: verifyPlan({ household, plan, events: recorded }).issues.filter(
        (issue) => issue.kind === 'violation',
      ),
      preview: notificationPreview(recorded, plan, household),
    };
  };
  return { run, check };
}

const taskOf = (plan: PlanResult, key: string) => {
  const found = plan.tasks.find((t) => t.key === key);
  if (!found) throw new Error(`${key} が無い`);
  return found;
};

const cancelTitles = (
  preview: ReturnType<typeof notificationPreview>,
  memberId: string,
): string[] =>
  (preview.members.find((m) => m.memberId === memberId)?.now ?? []).filter(
    (title) => title === 'notify.cancel',
  );

/** 延期の知らせの後（祖母と学童の依頼は、どちらも要らなくなり、取り消しを伝える）。 */
const POSTPONED_AT = '2026-12-04T18:10+09:00';

describe('要らなくなった依頼に取り消しを伝えた後', () => {
  it('祖母への取り消しを伝えても、頼んだ作業は済んだままで、もう一人への取り消しの知らせは止まらない', async () => {
    const h = harness(demoEvents('postponed'), POSTPONED_AT);
    const before = await h.check();
    expect(before.violations).toEqual([]);
    expect(cancelTitles(before.preview, 'a')).toEqual(['notify.cancel']);
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.check();
    expect(taskOf(after.plan, ASK)).toMatchObject({ live: false, commitment: 'done' });
    expect(after.violations).toEqual([]);
    expect(after.preview.blockedAll).toBe(false);
    // 健太（a）には、学童への取り消しの知らせがまだ要る。
    expect(cancelTitles(after.preview, 'a')).toEqual(['notify.cancel']);
  });

  it('学童への取り消しを先に伝えても同じ（祖母への取り消しの知らせは止まらない）', async () => {
    const h = harness(demoEvents('postponed'), POSTPONED_AT);
    expect(
      await h.run('a', { type: 'recordCancellationSent', requestId: 'r-gakudo' }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.check();
    expect(taskOf(after.plan, SUBMIT)).toMatchObject({ live: false, commitment: 'done' });
    expect(after.violations).toEqual([]);
    expect(after.preview.blockedAll).toBe(false);
    expect(cancelTitles(after.preview, 'b')).toEqual(['notify.cancel']);
  });

  it('二つとも伝えた後は、取り消しの知らせが残らず、検証も通る', async () => {
    const h = harness(demoEvents('postponed'), POSTPONED_AT);
    await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' });
    await h.run('a', { type: 'recordCancellationSent', requestId: 'r-gakudo' });
    const after = await h.check();
    expect(taskOf(after.plan, ASK).commitment).toBe('done');
    expect(taskOf(after.plan, SUBMIT).commitment).toBe('done');
    expect(after.violations).toEqual([]);
    expect(after.preview.blockedAll).toBe(false);
    expect(cancelTitles(after.preview, 'a')).toEqual([]);
    expect(cancelTitles(after.preview, 'b')).toEqual([]);
  });

  it('控えの無い古い依頼でも、要らなくなった頼む作業は済んだまま', async () => {
    // 送った時の控えが無い古い事象（控えを持たない前の形）。
    const old = demoEvents('postponed').map((event) => {
      if (event.type !== 'externalRequestSent' || event.requestId !== 'r-grandma') return event;
      const { snapshot: _snapshot, ...rest } = event;
      return rest as DomainEvent;
    });
    expect(
      old.some(
        (e) => e.type === 'externalRequestSent' && e.requestId === 'r-grandma' && !e.snapshot,
      ),
    ).toBe(true);
    const h = harness(old, POSTPONED_AT);
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.check();
    expect(taskOf(after.plan, ASK)).toMatchObject({ live: false, commitment: 'done' });
    expect(after.violations).toEqual([]);
    expect(after.preview.blockedAll).toBe(false);
  });

  it('手配がまだ要る時は、取り消した依頼の手順を開き直し、頼み直せる', async () => {
    // 祖母に頼んで返事を待つ間（asked）。祖母の案をやめて取り消しを伝え、また祖母の案を選んで頼み直す。
    const h = harness(demoEvents('asked'), '2026-11-26T09:00+09:00');
    expect(
      await h.run('b', { type: 'dropOption', arrangementKey: CARE, optionKey: GRANDMA }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    let state = await h.check();
    expect(state.plan.arrangements.find((a) => a.key === CARE)?.live).toBe(true);
    // 取り消した依頼は、送ったことにしない（引き受けた所に戻り、頼み直す）。
    expect(taskOf(state.plan, ASK)).toMatchObject({ live: true, commitment: 'accepted' });
    expect(state.violations).toEqual([]);
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ASK,
        requestId: 'r-grandma-2',
        window: DEMO_WINDOW,
      }),
    ).toMatchObject({ status: 'ok' });
    state = await h.check();
    expect(state.plan.requests.find((r) => r.requestId === 'r-grandma-2')?.state).toBe(
      'awaitingReply',
    );
    expect(taskOf(state.plan, ASK).commitment).toBe('done');
    expect(state.violations).toEqual([]);
  });
});
