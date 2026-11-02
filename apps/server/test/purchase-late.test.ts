// 買える時を過ぎても、家にあるかがまだ分からなければ、不可能と決めない。問いを残して答えられるようにし、
// 検証器の違反で家庭の知らせを全部止めない。家に無いと分かった後も、過ぎた決め時を添えて示す。
import { DomainEvent, notificationHistory, notificationIntents } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const at = '2026-12-04T20:50+09:00';
const shirt = 'arr:purchase:n1:i5';
const unknownId = 'u-atHome:n1:i5';

/** 押す直前に開き直した画面が見ている事象の位置。 */
const shownAt = (store: ReturnType<typeof memoryStore>) =>
  store.withHousehold('demo', (log) => log.events().at(-1)?.seq ?? 0);

function late() {
  const events = [...demoEvents('arrived')];
  const add = (actorId: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `late-${events.length + 1}`,
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  // 別の手配の、まだ間に合う頼み事（この知らせは、買い物と関係なく出てよい）。
  const arrangementKey = 'arr:childCare:n1:i6:c';
  const optionKey = `opt:${arrangementKey}:opt-grandma`;
  add('b', { type: 'optionChosen', arrangementKey, optionKey, role: 'primary' });
  add('b', { type: 'assignmentProposed', taskKey: `task:${optionKey}:ask`, assigneeId: 'a' });
  const household = events.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  return { events, household: household.household, askKey: `task:${optionKey}:ask` };
}

it('買える時を過ぎても、家にあるかが分からなければ問いを残し、ほかの知らせを止めない', async () => {
  const { events, household, askKey } = late();
  const plan = computePlan(events, at);
  expect(plan.arrangements.find((a) => a.key === shirt)?.status).toBe('askFirst');
  expect(plan.questions.some((q) => q.unknownId === unknownId)).toBe(true);
  const violations = verifyPlan({ household, plan, events }).issues.filter(
    (i) => i.kind === 'violation',
  );
  expect(violations).toEqual([]);
  const intents = notificationIntents(plan, household, notificationHistory(events));
  expect(intents.some((i) => i.subject.type === 'task' && i.subject.id === askKey)).toBe(true);
  // 家にあるかの問いは、持って行く時まで知らせる（今すぐの問いを、送る前に落とさない）。
  expect(
    intents.filter((i) => i.subject.type === 'question' && i.subject.id === unknownId).length,
  ).toBe(2);
  const gate = sendGate({ household, plan, events, intents, batchEnds: events.map((e) => e.seq) });
  expect(gate.all).toBe(false);
  expect(intents.filter((i) => gate.blocked.has(i.key))).toEqual([]);

  // 問いが出ている間も、見せた品物の控えの無い答え（前の版の画面から）は断り、何も書かない。
  const store = memoryStore(new Map([['demo', events]]));
  const count = events.length;
  expect(
    await runCommand(
      store,
      'demo',
      { memberId: 'b', operationId: 'old-page', now: at, demo: true },
      { type: 'answer', unknownId, value: 'yes' },
    ),
  ).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
  expect(await store.withHousehold('demo', (log) => log.events().length)).toBe(count);

  // 正式の命令で「家にある」と答えられ、買い物の手配は無くなる。
  const answered = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'at-home', now: at, demo: true },
    {
      type: 'answer',
      unknownId,
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    },
  );
  expect(answered).toMatchObject({ status: 'ok' });
  const after = await store.withHousehold('demo', (log) => viewFor(log.events(), 'b', at));
  expect(after.plan.arrangements.some((a) => a.key === shirt)).toBe(false);
});

it('家に無いと答えた後は、買える時が無いと示し、検証器の違反にしない', async () => {
  const { events, household } = late();
  const store = memoryStore(new Map([['demo', events]]));
  const answered = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'not-at-home', now: at, demo: true },
    {
      type: 'answer',
      unknownId,
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    },
  );
  expect(answered).toMatchObject({ status: 'ok' });
  const all = await store.withHousehold('demo', (log) => [...log.events()]);
  const plan = computePlan(all, at);
  expect(plan.arrangements.find((a) => a.key === shirt)?.status).toBe('infeasible');
  const violations = verifyPlan({ household, plan, events: all }).issues.filter(
    (i) => i.kind === 'violation',
  );
  expect(violations).toEqual([]);
});

it('お知らせが来た同じ分に、もう買える時が無くても、決め時と「過ぎた」の印が食い違わない', () => {
  const arrived = '2026-12-04T21:30+09:00';
  const events = demoEvents('arrived').map((e) =>
    e.type === 'noticeReceived' ? { ...e, source: { ...e.source, receivedAt: arrived } } : e,
  );
  const household = events.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  const plan = computePlan(events, arrived);
  const arrangement = plan.arrangements.find((a) => a.key === shirt);
  expect(arrangement?.status).toBe('askFirst');
  const option = arrangement?.options[0];
  const subjects = new Set([shirt, option?.key]);
  const issues = verifyPlan({ household: household.household, plan, events }).issues.filter(
    (i) => i.kind === 'violation' && subjects.has(i.subject),
  );
  expect(issues).toEqual([]);
});

