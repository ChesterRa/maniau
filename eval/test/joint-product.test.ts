// 架空の開発用 05/06 を、同じ制約の有限列挙と製品の正式な命令で照らす。API は呼ばない。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runCommand } from '../../apps/server/src/commands';
import { demoEvents } from '../../apps/server/src/demo';
import { sendGate } from '../../apps/server/src/gate';
import { previewChoices } from '../../apps/server/src/preview';
import { memoryStore } from '../../apps/server/src/store';
import {
  type Command,
  Household,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  validateHousehold,
} from '../../packages/core/src';
import { computePlan, keys } from '../../packages/core/src/engine';
import { verifyPlan } from '../../packages/verify/src';
import {
  checkTrial,
  enumerateTrial,
  type TrialDomain,
  type TrialSchedule,
} from '../../packages/verify/test/joint-oracle';

const now = '2026-11-30T17:00+09:00';
const first = 'arr:childCare:n1:i6:c';
const second = 'arr:childCare:eval-i1:c';
const option = (arrangement: string, template: string) => keys.option(arrangement, template);
const task = (arrangement: string, template: string, step: string) =>
  keys.task(option(arrangement, template), step);
const minute = (hour: number, min: number) =>
  Date.parse('2026-11-30T00:00+09:00') / 60_000 + hour * 60 + min;

/** 場面の文章を変更したら、手で作った製品側の前提も見直す。 */
async function checkCase(name: string, expectedHash: string): Promise<void> {
  const bytes = await readFile(new URL(`../cases/${name}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
}

function runner(store: ReturnType<typeof memoryStore>) {
  let sequence = 0;
  const run = async (memberId: string, command: Command) => {
    const result = await runCommand(
      store,
      'demo',
      { memberId, operationId: `eval-joint-${++sequence}`, now, demo: true },
      command,
    );
    assert.equal(result.status, 'ok');
  };
  const state = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      const set = events.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家庭がない');
      return { events, household: set.household, plan: computePlan(events, now) };
    });
  return { run, state };
}

/** 二つ目の休校は固定の架空応答。モデルの読み取りを比較した結果ではない。 */
async function addSecondDay(store: ReturnType<typeof memoryStore>): Promise<void> {
  await store.withHousehold('demo', (log) => {
    const original = log.events().find((event) => event.type === 'noticeReceived');
    if (original?.type !== 'noticeReceived') throw new Error('出典がない');
    const written = '12月8日も学校がお休みです。';
    const sourceId = 'eval-n2';
    const source = {
      ...original.source,
      id: sourceId,
      sentences: [{ id: `${sourceId}#1`, text: written }],
    };
    log.append(
      [
        { type: 'noticeReceived', source },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'eval-joint',
          sourceId,
          output: {
            sourceId,
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'eval-i1',
                sourceId,
                sentenceIds: [`${sourceId}#1`],
                kind: 'dayChange',
                written,
                interpretation: { date: '2026-12-08', dayType: 'noSchool' },
                evidence: 'stated',
                effects: [],
              },
            ],
          },
        },
      ],
      'b',
      now,
    );
  });
}

/** 提案・引き受けを除く、四つの作業の分単位の配置だけを取り出す。 */
function placement(
  plan: Awaited<ReturnType<ReturnType<typeof runner>['state']>>['plan'],
): TrialSchedule {
  const ids = [first, second].flatMap((arrangement) =>
    ['write', 'submit'].map((step) => task(arrangement, 'opt-gakudo', step)),
  );
  return {
    choices: {},
    placements: ids.map((id) => {
      const found = plan.tasks.find((entry) => entry.key === id);
      if (!found?.start || !found.end || !found.assigneeId)
        throw new Error(`作業を置けていない: ${id}`);
      return {
        task: id,
        person: found.assigneeId,
        content: id,
        start: Date.parse(found.start) / 60_000,
        end: Date.parse(found.end) / 60_000,
      };
    }),
  };
}

