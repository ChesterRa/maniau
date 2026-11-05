// 通用の「すること」で、家族が進める本命・予備の前もってする手順が、同じ人の同じ時刻に重ならないこと。本命が
// 「はい」で決まって休む予備（idle）と、比べるだけの案は、進める案に入れず、今までどおり置くこと。
// 架空の家庭。同じ大人が、同じ締切（前の日 21:00）の 5 分の頼む手順を、三つの案で持つ。
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
import { previewChange, previewChoices } from '../src/preview';
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
function setup(start: string) {
  const clock = { now: start };
  const now = start;
  const household = initialHousehold();
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

const minutes = (at: string) => Date.parse(at) / 60_000;
function overlaps(x: Task, y: Task): boolean {
  if (!x.start || !x.end || !y.start || !y.end) return false;
  return minutes(x.start) < minutes(y.end) && minutes(y.start) < minutes(x.end);
}

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

const conflictRefs = (plan: PlanResult) =>
  arrangementOf(plan).reasons.flatMap((r) => (r.code === 'timeConflict' ? r.refs : []));

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

/**
 * 予備 h2 を先に選んで 20:55 に引き受け、後から本命 h1 を選んで（20:50）引き受け、h1 に頼んだ。reply が yes
 * なら本命が決まり、予備は休む。無ければ返事待ち（予備は進める）。
 */
async function primaryAsked(h: Harness, reply?: 'yes') {
  const itemId = await stateWindow(h);
  await choose(h, 'ask-h2', 'backup');
  await accept(h, 'ask-h2');
  await choose(h, 'ask-h1', 'primary');
  await accept(h, 'ask-h1');
  await send(h, 'ask-h1', 'req-h1', reply);
  return itemId;
}

describe('通用の「すること」の、進める本命・予備の作業', () => {
  it('同じ人・同じ締切の本命と予備の頼む手順を、重ねずに置く', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    await choose(h, 'ask-h1', 'primary');
    await choose(h, 'ask-h2', 'backup');
    const plan = await h.plan();
    const primary = askTask(plan, 'ask-h1');
    const backup = askTask(plan, 'ask-h2');
    expect(primary).toMatchObject({ assigneeId: 'a', start: '2026-12-11T20:55+09:00' });
    expect(backup).toMatchObject({ assigneeId: 'a', start: '2026-12-11T20:50+09:00' });
    expect(overlaps(primary, backup)).toBe(false);
    expect(arrangementOf(plan).reasons.map((r) => r.code)).not.toContain('timeConflict');
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('本命と予備を入れ替えても重ねない', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    await choose(h, 'ask-h2', 'primary');
    await choose(h, 'ask-h1', 'backup');
    const plan = await h.plan();
    expect(overlaps(askTask(plan, 'ask-h1'), askTask(plan, 'ask-h2'))).toBe(false);
    expect(askTask(plan, 'ask-h2').start).toBe('2026-12-11T20:55+09:00');
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('先に引き受けた時刻は動かさず、後から選んだ方をずらす', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    // 先に h2 を予備に選んで 20:55 に引き受け、後から h1 を本命に選ぶ（本命を先に置く順なら、h2 が動く）。
    await choose(h, 'ask-h2', 'backup');
    let plan = await h.plan();
    const accepted = askTask(plan, 'ask-h2');
    expect(accepted.start).toBe('2026-12-11T20:55+09:00');
    const shown = proposalSnapshot(accepted);
    if (!shown) throw new Error('提案の控えが無い');
    expect(await h.run({ type: 'accept', taskKey: accepted.key, shown })).toMatchObject({
      status: 'ok',
    });
    await choose(h, 'ask-h1', 'primary');
    plan = await h.plan();
    const kept = askTask(plan, 'ask-h2');
    const moved = askTask(plan, 'ask-h1');
    expect(kept).toMatchObject({ start: '2026-12-11T20:55+09:00', commitment: 'accepted' });
    expect(kept.reconfirm).toBeUndefined();
    expect(moved.start).toBe('2026-12-11T20:50+09:00');
    expect(overlaps(kept, moved)).toBe(false);
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('同じ時刻にしか置けない時は、片方に時刻を置かず timeConflict にする（選べるまま）', async () => {
    // 二つとも置ける時に選び、締切の 6 分前に計算し直す。5 分の頼む手順を置ける時は、締切の前の一つだけ
    // （20:55–21:00）。選べない案は選ぶ命令が断るので（optionExpired）、選んだ後に時が進んだ形で確かめる。
    const h = setup('2026-12-11T20:30+09:00');
    await stateWindow(h);
    await choose(h, 'ask-h1', 'primary');
    await choose(h, 'ask-h2', 'backup');
    const later = '2026-12-11T20:54+09:00';
    const recorded = await h.events();
    const plan = computePlan(recorded, later);
    const arrangement = arrangementOf(plan);
    const primary = askTask(plan, 'ask-h1');
    const backup = askTask(plan, 'ask-h2');
    expect(primary.start).toBe('2026-12-11T20:55+09:00');
    // 置けない予備は、本命に重ねて置かず、時刻を置かない。選んだまま、引き受け待ちのまま。
    expect(backup.start).toBeUndefined();
    expect(backup.commitment).toBe('proposed');
    expect(arrangement.reasons).toContainEqual({
      code: 'timeConflict',
      refs: [optionKeyOf(plan, 'ask-h2')],
    });
    expect(arrangement.backupOptionKeys).toEqual([optionKeyOf(plan, 'ask-h2')]);
    const current = foldEvents(recorded).household;
    if (!current) throw new Error('家の情報が無い');
    const verification = verifyPlan({ household: current, plan, events: recorded });
    expect(
      verification.issues.filter((i) => i.kind === 'violation' && i.code === 'task_overlap'),
    ).toEqual([]);
  });

  it('比べるだけの案は、今までどおり、ほかの用事のふさがりだけを避けて置く（進める案も互いもふさがない）', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await stateWindow(h);
    await choose(h, 'ask-h1', 'primary');
    const plan = await h.plan();
    expect(askTask(plan, 'ask-h1').start).toBe('2026-12-11T20:55+09:00');
    // 比べるだけの案は、しない作業（進める案の作業として数えない）。選べば、進める案として置き直す（一つ目）。
    for (const wayId of ['ask-h2', 'ask-h3']) {
      const compared = askTask(plan, wayId);
      expect(compared.start).toBe('2026-12-11T20:55+09:00');
      expect(isActiveTask(plan, compared)).toBe(false);
    }
    expect(await violations(h)).toEqual([]);
  });

  it('本命が「はい」で決まると、予備は休み、ほかの案をふさがず、引き受けた時刻も動かない', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await primaryAsked(h, 'yes');
    const plan = await h.plan();
    const backup = askTask(plan, 'ask-h2');
    expect(isActiveTask(plan, backup)).toBe(false);
    expect(backup).toMatchObject({ start: '2026-12-11T20:55+09:00', commitment: 'accepted' });
    expect(backup.reconfirm).toBeUndefined();
    expect(askTask(plan, 'ask-h3').start).toBe('2026-12-11T20:55+09:00');
    expect(conflictRefs(plan)).toEqual([]);
    expect(await violations(h)).toEqual([]);
  });

  it('本命の「はい」が後で「いいえ」になると、予備はまた進める', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await primaryAsked(h, 'yes');
    expect(await h.run({ type: 'recordReply', requestId: 'req-h1', reply: 'no' })).toMatchObject({
      status: 'ok',
    });
    const plan = await h.plan();
    const backup = askTask(plan, 'ask-h2');
    expect(arrangementOf(plan).inUseOptionKey).toBe(optionKeyOf(plan, 'ask-h2'));
    expect(isActiveTask(plan, backup)).toBe(true);
    // 本命が断られて予備を使う時は、担当にもう一度頼む（引き受け直し。今までと同じ）。時刻は動かない。
    expect(backup).toMatchObject({ start: '2026-12-11T20:55+09:00', commitment: 'proposed' });
    expect(await violations(h)).toEqual([]);
  });

  it('日を直すと、前の日への「はい」では予備を休ませない（二つとも進め、重ねない）', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    const itemId = await primaryAsked(h, 'yes');
    expect(isActiveTask(await h.plan(), askTask(await h.plan(), 'ask-h2'))).toBe(false);
    expect(
      await h.save({ type: 'correctItem', itemId, interpretation: { date: '2026-12-19' } }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-h1', 'ask-h2', 'ask-h3'] }),
    ).toMatchObject({ status: 'ok' });
    const plan = await h.plan();
    const first = askTask(plan, 'ask-h1');
    const second = askTask(plan, 'ask-h2');
    expect(isActiveTask(plan, first)).toBe(true);
    expect(isActiveTask(plan, second)).toBe(true);
    expect(first.start?.startsWith('2026-12-18')).toBe(true);
    expect(second.start?.startsWith('2026-12-18')).toBe(true);
    expect(overlaps(first, second)).toBe(false);
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('二つ目の用事は、一つ目の用事の休む予備と選んでいない案に、押し出されない', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await primaryAsked(h, 'yes');
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
    h.clock.now = '2026-12-11T20:48+09:00';
    const plan = await h.plan();
    const arrangement = plan.arrangements.find(
      (a) => a.kind === 'need' && a.requirementKey === second.key && a.live,
    );
    const option = arrangement?.options[0];
    if (!arrangement || !option) throw new Error('二つ目の用事の案が無い');
    const task = plan.tasks.find((t) => t.basis.optionKey === option.key && t.external);
    // 一つ目の用事で 20:55 に置いた作業（休む予備・比べる案）より前。選べる（決め時を過ぎていない）。
    expect(task).toMatchObject({ start: '2026-12-11T20:50+09:00', end: '2026-12-11T20:55+09:00' });
    expect(option.expired).toBe(false);
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

  it('予備が休む時に、ほかの案を本命に選ぶ「選んだら」は、予備がまた進めて置けなくなることを見せる', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await primaryAsked(h, 'yes');
    // 締切の 6 分前。5 分の頼む手順を置けるのは、20:55–21:00 の一つだけ。
    h.clock.now = '2026-12-11T20:54+09:00';
    const before = await h.plan();
    expect(conflictRefs(before)).toEqual([]);
    const third = optionKeyOf(before, 'ask-h3');
    const recorded = await h.events();
    const shown = previewChoices(
      recorded,
      { memberId: 'a', now: h.clock.now },
      arrangementOf(before).key,
    )?.find((p) => p.optionKey === third);
    if (!shown) throw new Error('h3 の「選んだら」が無い');
    // 見るだけで、何も書かない。
    expect((await h.events()).length).toBe(recorded.length);
    expect(shown.conflicts.length).toBeGreaterThan(0);
    expect(shown.issues ?? []).not.toContain('task_overlap');
    // 本当に選ぶと、見せたのと同じ案が置けなくなる（時刻を置かず、手配に timeConflict）。
    await choose(h, 'ask-h3', 'primary');
    const after = await h.plan();
    expect(conflictRefs(after)).toEqual(shown.conflicts);
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('予備がもう進めている時（本命の返事を待つ間）も、同じく見せる（対照）', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    await primaryAsked(h);
    h.clock.now = '2026-12-11T20:54+09:00';
    const before = await h.plan();
    expect(isActiveTask(before, askTask(before, 'ask-h2'))).toBe(true);
    expect(conflictRefs(before)).toEqual([]);
    const third = optionKeyOf(before, 'ask-h3');
    const shown = previewChoices(
      await h.events(),
      { memberId: 'a', now: h.clock.now },
      arrangementOf(before).key,
    )?.find((p) => p.optionKey === third);
    if (!shown) throw new Error('h3 の「選んだら」が無い');
    expect(shown.conflicts.length).toBeGreaterThan(0);
    expect(shown.issues ?? []).not.toContain('task_overlap');
    await choose(h, 'ask-h3', 'primary');
    expect(conflictRefs(await h.plan())).toEqual(shown.conflicts);
    expect(await overlapViolations(h)).toEqual([]);
  });

  it('頼んだ後に日を直し、同じやり方を選び直しても、進める作業を重ねない', async () => {
    const h = setup('2026-12-01T09:00+09:00');
    const itemId = await stateWindow(h);
    await choose(h, 'ask-h1', 'primary');
    await choose(h, 'ask-h2', 'backup');
    let plan = await h.plan();
    let index = 0;
    for (const wayId of ['ask-h1', 'ask-h2']) {
      const task = askTask(plan, wayId);
      const shown = proposalSnapshot(task);
      if (!shown) throw new Error('提案の控えが無い');
      expect(await h.run({ type: 'accept', taskKey: task.key, shown })).toMatchObject({
        status: 'ok',
      });
      expect(
        await h.run({
          type: 'recordSent',
          taskKey: task.key,
          requestId: `req-${++index}`,
          window: { start: '2026-12-12T13:00+09:00', end: '2026-12-12T15:00+09:00' },
        }),
      ).toMatchObject({ status: 'ok' });
      plan = await h.plan();
    }
    expect(
      await h.save({ type: 'correctItem', itemId, interpretation: { date: '2026-12-19' } }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-h1', 'ask-h2', 'ask-h3'] }),
    ).toMatchObject({ status: 'ok' });
    plan = await h.plan();
    const first = askTask(plan, 'ask-h1');
    const second = askTask(plan, 'ask-h2');
    expect(first.start?.startsWith('2026-12-18')).toBe(true);
    expect(second.start?.startsWith('2026-12-18')).toBe(true);
    expect(overlaps(first, second)).toBe(false);
    expect(await overlapViolations(h)).toEqual([]);
  });
});
