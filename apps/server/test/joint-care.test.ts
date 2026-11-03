// 家族が進める案どうしを一緒に置く（架空のデモ・正式な命令。API は呼ばない）。12/7 と 12/8 の二日分の学童の
// 届けを同じ大人が持つと、案ごとの逆算では同じ時刻に重なる。一緒に置けば、片方を前にずらして両方に間に
// 合わせ、その分だけ決め時も早くなる。引き受けた作業の時刻は、なるべく動かさない。
import {
  type Command,
  Household,
  proposalSnapshot,
  type Task,
  todayCards,
  toEpochMinutes,
  validateHousehold,
} from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChoices } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T19:31+09:00';
const first = 'arr:childCare:n1:i6:c';
const second = 'arr:childCare:joint-i1:c';
const gakudo = (arrangementKey: string) => keys.option(arrangementKey, 'opt-gakudo');

/** 12/7 に加えて、12/8 も休みになった家庭（読み取りは架空の固定値）。 */
async function twoDays() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  let op = 0;
  const run = async (memberId: string, command: Command) =>
    expect(
      (
        await runCommand(
          store,
          'demo',
          { memberId, operationId: `joint-${++op}`, now: NOW, demo: true },
          command,
        )
      ).status,
    ).toBe('ok');
  await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  await store.withHousehold('demo', (log) => {
    const original = log.events().find((e) => e.type === 'noticeReceived');
    if (original?.type !== 'noticeReceived') throw new Error('出典が無い');
    const written = '12月8日も学校がお休みです。';
    const source = {
      ...original.source,
      id: 'joint-n',
      sentences: [{ id: 'joint-n#1', text: written }],
    };
    log.append(
      [
        { type: 'noticeReceived', source },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'joint',
          sourceId: source.id,
          output: {
            sourceId: source.id,
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'joint-i1',
                sourceId: source.id,
                sentenceIds: ['joint-n#1'],
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
      NOW,
    );
  });
  const state = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      const plan = computePlan(events, NOW);
      const set = events.findLast((e) => e.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家族が無い');
      return { events, plan, household: set.household };
    });
  return { run, state };
}

/** 学童の案の、時刻のある作業（当日の準備を除く）。 */
const placed = (tasks: readonly Task[], arrangementKey: string) =>
  tasks.filter((t) => t.basis.optionKey === gakudo(arrangementKey) && !t.extra && t.start && t.end);

const overlaps = (a: Task, b: Task) =>
  a.assigneeId === b.assigneeId &&
  toEpochMinutes(a.start ?? '') < toEpochMinutes(b.end ?? '') &&
  toEpochMinutes(b.start ?? '') < toEpochMinutes(a.end ?? '');

