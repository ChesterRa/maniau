// 後の「すること」へ渡すふさがりに、比べるだけの候補（だれも引き受けていない、進めない、勧めない案）を入れないこと。
// 実際に時間を使う作業（進める案・勧める案・済んだ物）と、本人が引き受けた作業は入れる（守る）。架空の家とデモの家。
import {
  type Command,
  DomainEvent,
  Household,
  isActiveTask,
  type PlanResult,
  proposalSnapshot,
  type SaveablePreview,
  type Task,
} from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const COST = { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 };

const ask = (helper: string) => ({
  id: `ask-${helper}`,
  name: `${helper}に頼む`,
  deadline: { type: 'daysBefore' as const, days: 1, at: '21:00' },
  steps: [
    {
      id: 'ask',
      name: `${helper}に、子を見てもらうよう頼む`,
      durationMin: 5,
      segments: ['home' as const],
      waitAfterMin: 0,
      external: { to: helper, kind: 'reply' as const },
      assigneeId: 'a',
      cover: true as const,
    },
  ],
  cost: COST,
});

function initialHousehold() {
  return Household.parse({
    id: 'overlap-home',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a', kind: 'adult', name: 'アキ' },
      { id: 'b', kind: 'adult', name: 'ボウ' },
      { id: 'h1', kind: 'helper', name: '協力先一' },
      { id: 'h2', kind: 'helper', name: '協力先二' },
      { id: 'h3', kind: 'helper', name: '協力先三' },
    ],
    places: [{ id: 'home', kind: 'home', name: '家' }],
    routines: ['a', 'b'].flatMap((memberId) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        memberId,
        weekday,
        segments: [{ start: '00:00', end: '23:59', kind: 'home', placeId: 'home' }],
      })),
    ),
    careOptions: [],
    ways: [ask('h1'), ask('h2'), ask('h3')],
  });
}

/** 架空の家の記録と、命令・計算・検証の口。clock.now を進めると、後の命令と計算はその時刻で行う。 */
function setup(start: string, edit?: (household: Household) => void) {
  const clock = { now: start };
  const now = start;
  const household = initialHousehold();
  edit?.(household);
  const householdSet = DomainEvent.parse({
    type: 'householdSet',
    household,
    id: 'initial',
    householdId: household.id,
    seq: 1,
    version: 1,
    occurredAt: now,
    recordedAt: now,
    actorId: 'a',
  });
  const store = memoryStore(new Map([[household.id, [householdSet]]]));
  const events = () => store.withHousehold(household.id, (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      household.id,
      { memberId: 'a', now: clock.now, operationId: `overlap-${++sequence}`, demo: true },
      command,
    );
  const save = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'a', now: clock.now }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const plan = async () => computePlan(await events(), clock.now);
  const verify = async () => {
    const recorded = await events();
    const current = foldEvents(recorded).household;
    if (!current) throw new Error('家の情報が無い');
    return verifyPlan({ household: current, plan: await plan(), events: recorded });
  };
  return { events, run, save, plan, verify, clock };
}

type Harness = ReturnType<typeof setup>;

