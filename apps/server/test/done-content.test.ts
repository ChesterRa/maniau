// 済んだの記録は、札で見せた用件に結び付ける。直されて別の物になった後は、前の物の済みを当てず、担当に
// 見せ直す（白い長袖シャツを買った記録で、赤い帽子を買ったことにしない）。
import { type Command, proposalSnapshot, type Task } from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { demoSessions } from '../src/demo-sessions';
import { memoryStore } from '../src/store';

const at = DEMO_STAGES.find((s) => s.id === 'asked')?.now ?? '';
const buy = keys.task(keys.option(keys.purchaseArrangement('n1:i5'), 'buy'), 'buy');
const seenOf = (task: Task) => ({ titleKey: task.titleKey, titleParams: task.titleParams });

function setup() {
  const store = memoryStore(new Map([['demo', [...demoEvents('asked')]]]));
  let op = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `op-${++op}`, now: at, demo: true },
      command,
    );
  const plan = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      return { events, plan: computePlan(events, at) };
    });
  const task = async () => {
    const found = (await plan()).plan.tasks.find((t) => t.key === buy);
    if (!found) throw new Error('買い物の作業が無い');
    return found;
  };
  return { store, run, plan, task };
}

it('済んだは見せた用件を必ず付け、今の用件と違えば断る（何も書かない）', async () => {
  const { store, run, task } = setup();
  const shirt = await task();
  expect(shirt.assigneeId).toBe('a');
  const count = await store.withHousehold('demo', (log) => log.events().length);
  expect(await run('a', { type: 'commitment', taskKey: buy, action: 'done' })).toMatchObject({
    status: 'invalid',
    reason: 'seenRequired',
  });
  expect(
    await run('a', {
      type: 'commitment',
      taskKey: buy,
      action: 'done',
      seen: { titleKey: 'task.buy', titleParams: { what: '赤い帽子' } },
    }),
  ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
  expect(await store.withHousehold('demo', (log) => log.events().length)).toBe(count);
});

it('買ったシャツが赤い帽子に直されたら、済みを当てずに見せ直し、戻せばまた済みになる', async () => {
  const { run, plan, task } = setup();
  const shirt = await task();
  const shown = proposalSnapshot(shirt);
  if (!shown) throw new Error('置けていない');
  expect(await run('a', { type: 'accept', taskKey: buy, shown })).toMatchObject({ status: 'ok' });
  const card = seenOf(shirt);
  expect(
    await run('a', { type: 'commitment', taskKey: buy, action: 'done', seen: card }),
  ).toMatchObject({ status: 'ok' });
  expect((await task()).commitment).toBe('done');

  // 彩が読み違いを直す：シャツではなく赤い帽子。
  const correct = (what: string) =>
    run('b', { type: 'correctItem', itemId: 'n1:i5', interpretation: { what } });
  expect(await correct('赤い帽子')).toMatchObject({ status: 'ok' });
  const hat = await task();
  expect(hat.titleParams).toEqual({ what: '赤い帽子' });
  expect(hat.commitment).toBe('accepted');
  expect(hat.reconfirm).toBe(true);
  const after = await plan();
  const household = after.events.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  expect(
    verifyPlan({
      household: household.household,
      plan: after.plan,
      events: after.events,
    }).issues.filter((i) => i.kind === 'violation'),
  ).toEqual([]);
  // 前の札（シャツ）のままの「済んだ」は断る。
  expect(
    await run('a', { type: 'commitment', taskKey: buy, action: 'done', seen: card }),
  ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });

  // 直し戻すと、シャツを買った記録がまた当たる。
  expect(await correct('白い長袖シャツ')).toMatchObject({ status: 'ok' });
  expect((await task()).commitment).toBe('done');
});