function domain05(accepted: TrialSchedule): TrialDomain {
  const locked = new Map(accepted.placements.map((entry) => [entry.task, entry]));
  const step = (arrangement: string, name: 'write' | 'submit') => {
    const id = task(arrangement, 'opt-gakudo', name);
    const write = name === 'write';
    return {
      id,
      content: id,
      duration: write ? 10 : 5,
      earliest: write ? minute(17, 0) : minute(17, 55),
      deadline: write ? minute(17, 30) : minute(18, 5),
      people: ['a'],
      ...(write ? {} : { after: [{ task: task(arrangement, 'opt-gakudo', 'write'), wait: 0 }] }),
      ...(locked.has(id) ? { locked: locked.get(id) } : {}),
    };
  };
  return {
    availability: {
      a: [
        { start: minute(17, 0), end: minute(17, 30) },
        { start: minute(17, 55), end: minute(18, 5) },
      ],
    },
    tasks: [
      step(first, 'write'),
      step(second, 'write'),
      step(first, 'submit'),
      step(second, 'submit'),
    ],
  };
}

test('05：同じ二日分の作業を、引き受けを保って置けるか照らす', async () => {
  await checkCase(
    '05-joint-care.json',
    'b6632b38b29e9af8592c674eae76947b21912e621a11a3eb32a0b201a29d5b59',
  );
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const { run, state } = runner(store);
  await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  await addSecondDay(store);
  await run('b', {
    type: 'chooseOption',
    arrangementKey: second,
    optionKey: option(second, 'opt-gakudo'),
    role: 'primary',
    assigneeId: 'a',
  });
  const initial = await state();
  const acceptedPlacements: TrialSchedule['placements'][number][] = [];
  for (const name of ['write', 'submit']) {
    const id = task(second, 'opt-gakudo', name);
    const found = initial.plan.tasks.find((entry) => entry.key === id);
    const shown = found && proposalSnapshot(found);
    if (!shown) throw new Error('先の提案がない');
    const expectedStart = name === 'write' ? minute(17, 20) : minute(18, 0);
    const expectedEnd = name === 'write' ? minute(17, 30) : minute(18, 5);
    assert.equal(Date.parse(shown.start) / 60_000, expectedStart);
    assert.equal(Date.parse(shown.end) / 60_000, expectedEnd);
    await run('a', { type: 'accept', taskKey: id, shown });
    acceptedPlacements.push({
      task: id,
      person: 'a',
      content: id,
      start: Date.parse(shown.start) / 60_000,
      end: Date.parse(shown.end) / 60_000,
    });
  }
  const accepted: TrialSchedule = { choices: {}, placements: acceptedPlacements };
  const reference = domain05(accepted);
  const solutions = enumerateTrial(reference, 1_000_000);
  assert.equal(solutions.complete, true);
  assert.ok(solutions.schedules.length > 0);
  await run('b', {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: option(first, 'opt-gakudo'),
    role: 'primary',
    assigneeId: 'a',
  });
  const result = await state();
  assert.deepEqual(checkTrial(reference, placement(result.plan)), []);
  for (const entry of accepted.placements) {
    const current = result.plan.tasks.find((item) => item.key === entry.task);
    assert.equal(current?.commitment, 'accepted');
    assert.notEqual(current?.reconfirm, true);
  }
  for (const name of ['write', 'submit']) {
    assert.equal(
      result.plan.tasks.find((entry) => entry.key === task(first, 'opt-gakudo', name))?.commitment,
      'proposed',
    );
  }
  const submitted = [first, second].map((arrangement) => task(arrangement, 'opt-gakudo', 'submit'));
  assert.equal(
    result.plan.requests.some((request) => submitted.includes(request.taskKey)),
    false,
  );
  assert.deepEqual(
    verifyPlan(result).issues.filter((issue) => issue.kind === 'violation'),
    [],
  );
  const intents = notificationIntents(
    result.plan,
    result.household,
    notificationHistory(result.events),
  );
  assert.equal(
    sendGate({ ...result, intents, batchEnds: result.events.map((event) => event.seq) }).all,
    false,
  );
});

function domain06(): TrialDomain {
  const write = task(first, 'opt-gakudo', 'write');
  const submit = task(first, 'opt-gakudo', 'submit');
  const apply = task(first, 'opt-leave-a', 'apply');
  return {
    availability: { a: [{ start: minute(17, 10), end: minute(17, 35) }] },
    tasks: [
      {
        id: write,
        content: write,
        duration: 15,
        earliest: minute(17, 10),
        deadline: minute(17, 25),
        people: ['a'],
      },
      {
        id: submit,
        content: submit,
        duration: 5,
        earliest: minute(17, 25),
        deadline: minute(17, 35),
        people: ['a'],
        after: [{ task: write, wait: 0 }],
      },
      {
        id: apply,
        content: apply,
        duration: 5,
        earliest: minute(17, 10),
        deadline: minute(17, 25),
        people: ['a'],
      },
    ],
  };
}

