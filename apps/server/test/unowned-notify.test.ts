// だれも持っていない作業の知らせ：計画から作った本物の意図を、検証器の送る前の確かめに通す。
import { DomainEvent, notificationHistory, notificationIntents } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';

const written = '個人面談の出欠票を、11月27日(金)までに担任に提出してください。';
const taskKey = 'task:submit:n3:i1';

function withSubmission() {
  const events = [...demoEvents('arrived')];
  const at = '2026-11-25T20:00+09:00';
  const add = (actorId: string, time: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `un-${events.length + 1}`,
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
  const household = events.find((e) => e.type === 'householdSet');
  if (first?.type !== 'noticeReceived' || household?.type !== 'householdSet')
    throw new Error('お知らせか家族が無い');
  add('b', at, {
    type: 'noticeReceived',
    source: {
      ...first.source,
      id: 'n3',
      receivedAt: at,
      title: '個人面談',
      sentences: [{ id: 'n3#1', text: written }],
    },
  });
  add('system', at, {
    type: 'modelOutputRecorded',
    call: 'extract',
    sourceId: 'n3',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: 'n3',
    output: {
      sourceId: 'n3',
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
      items: [
        {
          id: 'n3:i1',
          sourceId: 'n3',
          sentenceIds: ['n3#1'],
          kind: 'submission',
          written,
          interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
          evidence: 'stated',
          effects: [],
        },
      ],
    },
  });
  return { events, household: household.household, add };
}

it('締切の前の日には、二人に知らせ、検証器はどれも止めない。だれかが持てば知らせない', () => {
  const { events, household, add } = withSubmission();
  const now = '2026-11-26T07:00+09:00';
  const plan = computePlan(events, now);
  const intents = notificationIntents(plan, household, notificationHistory(events));
  const unowned = intents.filter((i) => i.titleKey === 'notify.unowned');
  expect(unowned.map((i) => i.toMemberId).sort()).toEqual(['a', 'b']);
  expect(unowned.every((i) => i.subject.type === 'task' && i.subject.id === taskKey)).toBe(true);
  expect(
    verifyPlan({ household, plan, events }).issues.filter((i) => i.kind === 'violation'),
  ).toEqual([]);
  const gate = sendGate({ household, plan, events, intents, batchEnds: events.map((e) => e.seq) });
  expect(gate.all).toBe(false);
  expect(unowned.filter((i) => gate.blocked.has(i.key))).toEqual([]);

  add('b', '2026-11-26T06:55+09:00', { type: 'assignmentProposed', taskKey, assigneeId: 'b' });
  const taken = computePlan(events, now);
  expect(
    notificationIntents(taken, household, notificationHistory(events)).filter(
      (i) => i.titleKey === 'notify.unowned',
    ),
  ).toEqual([]);
});