it('持って行く時を過ぎたら、買い物の手配の時間の違反で家庭の知らせを止めない（買った後も）', () => {
  const { events, household } = late();
  const buy = `task:opt:${shirt}:buy:buy`;
  const add = (actorId: string, at: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `after-${events.length + 1}`,
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  for (const done of [false, true]) {
    const log = [...events];
    if (done) {
      add('a', '2026-11-26T19:20+09:00', {
        type: 'assignmentProposed',
        taskKey: buy,
        assigneeId: 'a',
      });
      add('a', '2026-11-26T19:21+09:00', {
        type: 'commitmentChanged',
        taskKey: buy,
        assigneeId: 'a',
        action: 'done',
      });
    }
    const all = done ? events : log;
    // 最後の機会の後（買い終えていれば、家にあるかを聞かない）と、持って行く時の後。
    for (const now of [at, '2026-12-05T08:30+09:00']) {
      const plan = computePlan(all, now);
      if (now !== at) expect(plan.arrangements.some((a) => a.key === shirt)).toBe(false);
      const violations = verifyPlan({ household, plan, events: all }).issues.filter(
        (i) => i.kind === 'violation',
      );
      expect(violations).toEqual([]);
    }
  }
});

it('ふだんの週に一度も買える時が無く、家に無いと答えても、示せない決め時で不可能と言わず、違反にしない', async () => {
  const { events } = late();
  const without = events.map((e) =>
    e.type === 'householdSet'
      ? {
          ...e,
          household: {
            ...e.household,
            places: e.household.places.filter(
              (p) => !(p.kind === 'store' && p.goods.includes('kidsClothing')),
            ),
          },
        }
      : e,
  );
  const household = without.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  const store = memoryStore(new Map([['demo', without]]));
  const answered = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'none-at-home', now: at, demo: true },
    {
      type: 'answer',
      unknownId,
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    },
  );
  expect(answered).toMatchObject({ status: 'ok' });
  const all = await store.withHousehold('demo', (log) => [...log.events()]);
  const plan = computePlan(all, at);
  const arrangement = plan.arrangements.find((a) => a.key === shirt);
  expect(arrangement?.status).toBe('undetermined');
  expect(arrangement?.options[0]?.decisionDeadline).toBeUndefined();
  expect(
    verifyPlan({ household: household.household, plan, events: all }).issues.filter(
      (i) => i.kind === 'violation',
    ),
  ).toEqual([]);
});

it('家に無いと答えた後も、ほかの手で用意できたら答えられ、手配が閉じる', async () => {
  const { events } = late();
  const store = memoryStore(new Map([['demo', events]]));
  const ctx = (operationId: string) => ({ memberId: 'b', operationId, now: at, demo: true });
  expect(
    await runCommand(store, 'demo', ctx('no'), {
      type: 'answer',
      unknownId,
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'ok' });
  const stuck = await store.withHousehold('demo', (log) => viewFor(log.events(), 'b', at));
  expect(stuck.plan.questions.some((q) => q.unknownId === unknownId)).toBe(false);
  expect(stuck.today.main.some((c) => c.kind === 'stuck' && c.arrangement.key === shirt)).toBe(
    true,
  );
  // 見せた品物を付けない「用意できた」と、「ある・ない」以外の値は断る（何も足さない）。
  expect(
    await runCommand(store, 'demo', ctx('bare'), { type: 'answer', unknownId, value: 'yes' }),
  ).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
  expect(
    await runCommand(store, 'demo', ctx('maybe'), {
      type: 'answer',
      unknownId,
      value: 'maybe',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'invalid', reason: 'undeclaredValue' });
  expect(
    await runCommand(store, 'demo', ctx('ready'), {
      type: 'answer',
      unknownId,
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'ok' });
  const after = await store.withHousehold('demo', (log) => viewFor(log.events(), 'b', at));
  expect(after.plan.arrangements.some((a) => a.key === shirt)).toBe(false);
  expect(after.today.main.some((c) => c.kind === 'stuck' && c.arrangement.key === shirt)).toBe(
    false,
  );
  // 手配の無い未定の値には、これまでどおり答えられない。
  expect(
    await runCommand(store, 'demo', ctx('gone'), {
      type: 'answer',
      unknownId: 'u-atHome:n1:none',
      value: 'yes',
    }),
  ).toMatchObject({ status: 'conflict', reason: 'unknownGone' });
});

it('直されて別の品物になった後の古い札の「用意できた」は断り、前に「ある」と答えた品物が直されたら聞き直す', async () => {
  const { events } = late();
  const store = memoryStore(new Map([['demo', events]]));
  const as = (memberId: string, operationId: string) => ({
    memberId,
    operationId,
    now: at,
    demo: true,
  });
  await runCommand(store, 'demo', as('b', 'no'), {
    type: 'answer',
    unknownId,
    value: 'no',
    seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
  });
  // b が品物を直す。a の画面は、まだ白い長袖シャツの札。
  expect(
    await runCommand(store, 'demo', as('b', 'fix'), {
      type: 'correctItem',
      itemId: 'n1:i5',
      interpretation: { what: '赤い帽子' },
    }),
  ).toMatchObject({ status: 'ok' });
  expect(
    await runCommand(store, 'demo', as('a', 'old-card'), {
      type: 'answer',
      unknownId,
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
  const view = await store.withHousehold('demo', (log) => viewFor(log.events(), 'a', at));
  expect(view.plan.arrangements.some((a) => a.key === shirt)).toBe(true);

  // 今の札（赤い帽子）で「用意できた」と答え、その後また白い長袖シャツに直されたら、聞き直す。
  expect(
    await runCommand(store, 'demo', as('a', 'hat-ready'), {
      type: 'answer',
      unknownId,
      value: 'yes',
      seen: { what: '赤い帽子', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'ok' });
  await runCommand(store, 'demo', as('b', 'fix-back'), {
    type: 'correctItem',
    itemId: 'n1:i5',
    interpretation: { what: '白い長袖シャツ' },
  });
  const again = await store.withHousehold('demo', (log) => viewFor(log.events(), 'a', at));
  expect(again.plan.arrangements.find((a) => a.key === shirt)?.status).toBe('askFirst');
  expect(again.plan.questions.some((q) => q.unknownId === unknownId)).toBe(true);
});
