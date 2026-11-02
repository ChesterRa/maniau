// 扱う店の種類が分からない持ち物：家にあるかを聞き（知らせも出す）、無いと分かったら札を出す。検証器の
// 違反で家庭の知らせを止めない。ほかの手で用意できたら「用意できた」で閉じる。
import { DomainEvent, notificationHistory, notificationIntents } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const at = '2026-11-25T20:30+09:00';
const KEY = 'arr:purchase:n7:h1';
const UNKNOWN = 'u-atHome:n7:h1';

/** 押す直前に開き直した画面が見ている事象の位置。 */
const shownAt = (store: ReturnType<typeof memoryStore>) =>
  store.withHousehold('demo', (log) => log.events().at(-1)?.seq ?? 0);
const TEXT = '12月5日(土)は、ハンカチを持ってきてください。';

function withHandkerchief() {
  const events = [...demoEvents('arrived')];
  const add = (time: string, actorId: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `h-${events.length + 1}`,
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: time,
        recordedAt: time,
        actorId,
        ...body,
      }),
    );
  const first = events.find((e) => e.type === 'noticeReceived');
  if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
  add('2026-11-25T20:00+09:00', 'b', {
    type: 'noticeReceived',
    source: { ...first.source, id: 'n7', title: '持ち物', sentences: [{ id: 'n7#1', text: TEXT }] },
  });
  add('2026-11-25T20:00+09:00', 'system', {
    type: 'modelOutputRecorded',
    call: 'extract',
    sourceId: 'n7',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: 'n7',
    output: {
      sourceId: 'n7',
      unknowns: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
      conditions: [],
      items: [
        {
          id: 'n7:h1',
          sourceId: 'n7',
          sentenceIds: ['n7#1'],
          kind: 'belongings',
          written: TEXT,
          interpretation: { what: 'ハンカチ', date: '2026-12-05', writtenWeekday: 6 },
          evidence: 'stated',
          effects: [],
        },
      ],
    },
  });
  const household = events.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  return { events, household: household.household };
}

it('家にあるかを聞き、知らせも止めない。無いと答えると札が出て、「用意できた」で閉じる', async () => {
  const { events, household } = withHandkerchief();
  const plan = computePlan(events, at);
  expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
  const violations = (p: typeof plan, e: typeof events) =>
    verifyPlan({ household, plan: p, events: e }).issues.filter((i) => i.kind === 'violation');
  expect(violations(plan, events)).toEqual([]);
  const intents = notificationIntents(plan, household, notificationHistory(events));
  const gate = sendGate({ household, plan, events, intents, batchEnds: events.map((e) => e.seq) });
  expect(gate.all).toBe(false);

  const store = memoryStore(new Map([['demo', events]]));
  let op = 0;
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', operationId: `op-${++op}`, now: at, demo: true },
      command,
    );
  expect(
    await run({
      type: 'answer',
      unknownId: UNKNOWN,
      value: 'no',
      seen: { what: 'ハンカチ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'ok' });
  const after = await store.withHousehold('demo', (log) => {
    const all = [...log.events()];
    return { all, view: viewFor(all, 'a', at) };
  });
  expect(violations(after.view.plan, after.all)).toEqual([]);
  expect(after.view.today.main.some((c) => c.kind === 'stuck' && c.arrangement.key === KEY)).toBe(
    true,
  );
  // ほかの手で用意できた。
  expect(
    await run({
      type: 'answer',
      unknownId: UNKNOWN,
      value: 'yes',
      seen: { what: 'ハンカチ', throughSeq: await shownAt(store) },
    }),
  ).toMatchObject({ status: 'ok' });
  const done = await store.withHousehold('demo', (log) => viewFor(log.events(), 'a', at));
  expect(done.plan.arrangements.some((a) => a.key === KEY)).toBe(false);
});