test('06：足りない登録時間を、未配置と理由で示して通知を塞がない', async () => {
  await checkCase(
    '06-joint-conflict.json',
    '09791da29116995f87c955582c6cba2bd271037e958d3bd50b4172ad9ca34dd7',
  );
  const reference = enumerateTrial(domain06(), 100_000);
  assert.equal(reference.complete, true);
  assert.equal(reference.schedules.length, 0);
  const events = demoEvents('arrived');
  const set = events.find((event) => event.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家庭がない');
  const household = structuredClone(set.household);
  const routine = household.routines.find((entry) => entry.memberId === 'a' && entry.weekday === 1);
  const school = household.careOptions.find((entry) => entry.id === 'opt-gakudo');
  const leave = household.careOptions.find((entry) => entry.id === 'opt-leave-a');
  if (!routine || !school?.steps[0] || !leave) throw new Error('決まりがない');
  routine.segments = [
    { kind: 'home', start: '17:00', end: '17:08', placeId: 'home', viaStationIds: [] },
    {
      kind: 'commute',
      start: '17:08',
      end: '17:10',
      fromId: 'home',
      toId: 'gakudo',
      mode: 'walk',
      viaStationIds: [],
    },
    { kind: 'work', start: '17:10', end: '17:25', placeId: 'gakudo', viaStationIds: [] },
    { kind: 'pickup', start: '17:25', end: '17:35', placeId: 'gakudo', viaStationIds: [] },
  ];
  school.deadline = { type: 'weekdayOfPreviousWeek', weekday: 1, at: '17:40' };
  school.steps[0].segments = ['work'];
  school.steps[0].durationMin = 15;
  leave.deadline = { type: 'weekdayOfPreviousWeek', weekday: 1, at: '17:25' };
  household.careOptions = [school, leave];
  const valid = Household.parse(household);
  assert.deepEqual(validateHousehold(valid), []);
  const store = memoryStore(new Map([['demo', events]]));
  await store.withHousehold('demo', (log) =>
    log.append([{ type: 'householdSet', household: valid }], 'b', now),
  );
  const { run, state } = runner(store);
  await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  await run('b', {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: option(first, 'opt-gakudo'),
    role: 'backup',
    assigneeId: 'a',
  });
  const before = await state();
  const target = option(first, 'opt-leave-a');
  const preview = previewChoices(before.events, { memberId: 'a', now }, first)?.find(
    (entry) => entry.optionKey === target,
  );
  if (!preview?.seen || !preview.assigneeId) throw new Error('見通しがない');
  assert.ok(preview.conflicts.length > 0);
  assert.deepEqual(preview.issues, []);
  assert.equal((await state()).plan.throughSeq, before.plan.throughSeq);
  await run('a', {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: target,
    role: 'primary',
    assigneeId: preview.assigneeId,
    seen: preview.seen,
  });
  const result = await state();
  const affected = result.plan.arrangements.find((entry) => entry.key === first);
  assert.ok(affected?.reasons.some((reason) => reason.code === 'timeConflict'));
  assert.ok(
    result.plan.tasks.some(
      (entry) =>
        entry.basis.optionKey &&
        preview.conflicts.includes(entry.basis.optionKey) &&
        !entry.extra &&
        !entry.start,
    ),
  );
  assert.equal(
    result.plan.tasks.find((entry) => entry.key === task(first, 'opt-gakudo', 'write'))?.commitment,
    'proposed',
  );
  assert.equal(
    result.plan.requests.some((request) => request.taskKey === task(first, 'opt-leave-a', 'apply')),
    false,
  );
  assert.deepEqual(
    verifyPlan(result).issues.filter((issue) => issue.kind === 'violation'),
    [],
  );
  const intents = notificationIntents(
    result.plan,
    result.household,
    notificationHistory(result.events),
  );
  assert.equal(
    sendGate({ ...result, intents, batchEnds: result.events.map((event) => event.seq) }).all,
    false,
  );
});