async function stateWindow(h: Harness, date = '2026-12-12') {
  expect(
    await h.save({
      type: 'stateNeed',
      text: `${date} の 13 時から 15 時、子を見てもらう。`,
      interpretation: {
        what: '子を見てもらう',
        shape: 'window',
        date,
        startTime: '13:00',
        endTime: '15:00',
      },
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await h.plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('「すること」の事項が無い');
  expect(
    await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-h1', 'ask-h2', 'ask-h3'] }),
  ).toMatchObject({ status: 'ok' });
  return itemId;
}

const arrangementOf = (plan: PlanResult) => {
  const found = plan.arrangements.find((a) => a.kind === 'need' && a.live);
  if (!found) throw new Error('「すること」の手配が無い');
  return found;
};

const optionKeyOf = (plan: PlanResult, wayId: string) => {
  const key = arrangementOf(plan).options.find((o) => o.templateId === wayId)?.key;
  if (!key) throw new Error(`${wayId} の案が無い`);
  return key;
};

const askTask = (plan: PlanResult, wayId: string): Task => {
  const optionKey = optionKeyOf(plan, wayId);
  const found = plan.tasks.find((t) => t.basis.optionKey === optionKey && t.live && t.external);
  if (!found) throw new Error(`${wayId} の頼む作業が無い`);
  return found;
};

/** 案を選ぶ。propose が真なら、担当を付けて作業を提案し直す（前の引き受けは当てない）。 */
async function choose(h: Harness, wayId: string, role: 'primary' | 'backup', propose = true) {
  const plan = await h.plan();
  const result = await h.run({
    type: 'chooseOption',
    arrangementKey: arrangementOf(plan).key,
    optionKey: optionKeyOf(plan, wayId),
    role,
    ...(propose ? { assigneeId: 'a' } : {}),
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok' });
}

const overlapViolations = async (h: Harness) =>
  (await h.verify()).issues.filter(
    (issue) => issue.kind === 'violation' && issue.code === 'task_overlap',
  );

const violations = async (h: Harness) =>
  (await h.verify()).issues.filter((issue) => issue.kind === 'violation');

/** その案の頼む作業を、担当（a）が見たとおりに引き受ける。 */
async function accept(h: Harness, wayId: string) {
  const task = askTask(await h.plan(), wayId);
  const shown = proposalSnapshot(task);
  if (!shown) throw new Error('提案の控えが無い');
  expect(await h.run({ type: 'accept', taskKey: task.key, shown })).toMatchObject({
    status: 'ok',
  });
}
/** その案の依頼を送ったと記録し、返事があれば記録する。 */
async function send(h: Harness, wayId: string, requestId: string, reply?: 'yes' | 'no') {
  const plan = await h.plan();
  const task = askTask(plan, wayId);
  const { start, end } = arrangementOf(plan);
  expect(
    await h.run({ type: 'recordSent', taskKey: task.key, requestId, window: { start, end } }),
  ).toMatchObject({ status: 'ok' });
  if (reply) {
    expect(await h.run({ type: 'recordReply', requestId, reply })).toMatchObject({
      status: 'ok',
    });
  }
}

/** 二つ目の「すること」（同じ日の窓、やり方は h3 に頼むだけ）を足し、その要件の key を返す。 */
async function secondNeed(h: Harness) {
  expect(
    await h.save({
      type: 'stateNeed',
      text: '架空の別の用事',
      interpretation: {
        what: '架空の別の用事',
        shape: 'window',
        date: '2026-12-12',
        startTime: '13:00',
        endTime: '15:00',
      },
    }),
  ).toMatchObject({ status: 'ok' });
  const second = (await h.plan()).requirements.find(
    (r) => r.kind === 'need' && r.what === '架空の別の用事' && r.live,
  );
  const itemId = second?.basis.itemIds[0];
  if (!second || !itemId) throw new Error('二つ目の用事が無い');
  expect(await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-h3'] })).toMatchObject({
    status: 'ok',
  });
  return second.key;
}

const secondOption = (plan: PlanResult, requirementKey: string) => {
  const arrangement = plan.arrangements.find(
    (a) => a.kind === 'need' && a.requirementKey === requirementKey && a.live,
  );
  const option = arrangement?.options[0];
  if (!arrangement || !option) throw new Error('二つ目の用事の案が無い');
  return { arrangement, option };
};

describe('後の「すること」へ渡すふさがり', () => {
  it('決まった用事の、比べるだけの候補は、後の用事の最後の一枠をふさがない', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    await choose(h, 'ask-h1', 'primary');
    await accept(h, 'ask-h1');
    await send(h, 'ask-h1', 'req-h1', 'yes');
    const key = await secondNeed(h);
    h.clock.now = '2026-12-11T20:53+09:00';
    const plan = await h.plan();
    expect(isActiveTask(plan, askTask(plan, 'ask-h2'))).toBe(false);
    expect(isActiveTask(plan, askTask(plan, 'ask-h3'))).toBe(false);
    const { arrangement, option } = secondOption(plan, key);
    expect(option).toMatchObject({ decisionDeadline: '2026-12-11T20:55+09:00', expired: false });
    expect(
      await h.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await violations(h)).toEqual([]);
  });

  it('何も選んでいない時に勧める案は、後の用事から守る（検証器と同じ見方）', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    const first = arrangementOf(await h.plan());
    expect(first.chosenOptionKey).toBeUndefined();
    const recommended = first.recommendedOptionKey;
    if (!recommended) throw new Error('勧める案が無い');
    const key = await secondNeed(h);
    const plan = await h.plan();
    const task = plan.tasks.find((t) => t.basis.optionKey === recommended && t.external);
    expect(task?.start).toBe('2026-12-11T20:55+09:00');
    const { option } = secondOption(plan, key);
    expect(option.decisionDeadline).toBe('2026-12-11T20:50+09:00');
  });

  it('選んでいない案でも、本人が引き受けた作業は、後の用事から守る', async () => {
    // 代償の分からないやり方があり、勧めない。画面は選んでいない案の引き受けを出さないが、命令は受ける。
    const h = setup('2026-12-01T09:00+09:00', (household) => {
      const way = household.ways.find((w) => w.id === 'ask-h1');
      if (!way) throw new Error('やり方が無い');
      way.cost.unknown = ['yen'];
    });
    await stateWindow(h);
    let plan = await h.plan();
    expect(arrangementOf(plan).recommendedOptionKey).toBeUndefined();
    await accept(h, 'ask-h2');
    plan = await h.plan();
    expect(askTask(plan, 'ask-h2')).toMatchObject({
      commitment: 'accepted',
      start: '2026-12-11T20:55+09:00',
    });
    expect(isActiveTask(plan, askTask(plan, 'ask-h2'))).toBe(false);
    const key = await secondNeed(h);
    h.clock.now = '2026-12-11T20:48+09:00';
    plan = await h.plan();
    const { arrangement, option } = secondOption(plan, key);
    expect(option.decisionDeadline).toBe('2026-12-11T20:50+09:00');
    expect(
      await h.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('子の居場所の、勧めていない比べるだけの案は、後の「すること」をふさがない（デモの家）', async () => {
    // デモの家（架空）。祖母に頼むやり方の担当を、子の居場所の祖母の案と同じ大人（a）にする。
    const initial = demoEvents('arrived').map((event) => {
      if (event.type !== 'householdSet') return event;
      const household = structuredClone(event.household);
      const step = household.ways.find((way) => way.id === 'way-grandma')?.steps[0];
      if (!step) throw new Error('やり方が無い');
      step.assigneeId = 'a';
      return { ...event, household };
    });
    const store = memoryStore(new Map([['demo', initial]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    const now = '2026-11-25T19:31+09:00';
    let op = 0;
    const run = (command: Command) =>
      runCommand(
        store,
        'demo',
        { memberId: 'a', operationId: `care-${++op}`, now, demo: true },
        command,
      );
    const save = async (command: SaveablePreview) => {
      const shown = previewChange(await events(), { memberId: 'a', now }, command);
      if ('reason' in shown) throw new Error(shown.reason);
      return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
    };
    expect(
      await save({
        type: 'stateNeed',
        text: '12/5 の架空の用事',
        interpretation: {
          what: '架空の用事',
          shape: 'window',
          date: '2026-12-05',
          startTime: '13:00',
          endTime: '15:00',
        },
      }),
    ).toMatchObject({ status: 'ok' });
    let plan = computePlan(await events(), now);
    const requirement = plan.requirements.find(
      (r) => r.kind === 'need' && r.live && r.what === '架空の用事',
    );
    const itemId = requirement?.basis.itemIds[0];
    if (!requirement || !itemId) throw new Error('「すること」が無い');
    expect(await save({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] })).toMatchObject({
      status: 'ok',
    });
    plan = computePlan(await events(), now);
    const care = plan.arrangements.find((a) => a.kind === 'childCare' && a.live);
    const grandma = care?.options.find((o) => o.templateId === 'opt-grandma');
    const careTask = plan.tasks.find((t) => t.basis.optionKey === grandma?.key && t.external);
    if (!care || !grandma || !careTask) throw new Error('子の居場所の案が無い');
    // 祖母の案は、選んでも勧めてもいない比べるだけの案（12/4 20:55 に頼む）。
    expect(care.chosenOptionKey).toBeUndefined();
    expect(care.recommendedOptionKey).not.toBe(grandma.key);
    expect(careTask.start).toBe('2026-12-04T20:55+09:00');
    expect(isActiveTask(plan, careTask)).toBe(false);
    const { arrangement, option } = secondOption(plan, requirement.key);
    expect(option.decisionDeadline).toBe('2026-12-04T20:55+09:00');
    expect(
      await run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const recorded = await events();
    const household = foldEvents(recorded).household;
    if (!household) throw new Error('家の情報が無い');
    expect(
      verifyPlan({ household, plan: computePlan(recorded, now), events: recorded }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
  });
});