it('ひとことの「済んだ」の候補も、前提に載せた作業の用件を付ける（ほかにも作業があるので、札で記録する）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('asked');
  const heard = await sessions.utterance(
    id,
    'a',
    { text: 'シャツ買ったよ', operationId: 'say-1' },
    async () => ({
      output: {
        kind: 'change',
        actions: [
          {
            type: 'done',
            taskKey: buy,
            requestId: null,
            reply: null,
            unknownId: null,
            value: null,
          },
        ],
        refs: { taskKeys: [buy], requestIds: [], itemIds: [] },
        unsupported: null,
      },
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  );
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補が無い');
  const [proposal] = heard.reply.proposals;
  if (!proposal) throw new Error('候補が無い');
  expect(proposal.command).toEqual({
    type: 'commitment',
    taskKey: buy,
    action: 'done',
    seen: { titleKey: 'task.buy', titleParams: { what: '白い長袖シャツ' } },
  });
  // デモの家庭にはほかにも作業があるので、一言では記録しない（押しても記録しない）。
  expect(proposal.blocked).toBe('otherTasks');
  expect((await sessions.confirm(id, 'a', proposal.id, 'c-1'))?.status).toBe('changed');
  // 札で、用件を付けた同じ命令を記録する。
  expect((await sessions.command(id, 'a', 'card-1', proposal.command))?.result.status).toBe('ok');
  // 記録に用件が残ったので、直されて別の物になると、済みは当たらない。
  const corrected = await sessions.command(id, 'b', 'cmd-1', {
    type: 'correctItem',
    itemId: 'n1:i5',
    interpretation: { what: '赤い帽子' },
  });
  expect(corrected?.result.status).toBe('ok');
  const hat = corrected?.view.plan.tasks.find((t) => t.key === buy);
  expect(hat?.commitment).toBe('accepted');
  expect(hat?.reconfirm).toBe(true);
});

it('決め時を過ぎた案の選び直しは、今の日の分を始めた時だけ（前の日の申込書の済みでは選べない）', async () => {
  const care = 'arr:childCare:n1:i6:c';
  const gakudo = keys.option(care, 'opt-gakudo');
  const write = keys.task(gakudo, 'write');
  const start = async (moveTo?: string) => {
    const store = memoryStore(new Map([['demo', [...demoEvents('arrived')]]]));
    let op = 0;
    const run = (memberId: string, command: Command) =>
      runCommand(
        store,
        'demo',
        { memberId, operationId: `op-${++op}`, now: '2026-11-25T19:31+09:00', demo: true },
        command,
      );
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: gakudo,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'ok' });
    await run('b', { type: 'proposeAssignment', taskKey: write, assigneeId: 'a' });
    expect(
      await run('a', {
        type: 'commitment',
        taskKey: write,
        action: 'done',
        seen: { titleKey: 'task.gakudoForm.write', titleParams: { date: '2026-12-07' } },
      }),
    ).toMatchObject({ status: 'ok' });
    if (moveTo) {
      expect(
        await run('b', {
          type: 'correctItem',
          itemId: 'n1:i6',
          interpretation: { date: moveTo, writtenWeekday: 1 },
        }),
      ).toMatchObject({ status: 'ok' });
    }
    return run;
  };
  const again = {
    type: 'chooseOption',
    arrangementKey: care,
    optionKey: gakudo,
    role: 'backup',
  } as const;
  // 同じ日のまま決め時（11/30 18:30）を過ぎても、書き始めた案は選び直せる（決め時の確かめを通り、
  // 本命を予備にはしないの確かめまで進む）。
  const same = await start();
  await same('b', { type: 'advanceClock', to: '2026-12-01T09:00+09:00' });
  expect(await same('b', again)).toMatchObject({ status: 'conflict', reason: 'alreadyPrimary' });
  // 12/14 に直され、その決め時（12/7 18:30）も過ぎた：12/7 の済みでは選び直せない。
  const moved = await start('2026-12-14');
  await moved('b', { type: 'advanceClock', to: '2026-12-08T09:00+09:00' });
  expect(await moved('b', again)).toMatchObject({ status: 'conflict', reason: 'optionExpired' });
});
