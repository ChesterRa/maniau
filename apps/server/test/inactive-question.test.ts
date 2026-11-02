// 条件が外れて要らなくなった持ち物には、家にあるかを聞かない（札も知らせも出さない）。その間に古い札から
// 答えても受けず、条件が戻ったら、もう一度聞く（要らない間の答えを使わない）。
import { DomainEvent, notificationHistory, notificationIntents } from '@maniau/core';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const at = '2026-11-25T20:30+09:00';
// 家にあるかを聞く目安（要る日の前の日の朝）の少し前。知らせは、この頃に出る。
const nearAskBy = '2026-12-04T07:00+09:00';
const UNKNOWN = 'u-atHome:n7:h1';
const TEXT = '雨なら12月5日にハンカチを持ってきてください。';

function withRainyHandkerchief() {
  const events = [...demoEvents('arrived')];
  const add = (actorId: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `r-${events.length + 1}`,
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  const first = events.find((e) => e.type === 'noticeReceived');
  if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
  add('b', {
    type: 'noticeReceived',
    source: {
      ...first.source,
      id: 'n7',
      receivedAt: at,
      title: '持ち物',
      sentences: [{ id: 'n7#1', text: TEXT }],
    },
  });
  add('system', {
    type: 'modelOutputRecorded',
    call: 'extract',
    sourceId: 'n7',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: 'n7',
    output: {
      sourceId: 'n7',
      unknowns: [{ id: 'n7:u1', label: '天気', kind: 'other', values: ['雨', '晴れ'] }],
      irrelevantSentenceIds: [],
      ambiguities: [],
      conditions: [{ id: 'n7:c1', kind: 'eq', unknownId: 'n7:u1', value: '雨' }],
      items: [
        {
          id: 'n7:h1',
          sourceId: 'n7',
          sentenceIds: ['n7#1'],
          kind: 'belongings',
          written: TEXT,
          interpretation: { what: 'ハンカチ', date: '2026-12-05', writtenWeekday: 6 },
          conditionNodeId: 'n7:c1',
          evidence: 'stated',
          effects: [],
        },
      ],
    },
  });
  return events;
}

it('条件が外れた持ち物には聞かず、古い札からの答えも受けない。条件が戻れば、もう一度聞く', async () => {
  const store = memoryStore(new Map([['demo', withRainyHandkerchief()]]));
  let op = 0;
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', operationId: `op-${++op}`, now: at, demo: true },
      command,
    );
  const read = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      const views = ['a', 'b'].map((member) => viewFor(events, member, at));
      const { plan, household } = views[0] ?? viewFor(events, 'a', at);
      const later = viewFor(events, 'a', nearAskBy).plan;
      return {
        events,
        views,
        plan,
        intents: JSON.stringify(notificationIntents(later, household, notificationHistory(events))),
        violations: verifyPlan({ household, plan, events }).issues.filter(
          (issue) => issue.kind === 'violation',
        ),
      };
    });
  const asked = (plan: { questions: readonly { unknownId: string }[] }) =>
    plan.questions.some((q) => q.unknownId === UNKNOWN);
  const card = (view: ReturnType<typeof viewFor>) =>
    [...view.today.main, ...view.today.quiet].some(
      (c) => c.kind === 'question' && c.question.unknownId === UNKNOWN,
    );

  // 雨かどうか決まらない間は、条件しだいの物として聞く（知らせも出る）。
  const before = await read();
  expect(asked(before.plan)).toBe(true);
  expect(before.intents).toContain(UNKNOWN);

  // 晴れと決まった：要らない持ち物には聞かない。
  expect(await run({ type: 'answer', unknownId: 'n7:u1', value: '晴れ' })).toMatchObject({
    status: 'ok',
  });
  const sunny = await read();
  expect(asked(sunny.plan)).toBe(false);
  for (const view of sunny.views) expect(card(view)).toBe(false);
  expect(sunny.intents).not.toContain(UNKNOWN);
  expect(sunny.violations).toEqual([]);

  // 古い札から「ある」と答えても受けない（記録しない）。
  expect(
    await run({
      type: 'answer',
      unknownId: UNKNOWN,
      value: 'yes',
      seen: { what: 'ハンカチ', throughSeq: before.events.at(-1)?.seq ?? 0 },
    }),
  ).toMatchObject({ status: 'conflict', reason: 'unknownGone' });
  expect((await read()).events).toHaveLength(sunny.events.length);

  // 雨に直った：もう一度聞く。
  expect(await run({ type: 'answer', unknownId: 'n7:u1', value: '雨' })).toMatchObject({
    status: 'ok',
  });
  const rainy = await read();
  expect(rainy.plan.arrangements.find((a) => a.atHomeUnknownId === UNKNOWN)?.status).toBe(
    'askFirst',
  );
  expect(asked(rainy.plan)).toBe(true);
  expect(rainy.violations).toEqual([]);
});