it('二日分の学童の届けを同じ大人が持っても、同じ時刻に重ねず、片方の決め時を早める', async () => {
  const h = await twoDays();
  const before = (await h.state()).plan;
  const alone = before.arrangements
    .find((a) => a.key === second)
    ?.options.find((o) => o.key === gakudo(second))?.decisionDeadline;
  for (const arrangementKey of [first, second]) {
    await h.run('b', {
      type: 'chooseOption',
      arrangementKey,
      optionKey: gakudo(arrangementKey),
      role: 'primary',
      assigneeId: 'a',
    });
  }
  const result = await h.state();
  const mine = [...placed(result.plan.tasks, first), ...placed(result.plan.tasks, second)];
  expect(mine.length).toBeGreaterThanOrEqual(4);
  for (const [i, a] of mine.entries()) {
    for (const b of mine.slice(i + 1)) expect(overlaps(a, b), `${a.key} / ${b.key}`).toBe(false);
  }
  const deadlines = [first, second].map((key) =>
    result.plan.arrangements.find((a) => a.key === key)?.options.find((o) => o.key === gakudo(key)),
  );
  for (const option of deadlines) {
    expect(option?.decisionDeadline).toBeDefined();
    expect(option?.expired).toBe(false);
  }
  // 片方は、ひとりで置いた時より早く始める（もう一方が同じ人の遅い時間を使う）。
  expect(deadlines[0]?.decisionDeadline).not.toBe(deadlines[1]?.decisionDeadline);
  expect(alone).toBeDefined();
  expect(
    deadlines.some((o) => toEpochMinutes(o?.decisionDeadline ?? '') < toEpochMinutes(alone ?? '')),
  ).toBe(true);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('引き受けた作業の時刻は動かさず、後から進める案の方を前にずらす', async () => {
  const h = await twoDays();
  // 先に 12/8 の学童を a が持って引き受ける（見た提案の控えを付ける）。
  await h.run('a', {
    type: 'chooseOption',
    arrangementKey: second,
    optionKey: gakudo(second),
    role: 'primary',
    assigneeId: 'a',
  });
  const accepted = placed((await h.state()).plan.tasks, second);
  for (const task of accepted) {
    const shown = proposalSnapshot(task);
    if (!shown) throw new Error('提案の控えが無い');
    await h.run('a', { type: 'accept', taskKey: task.key, shown });
  }
  // その後で 12/7 の学童も a が持つ。
  await h.run('b', {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: gakudo(first),
    role: 'primary',
    assigneeId: 'a',
  });
  const result = await h.state();
  const kept = placed(result.plan.tasks, second);
  expect(kept.map((t) => [t.key, t.start, t.end, t.commitment, t.reconfirm ?? false])).toEqual(
    accepted.map((t) => [t.key, t.start, t.end, 'accepted', false]),
  );
  const mine = [...placed(result.plan.tasks, first), ...kept];
  for (const [i, a] of mine.entries()) {
    for (const b of mine.slice(i + 1)) expect(overlaps(a, b), `${a.key} / ${b.key}`).toBe(false);
  }
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('済ませた手順は時間を取らない（前提が外れた日の済みも、計画の時刻を残さず、新しい案を塞がない）', async () => {
  const h = await twoDays();
  await h.run('b', {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: gakudo(first),
    role: 'primary',
    assigneeId: 'a',
  });
  const write = (await h.state()).plan.tasks.find(
    (t) => t.key === keys.task(gakudo(first), 'write'),
  );
  if (!write) throw new Error('作業が無い');
  await h.run('a', {
    type: 'commitment',
    taskKey: write.key,
    action: 'done',
    seen: { titleKey: write.titleKey, titleParams: write.titleParams },
  });
  // 行事が 12/8 に替わり、12/7 の休み（振替）は要らなくなる。12/8 の学童を同じ大人が持つ。
  await h.run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-08' });
  await h.run('b', {
    type: 'chooseOption',
    arrangementKey: second,
    optionKey: gakudo(second),
    role: 'primary',
    assigneeId: 'a',
  });
  const result = await h.state();
  const done = result.plan.tasks.find((t) => t.key === write.key);
  // 済ませた時刻は記録に無いので、計画の時刻を済ませた時として残さない。
  expect(done).toMatchObject({ live: false, commitment: 'done' });
  expect(done?.start).toBeUndefined();
  expect(done?.end).toBeUndefined();
  expect(placed(result.plan.tasks, second).length).toBeGreaterThan(0);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('本命が「はい」で決まり、もう進めない予備は、別の日の作業の時間を塞がない', async () => {
  const run = async (dropBackup: boolean) => {
    const h = await twoDays();
    const grandma = keys.option(first, 'opt-grandma');
    await h.run('b', {
      type: 'chooseOption',
      arrangementKey: first,
      optionKey: grandma,
      role: 'primary',
      assigneeId: 'b',
    });
    await h.run('b', {
      type: 'chooseOption',
      arrangementKey: first,
      optionKey: gakudo(first),
      role: 'backup',
      assigneeId: 'a',
    });
    const arrangement = (await h.state()).plan.arrangements.find((a) => a.key === first);
    if (!arrangement) throw new Error('手配が無い');
    await h.run('b', {
      type: 'recordSent',
      taskKey: keys.task(grandma, 'ask'),
      requestId: 'r-yes',
      window: { start: arrangement.start, end: arrangement.end },
    });
    await h.run('b', { type: 'recordReply', requestId: 'r-yes', reply: 'yes' });
    if (dropBackup) {
      await h.run('b', { type: 'dropOption', arrangementKey: first, optionKey: gakudo(first) });
    }
    await h.run('b', {
      type: 'chooseOption',
      arrangementKey: second,
      optionKey: gakudo(second),
      role: 'primary',
      assigneeId: 'a',
    });
    return h.state();
  };
  const kept = await run(false);
  const dropped = await run(true);
  const writeOf = (result: Awaited<ReturnType<typeof run>>) =>
    result.plan.tasks.find((t) => t.key === keys.task(gakudo(second), 'write'));
  // 進めない予備を残していても、外した時と同じ所に置く（予備に時間を取られない）。
  expect(writeOf(kept)?.start).toBeDefined();
  expect(writeOf(kept)?.start).toBe(writeOf(dropped)?.start);
  const reasons = kept.plan.arrangements.find((a) => a.key === second)?.reasons ?? [];
  expect(reasons.some((r) => r.code === 'timeConflict')).toBe(false);
  expect(verifyPlan(kept).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

/**
 * 一人の大人の、狭い時間しか無い月曜（17:00–17:08 家、17:10–17:25 学童で仕事、17:25–17:35 お迎え）。
 * 祖母に頼むのは家か仕事の間の 5 分、学童の申込書は仕事の間の 15 分、出すのはお迎えの間。
 */
async function narrowMonday(leaveOnMonday = false) {
  const now = '2026-11-30T17:00+09:00';
  const events = demoEvents('arrived');
  const set = events.find((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家族が無い');
  const household = structuredClone(set.household);
  const monday = household.routines.find((r) => r.memberId === 'a' && r.weekday === 1);
  const helper = household.careOptions.find((o) => o.id === 'opt-grandma');
  const school = household.careOptions.find((o) => o.id === 'opt-gakudo');
  if (!monday || !helper?.steps[0] || !school?.steps[0]) throw new Error('家族の決まりが無い');
  monday.segments = [
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
  helper.deadline = { type: 'weekdayOfPreviousWeek', weekday: 1, at: '17:25' };
  helper.steps[0].segments = ['home', 'work'];
  helper.steps[0].waitAfterMin = 0;
  school.deadline = { type: 'weekdayOfPreviousWeek', weekday: 1, at: '17:40' };
  school.steps[0].segments = ['work'];
  school.steps[0].durationMin = 15;
  // 休みの申請も、月曜の仕事の間（17:25 まで）にしか出せない時。
  const leave = household.careOptions.find((o) => o.id === 'opt-leave-a');
  if (leaveOnMonday && leave) {
    leave.deadline = { type: 'weekdayOfPreviousWeek', weekday: 1, at: '17:25' };
  }
  const valid = Household.parse(household);
  expect(validateHousehold(valid)).toEqual([]);
  const store = memoryStore(new Map([['demo', events]]));
  await store.withHousehold('demo', (log) =>
    log.append([{ type: 'householdSet', household: valid }], 'b', now),
  );
  let op = 0;
  const run = async (memberId: string, command: Command) =>
    expect(
      (
        await runCommand(
          store,
          'demo',
          { memberId, operationId: `narrow-${++op}`, now, demo: true },
          command,
        )
      ).status,
    ).toBe('ok');
  await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  const state = () =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      return { events: all, household: valid, plan: computePlan(all, now) };
    });
  return { run, state, now };
}

const choose = (optionId: string, role: 'primary' | 'backup'): Command => ({
  type: 'chooseOption',
  arrangementKey: first,
  optionKey: keys.option(first, optionId),
  role,
  assigneeId: 'a',
});

it('本命が予備にしか使えない時間を先に取らないよう、同じ手配の中でも置く順を探す', async () => {
  const h = await narrowMonday();
  await h.run('b', choose('opt-grandma', 'primary'));
  await h.run('b', choose('opt-gakudo', 'backup'));
  const result = await h.state();
  const mine = result.plan.tasks.filter(
    (t) => t.basis.arrangementKey === first && !t.extra && t.start && t.assigneeId === 'a',
  );
  for (const [i, a] of mine.entries()) {
    for (const b of mine.slice(i + 1)) expect(overlaps(a, b), `${a.key} / ${b.key}`).toBe(false);
  }
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('引き受けた予備の時刻を保てるなら、本命の方を空いた時間へ置く', async () => {
  const h = await narrowMonday();
  await h.run('b', choose('opt-gakudo', 'backup'));
  const write = (await h.state()).plan.tasks.find(
    (t) => t.key === keys.task(keys.option(first, 'opt-gakudo'), 'write'),
  );
  const shown = write && proposalSnapshot(write);
  if (!write || !shown) throw new Error('提案の控えが無い');
  await h.run('a', { type: 'accept', taskKey: write.key, shown });
  await h.run('b', choose('opt-grandma', 'primary'));
  const result = await h.state();
  expect(result.plan.tasks.find((t) => t.key === write.key)).toMatchObject({
    start: write.start,
    end: write.end,
    commitment: 'accepted',
  });
  expect(result.plan.tasks.find((t) => t.key === write.key)?.reconfirm ?? false).toBe(false);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('予備の手順を済ませた後に本命を選んでも、済んだ手順の計画の時刻で塞がず、残りの手順を置く', async () => {
  const h = await narrowMonday(true);
  await h.run('b', choose('opt-gakudo', 'backup'));
  const write = (await h.state()).plan.tasks.find(
    (t) => t.key === keys.task(keys.option(first, 'opt-gakudo'), 'write'),
  );
  if (!write) throw new Error('作業が無い');
  await h.run('a', {
    type: 'commitment',
    taskKey: write.key,
    action: 'done',
    seen: { titleKey: write.titleKey, titleParams: write.titleParams },
  });
  await h.run('b', choose('opt-leave-a', 'primary'));
  const result = await h.state();
  const task = (key: string) => result.plan.tasks.find((t) => t.key === key);
  expect(task(write.key)).toMatchObject({ commitment: 'done' });
  expect(task(write.key)?.start).toBeUndefined();
  // 休みの申請も、学童の残りの手順（出す）も、時刻を持つ。重なりの理由は付かない。
  expect(task(keys.task(keys.option(first, 'opt-leave-a'), 'apply'))?.start).toBeDefined();
  expect(task(keys.task(keys.option(first, 'opt-gakudo'), 'submit'))?.start).toBeDefined();
  const reasons = result.plan.arrangements.find((a) => a.key === first)?.reasons ?? [];
  expect(reasons.some((r) => r.code === 'timeConflict')).toBe(false);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('選ぶとほかの作業と重ならずに置けない時、重ねて置かず、時刻の無い作業と手配の理由で示す（知らせは止めない）', async () => {
  const h = await narrowMonday(true);
  await h.run('b', choose('opt-gakudo', 'backup'));
  const { events } = await h.state();
  const previews = previewChoices(events, { memberId: 'a', now: h.now }, first);
  const leave = previews?.find((p) => p.optionKey === keys.option(first, 'opt-leave-a'));
  const helper = previews?.find((p) => p.optionKey === keys.option(first, 'opt-grandma'));
  // 休みの申請は、学童の申込書が使う月曜の仕事の間にしか置けない（両方は置けない）。重ねて置かず、
  // 「選んだら」で重なることを示す（検証器の新しい違反は無い）。
  expect(leave?.conflicts.length).toBeGreaterThan(0);
  expect(leave?.issues).toEqual([]);
  // 祖母に頼むのは、家の間に置ける。
  expect(helper?.conflicts).toEqual([]);
  expect(helper?.issues).toEqual([]);
  // 選んでも、重なる時刻を計画に置かない。手配に timeConflict を付け、家族の知らせは止めない。
  await h.run('b', choose('opt-leave-a', 'primary'));
  const result = await h.state();
  const reason = result.plan.arrangements
    .find((a) => a.key === first)
    ?.reasons.find((r) => r.code === 'timeConflict');
  expect(reason?.refs).toEqual(leave?.conflicts);
  const untimed = result.plan.tasks.filter(
    (t) => !t.extra && reason?.refs.includes(t.basis.optionKey ?? ''),
  );
  expect(untimed.length).toBeGreaterThan(0);
  expect(untimed.every((t) => t.start === undefined && t.end === undefined)).toBe(true);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
  expect(sendGate({ ...result, intents: [], batchEnds: result.events.map((e) => e.seq) }).all).toBe(
    false,
  );
});

it('済ませた手順の後に待つ時間があれば、残りの手順を、済んだと記録した時から待った後より前に置かない', async () => {
  const events = demoEvents('arrived');
  const set = events.find((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家庭が無い');
  const household = structuredClone(set.household);
  const monday = household.routines.find((r) => r.memberId === 'a' && r.weekday === 1);
  const school = household.careOptions.find((o) => o.id === 'opt-gakudo');
  if (!monday || !school?.steps[0]) throw new Error('決まりが無い');
  // 月曜は、15:30 からの仕事の後、17:10〜17:25 の仕事と 17:25〜17:35 のお迎えがある。書いてから出すまで 60 分待つ。
  monday.segments = [
    { kind: 'work', start: '15:30', end: '16:00', placeId: 'home', viaStationIds: [] },
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
  school.steps[0].waitAfterMin = 60;
  const valid = Household.parse(household);
  expect(validateHousehold(valid)).toEqual([]);
  const before = '2026-11-30T15:00+09:00';
  const doneAt = '2026-11-30T17:00+09:00';
  const store = memoryStore(new Map([['demo', events]]));
  await store.withHousehold('demo', (log) =>
    log.append([{ type: 'householdSet', household: valid }], 'b', before),
  );
  let op = 0;
  const run = async (memberId: string, now: string, command: Command) =>
    expect(
      (
        await runCommand(
          store,
          'demo',
          { memberId, operationId: `wait-${++op}`, now, demo: true },
          command,
        )
      ).status,
    ).toBe('ok');
  await run('b', before, { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  const option = gakudo(first);
  await run('b', before, {
    type: 'chooseOption',
    arrangementKey: first,
    optionKey: option,
    role: 'primary',
    assigneeId: 'a',
  });
  const state = (now: string) =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      return { events: all, household: valid, plan: computePlan(all, now) };
    });
  const write = (await state(before)).plan.tasks.find((t) => t.key === keys.task(option, 'write'));
  if (!write) throw new Error('作業が無い');
  await run('a', doneAt, {
    type: 'commitment',
    taskKey: write.key,
    action: 'done',
    seen: { titleKey: write.titleKey, titleParams: write.titleParams },
  });
  const result = await state(doneAt);
  const submit = result.plan.tasks.find((t) => t.key === keys.task(option, 'submit'));
  // 17:00 に済んだと記録した。60 分待つので、18:00 より前の時刻を確かな時刻として置かない（置けなければ時刻なし）。
  expect(
    submit?.start === undefined || Date.parse(submit.start) >= Date.parse('2026-11-30T18:00+09:00'),
  ).toBe(true);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

/** 演示の家族（12/7 の学童を a が持つ）。待ち時間を変えられる。 */
async function gakudoForA(waitAfterMin: number) {
  const events = demoEvents('arrived');
  const set = events.find((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家庭が無い');
  const household = structuredClone(set.household);
  const school = household.careOptions.find((o) => o.id === 'opt-gakudo');
  if (!school?.steps[0]) throw new Error('手順が無い');
  school.steps[0].waitAfterMin = waitAfterMin;
  const valid = Household.parse(household);
  const before = '2026-11-30T15:00+09:00';
  const store = memoryStore(new Map([['demo', events]]));
  await store.withHousehold('demo', (log) =>
    log.append([{ type: 'householdSet', household: valid }], 'b', before),
  );
  let op = 0;
  const run = (memberId: string, now: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `past-${++op}`, now, demo: true }, command);
  const option = gakudo(first);
  expect(
    (await run('b', before, { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' })).status,
  ).toBe('ok');
  expect(
    (
      await run('b', before, {
        type: 'chooseOption',
        arrangementKey: first,
        optionKey: option,
        role: 'primary',
        assigneeId: 'a',
      })
    ).status,
  ).toBe('ok');
  const state = (now: string) =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      // 検証器には、計画と同じ今の決まり（最後に替えた物）を渡す。
      const last = all.findLast((e) => e.type === 'householdSet');
      const household = last?.type === 'householdSet' ? last.household : valid;
      return { events: all, household, plan: computePlan(all, now) };
    });
  const write = (await state(before)).plan.tasks.find((t) => t.key === keys.task(option, 'write'));
  if (!write) throw new Error('作業が無い');
  const done = (now: string) =>
    run('a', now, {
      type: 'commitment',
      taskKey: write.key,
      action: 'done',
      seen: { titleKey: write.titleKey, titleParams: write.titleParams },
    });
  // 家族の決まりを替える（手順の長さ等。画面はまだ無いので、事象で替える）。
  const reset = (at: string, change: (h: typeof valid) => void) => {
    const next = structuredClone(valid);
    change(next);
    return store.withHousehold('demo', (log) =>
      log.append([{ type: 'householdSet', household: Household.parse(next) }], 'b', at),
    );
  };
  return { run, state, done, reset, valid, submit: keys.task(option, 'submit') };
}

it('済ませた後に残る手順に、過ぎた時刻を置かない（済ませたのが遅かった時）', async () => {
  const h = await gakudoForA(0);
  // 17:00 に見ていた提案（出す時刻は、もう過ぎる）。
  const earlier = (await h.state('2026-11-30T17:00+09:00')).plan.tasks.find(
    (t) => t.key === h.submit,
  );
  const shown = earlier && proposalSnapshot(earlier);
  if (!shown) throw new Error('控えが無い');
  const now = '2026-11-30T18:15+09:00';
  expect(Date.parse(shown.start)).toBeLessThan(Date.parse(now));
  expect((await h.done(now)).status).toBe('ok');
  const result = await h.state(now);
  const submit = result.plan.tasks.find((t) => t.key === h.submit);
  expect(submit?.start === undefined || Date.parse(submit.start) >= Date.parse(now)).toBe(true);
  // 過ぎた時刻の控えでは引き受けられない（今の提案と違う）。
  expect((await h.run('a', now, { type: 'accept', taskKey: h.submit, shown })).status).not.toBe(
    'ok',
  );
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('待った後に置いた手順も、時が進んで過ぎたら、その時刻のまま出さない', async () => {
  const h = await gakudoForA(60);
  expect((await h.done('2026-11-30T17:00+09:00')).status).toBe('ok');
  const placed = (await h.state('2026-11-30T17:00+09:00')).plan.tasks.find(
    (t) => t.key === h.submit,
  );
  expect(placed?.start).toBe('2026-11-30T18:00+09:00');
  const now = '2026-11-30T18:15+09:00';
  const result = await h.state(now);
  const submit = result.plan.tasks.find((t) => t.key === h.submit);
  expect(submit?.start === undefined || Date.parse(submit.start) >= Date.parse(now)).toBe(true);
  const shown = placed && proposalSnapshot(placed);
  if (!shown) throw new Error('控えが無い');
  // 過ぎた時刻の控えでは引き受けられない（今の提案と違う）。
  expect((await h.run('a', now, { type: 'accept', taskKey: h.submit, shown })).status).not.toBe(
    'ok',
  );
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
});

it('引き受けた時刻が過ぎたら、過ぎた時刻のまま出さず見せ直しにし、済んだ・送ったは後から記録できる', async () => {
  const h = await gakudoForA(0);
  const before = '2026-11-30T15:00+09:00';
  const option = gakudo(first);
  const plan = (await h.state(before)).plan;
  const accept = async (key: string) => {
    const t = plan.tasks.find((x) => x.key === key);
    const shown = t && proposalSnapshot(t);
    if (!shown) throw new Error('控えが無い');
    expect((await h.run('a', before, { type: 'accept', taskKey: key, shown })).status).toBe('ok');
    return shown;
  };
  const write = await accept(keys.task(option, 'write'));
  const submit = await accept(h.submit);
  const notPast = (t: Task | undefined, now: string) =>
    t?.start === undefined || Date.parse(t.start) >= Date.parse(now);
  // 書く時刻の後（まだ済んだと記録していない）：過ぎた時刻のままにせず、見せ直しにする。「きょう」の札で、
  // 前の約束のとおりに済ませた事を記録できる（画面の試験で確かめる）。サーバーは、その「済んだ」を受ける。
  const lateAt = '2026-11-30T17:31+09:00';
  const late = (await h.state(lateAt)).plan;
  const writing = late.tasks.find((t) => t.key === keys.task(option, 'write'));
  expect(writing).toMatchObject({ commitment: 'accepted', reconfirm: true });
  expect(notPast(writing, lateAt)).toBe(true);
  expect(Date.parse(write.start)).toBeLessThan(Date.parse(lateAt));
  expect(
    todayCards(late, 'a').main.some(
      (c) => c.kind === 'proposal' && c.task.key === keys.task(option, 'write'),
    ),
  ).toBe(true);
  expect((await h.done(lateAt)).status).toBe('ok');
  // 出す時刻の後：出す作業も過ぎた時刻のままにしない。送った（出した）と後から記録できる。
  const later = '2026-11-30T18:15+09:00';
  const after = (await h.state(later)).plan;
  const submitting = after.tasks.find((t) => t.key === h.submit);
  expect(submitting?.commitment).toBe('accepted');
  expect(notPast(submitting, later)).toBe(true);
  expect(Date.parse(submit.start)).toBeLessThan(Date.parse(later));
  const arrangement = after.arrangements.find((a) => a.key === first);
  if (!arrangement) throw new Error('手配が無い');
  expect(
    (
      await h.run('a', later, {
        type: 'recordSent',
        taskKey: h.submit,
        requestId: 'r-late',
        window: { start: arrangement.start, end: arrangement.end },
      })
    ).status,
  ).toBe('ok');
});

it('引き受けた頼み事（祖母へ）の時刻が過ぎても、過ぎた時刻のまま出さず、送ったは記録できる', async () => {
  const h = await gakudoForA(0);
  const before = '2026-11-30T15:00+09:00';
  const grandma = keys.option(first, 'opt-grandma');
  const ask = keys.task(grandma, 'ask');
  expect(
    (
      await h.run('b', before, {
        type: 'chooseOption',
        arrangementKey: first,
        optionKey: grandma,
        role: 'primary',
        assigneeId: 'a',
      })
    ).status,
  ).toBe('ok');
  const proposed = (await h.state(before)).plan.tasks.find((t) => t.key === ask);
  const shown = proposed && proposalSnapshot(proposed);
  if (!shown) throw new Error('控えが無い');
  expect((await h.run('a', before, { type: 'accept', taskKey: ask, shown })).status).toBe('ok');
  const later = new Date(Date.parse(shown.start) + 60_000);
  const at = `${later.toISOString().slice(0, 16)}+00:00`;
  const plan = (await h.state(at)).plan;
  const asking = plan.tasks.find((t) => t.key === ask);
  expect(asking).toMatchObject({ commitment: 'accepted', reconfirm: true });
  expect(asking?.start === undefined || Date.parse(asking.start) >= Date.parse(at)).toBe(true);
  // 「きょう」の札から頼む文の画面へ行き、送ったと記録できる（見せた頼む時間を付ける）。
  expect(todayCards(plan, 'a').main.some((c) => c.kind === 'proposal' && c.task.key === ask)).toBe(
    true,
  );
  const arrangement = plan.arrangements.find((a) => a.key === first);
  if (!arrangement) throw new Error('手配が無い');
  expect(
    (
      await h.run('a', at, {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-late-ask',
        window: { start: arrangement.start, end: arrangement.end },
      })
    ).status,
  ).toBe('ok');
});

it('引き受けた後に手順の長さが替わったら、過ぎた時刻のまま残さず、見せ直す（知らせは止めない）', async () => {
  const h = await gakudoForA(0);
  const before = '2026-11-30T15:00+09:00';
  const key = keys.task(gakudo(first), 'write');
  const proposed = (await h.state(before)).plan.tasks.find((t) => t.key === key);
  const shown = proposed && proposalSnapshot(proposed);
  if (!shown) throw new Error('控えが無い');
  expect((await h.run('a', before, { type: 'accept', taskKey: key, shown })).status).toBe('ok');
  await h.reset('2026-11-30T16:00+09:00', (household) => {
    const write = household.careOptions.find((o) => o.id === 'opt-gakudo')?.steps[0];
    if (write) write.durationMin += 5;
  });
  const now = '2026-11-30T17:31+09:00';
  const result = await h.state(now);
  const task = result.plan.tasks.find((t) => t.key === key);
  expect(task?.start).not.toBe(shown.start);
  expect(task?.reconfirm).toBe(true);
  expect(verifyPlan(result).issues.filter((i) => i.kind === 'violation')).toEqual([]);
  expect(sendGate({ ...result, intents: [], batchEnds: result.events.map((e) => e.seq) }).all).toBe(
    false,
  );
});
