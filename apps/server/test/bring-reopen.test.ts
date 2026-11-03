// 買った後に無いと答え直す操作を、正式の命令と知らせの門まで通す（架空のデモ）。
import { type Command, notificationHistory, notificationIntents } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { memoryStore } from '../src/store';

it('買った後に無いと答えると作業を再開し、家庭の知らせを止めない', async () => {
  const events = [...demoEvents('asked')];
  const family = events.find((e) => e.type === 'householdSet');
  if (family?.type !== 'householdSet') throw new Error('家庭が無い');
  const now = '2026-11-26T12:10+09:00';
  const store = memoryStore(new Map([['demo', events]]));
  let n = 0;
  const run = async (memberId: string, command: Command) => {
    const result = await runCommand(
      store,
      'demo',
      {
        memberId,
        operationId: `reopen-${++n}`,
        now,
        demo: true,
      },
      command,
    );
    expect(result.status).toBe('ok');
  };
  const through = () => store.withHousehold('demo', (log) => log.events().at(-1)?.seq ?? 0);
  const taskKey = 'task:opt:arr:purchase:n1:i5:buy:buy';
  const answer = async (value: 'yes' | 'no') =>
    run('b', {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value,
      seen: { what: '白い長袖シャツ', throughSeq: await through() },
    });
  await run('b', { type: 'correctItem', itemId: 'n1:i5', interpretation: { date: '2026-12-05' } });
  await run('a', {
    type: 'commitment',
    taskKey,
    action: 'done',
    seen: { titleKey: 'task.buy', titleParams: { what: '白い長袖シャツ' } },
  });
  await answer('yes');
  await answer('no');

  const all = await store.withHousehold('demo', (log) => [...log.events()]);
  const plan = computePlan(all, now);
  expect(plan.tasks.find((t) => t.key === taskKey)?.commitment).toBe('accepted');
  expect(
    verifyPlan({ household: family.household, plan, events: all }).issues.filter(
      (issue) => issue.kind === 'violation',
    ),
  ).toEqual([]);
  const intents = notificationIntents(plan, family.household, notificationHistory(all));
  expect(intents.length).toBeGreaterThan(0);
  const gate = sendGate({
    household: family.household,
    plan,
    events: all,
    intents,
    batchEnds: all.map((event) => event.seq),
  });
  expect(gate.all).toBe(false);
  expect(intents.filter((intent) => gate.blocked.has(intent.key))).toEqual([]);
});
