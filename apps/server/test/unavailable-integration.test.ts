// 架空の家庭で、候補と作業について家の情報を見てから直し、独立の検証と知らせの門まで通す。
import { type Command, type Household, proposalSnapshot } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { answerView } from '../src/answer-link';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { notificationPreview } from '../src/notify-preview';
import { previewChange, previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

function setup(stage: 'arrived' | 'club', now: string) {
  const store = memoryStore(new Map([['demo', demoEvents(stage)]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const plan = async () => computePlan(await events(), now);
  const household = async () => {
    const h = foldEvents(await events()).household;
    if (!h) throw new Error('家が無い');
    return h;
  };
  let counter = 0;
  const run = (command: Command, memberId = 'a') =>
    runCommand(
      store,
      'demo',
      {
        memberId,
        now,
        demo: true,
        operationId: `unavailable-journey-${++counter}`,
      },
      command,
    );
  const change = async (edited: Household) => {
    const before = await events();
    const preview = previewHousehold(before, { memberId: 'a', now }, edited);
    if ('reason' in preview) throw new Error(preview.reason);
    expect(await events()).toEqual(before);
    const result = await run({
      type: 'updateHousehold',
      household: edited,
      seen: {
        throughSeq: preview.throughSeq,
        changes: preview.seen,
      },
    });
    expect(result.status).toBe('ok');
    return preview;
  };
  const verify = async () => {
    const log = await events();
    const h = await household();
    const p = await plan();
    const report = verifyPlan({ household: h, events: log, plan: p });
    expect(report.issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
    expect(notificationPreview(log, p, h).blockedAll).toBe(false);
    return { log, h, p };
  };
  return { events, household, plan, run, change, verify };
}

it('候補を決めた後、重なる記録の追加・削除を見せ、答えと決定を勝手に変えない', async () => {
  const now = '2026-12-06T10:00+09:00';
  const app = setup('club', now);
  const itemId = 'f-demo-club:i1';
  const decision = { type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 } as const;
  const beforeChoice = await app.events();
  const preview = previewChange(beforeChoice, { memberId: 'a', now }, decision);
  if ('reason' in preview) throw new Error(preview.reason);
  expect(await app.events()).toEqual(beforeChoice);
  expect(
    await app.run({ ...decision, seen: { throughSeq: preview.throughSeq, changes: preview.seen } }),
  ).toMatchObject({ status: 'ok' });
  const requirement = (p: Awaited<ReturnType<typeof app.plan>>) => {
    const found = p.requirements.find((r) => r.key === 'req:need:f-demo-club:i1')?.when;
    if (!found) throw new Error('候補が無い');
    return found;
  };
  const before = await app.verify();
  const link = before.log.find(
    (entry) =>
      entry.type === 'answerLinkIssued' && entry.itemId === itemId && entry.personId === 'g-coach',
  );
  if (link?.type !== 'answerLinkIssued') throw new Error('架空の相手のリンクが無い');
  const guestView = async (log: typeof before.log) => {
    const isolated = memoryStore(new Map([['guest', log]]));
    return isolated.withHousehold('guest', (held) =>
      answerView(
        held,
        {
          householdId: link.householdId,
          itemId,
          personId: link.personId,
        },
        link.tokenHash,
      ),
    );
  };
  const guestBefore = await guestView(before.log);
  const when = requirement(before.p);
  expect(when.chosen).toMatchObject({ candidateId: 'c2', stale: false });
  const record = {
    id: 'busy-one',
    memberId: 'a',
    date: '2026-12-19',
    start: '09:30',
    end: '10:30',
  };
  const added = await app.change({ ...before.h, unavailable: [record] });
  expect(added.changes.overlaps).toContainEqual(
    expect.objectContaining({
      candidateId: 'c2',
      personId: 'a',
      unavailableId: 'busy-one',
      change: 'added',
    }),
  );
  const during = await app.verify();
  const guestAfter = await guestView(during.log);
  expect(guestAfter).toEqual(guestBefore);
  expect(JSON.stringify(guestAfter)).not.toContain('busy-one');
  expect(JSON.stringify(guestAfter)).not.toContain('unavailable');
  const current = requirement(during.p);
  expect(current.chosen).toEqual(when.chosen);
  expect(current.answers).toEqual(when.answers);
  expect(current.candidates.map((c) => [c.id, c.yes, c.possible, c.condition])).toEqual(
    when.candidates.map((c) => [c.id, c.yes, c.possible, c.condition]),
  );
  expect(current.candidates.find((c) => c.id === 'c2')?.unavailable).toEqual([
    {
      personId: 'a',
      unavailableId: 'busy-one',
      start: '2026-12-19T09:30+09:00',
      end: '2026-12-19T10:30+09:00',
    },
  ]);
  const altered = structuredClone(during.p);
  const bad = requirement(altered).candidates.find((c) => c.id === 'c2');
  if (!bad) throw new Error('候補が無い');
  delete bad.unavailable;
  expect(
    verifyPlan({ household: during.h, events: during.log, plan: altered }).issues,
  ).toContainEqual(
    expect.objectContaining({ kind: 'violation', code: 'need_when_unavailable_mismatch' }),
  );
  const { unavailable: _removed, ...remaining } = during.h;
  const removed = await app.change(remaining);
  expect(removed.changes.overlaps).toContainEqual(
    expect.objectContaining({
      candidateId: 'c2',
      personId: 'a',
      unavailableId: 'busy-one',
      change: 'removed',
    }),
  );
  const after = await app.verify();
  expect(requirement(after.p).chosen).toEqual(when.chosen);
  expect(requirement(after.p).candidates.find((c) => c.id === 'c2')?.unavailable).toBeUndefined();
});

it('承接した買い物と新しい占用が重なれば再確認、取り除けば元の時刻に戻る', async () => {
  const now = '2026-11-25T20:00+09:00';
  const app = setup('arrived', now);
  const seq = (await app.events()).at(-1)?.seq ?? 0;
  expect(
    await app.run(
      {
        type: 'answer',
        unknownId: 'u-atHome:n1:i5',
        value: 'no',
        seen: { what: '白い長袖シャツ', throughSeq: seq },
      },
      'b',
    ),
  ).toMatchObject({ status: 'ok' });
  let p = await app.plan();
  const buy = p.tasks.find(
    (t) => t.basis.arrangementKey === 'arr:purchase:n1:i5' && t.assigneeId === 'a',
  );
  const shown = buy && proposalSnapshot(buy);
  if (!buy || !shown) throw new Error('買い物の提案が無い');
  expect(await app.run({ type: 'accept', taskKey: buy.key, shown })).toMatchObject({
    status: 'ok',
  });
  const before = await app.verify();
  const original = before.p.tasks.find((t) => t.key === buy.key);
  expect(original).toMatchObject({ commitment: 'accepted', start: '2026-11-26T18:55+09:00' });
  const record = {
    id: 'busy-two',
    memberId: 'a',
    date: '2026-11-26',
    start: '18:50',
    end: '19:05',
  };
  await app.change({ ...before.h, unavailable: [record] });
  const during = await app.verify();
  const moved = during.p.tasks.find((t) => t.key === buy.key);
  expect(moved).toMatchObject({ commitment: 'accepted', reconfirm: true, live: true });
  expect(moved?.start).not.toBe(original?.start);
  const fake = structuredClone(during.p);
  const bad = fake.tasks.find((t) => t.key === buy.key);
  if (!bad || !original) throw new Error('作業が無い');
  bad.start = original.start;
  bad.end = original.end;
  expect(verifyPlan({ household: during.h, events: during.log, plan: fake }).issues).toContainEqual(
    expect.objectContaining({ kind: 'violation', code: 'task_unavailable' }),
  );
  const { unavailable: _removed, ...remaining } = during.h;
  await app.change(remaining);
  const after = await app.verify();
  p = after.p;
  expect(p.tasks.find((t) => t.key === buy.key)).toMatchObject({
    commitment: 'accepted',
    start: original.start,
  });
  expect(p.tasks.find((t) => t.key === buy.key)?.reconfirm).toBeUndefined();
});
