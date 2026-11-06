// 一言の「すること」を一度に足す（addThing）：家族の一言・いつまでに・だれがするだけで、締切の形の「すること」、
// 自分たちで済ませるやり方（家に無ければ足す）、その本命、担当の提案までを、一つの命令で書く。見る口と同じ計算で
// 見た物だけを書き、書く事象はほかの命令と同じ種類。見本の家族（架空）で、画面と同じ命令の道を通す。
import { type Command, type PlanResult, SELF_WAY_ID } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = DEMO_STAGES.find((s) => s.id === 'arrived')?.now ?? '';

function family(demo = true) {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  let op = 0;
  const state = () =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      const set = all.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家庭が無い');
      return { events: all, home: set.household, plan: computePlan(all, NOW) };
    });
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `thing-${++op}`, now: NOW, demo }, command);
  type Thing = Omit<Extract<Command, { type: 'addThing' }>, 'type' | 'seen'>;
  /** 見てから、見た物で足す（画面と同じ）。 */
  const look = async (memberId: string, thing: Thing) => {
    const preview = previewChange(
      (await state()).events,
      { memberId, now: NOW },
      {
        type: 'addThing',
        ...thing,
      },
    );
    if ('status' in preview) throw new Error(`preview: ${preview.status}/${preview.reason}`);
    return preview;
  };
  const add = async (memberId: string, thing: Thing) => {
    const preview = await look(memberId, thing);
    return run(memberId, {
      type: 'addThing',
      ...thing,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
  };
  return { state, run, look, add };
}

const violations = (args: Parameters<typeof verifyPlan>[0]) =>
  verifyPlan(args)
    .issues.filter((i) => i.kind === 'violation')
    .map((i) => i.code);

const FORM = {
  text: '学童の書類を出す',
  date: '2026-11-27',
  assigneeId: 'a',
  wayName: '自分たちで済ませる',
  stepName: '済ませる',
};

/** 一言の「すること」の手配と、その本命の作業（自分たちで済ませるやり方の物）。 */
function thingOf(plan: PlanResult, what: string) {
  const requirement = plan.requirements.find((r) => r.live && r.what === what);
  const arrangement = plan.arrangements.find(
    (a) => a.live && a.requirementKey === requirement?.key,
  );
  const option = arrangement?.options.find((o) => o.key === arrangement.chosenOptionKey);
  const tasks = plan.tasks.filter((t) => option?.taskKeys.includes(t.key));
  return { requirement, arrangement, option, tasks };
}

describe('一言の「すること」を足す', () => {
  it('一つの命令で、締切の「すること」・自分たちで済ませるやり方・本命・担当の提案までを書く', async () => {
    const { state, add } = family();
    const before = await state();
    expect(before.home.ways.some((w) => w.id === SELF_WAY_ID)).toBe(false);
    expect(await add('b', FORM)).toMatchObject({ status: 'ok' });
    const after = await state();
    // やり方は家に一つ足し、家族が直せる・やめられる普通のやり方として持つ。
    const way = after.home.ways.find((w) => w.id === SELF_WAY_ID);
    expect(way?.name).toBe('自分たちで済ませる');
    expect(way?.steps.map((s) => s.name)).toEqual(['済ませる']);
    const { requirement, arrangement, option, tasks } = thingOf(after.plan, '学童の書類を出す');
    // 日だけの締切は、その日のうち（時刻を作らない。計画ではその日の終わり）。
    expect(requirement?.kind).toBe('need');
    expect(requirement?.date).toBe('2026-11-27');
    expect(requirement?.by).toBe('2026-11-27T23:59+09:00');
    expect(option?.templateId).toBe(SELF_WAY_ID);
    expect(arrangement?.chosenOptionKey).toBe(option?.key);
    // 選んだ大人（健太）に提案する。足した人（美咲）が引き受けたことにはしない。
    expect(tasks.map((t) => [t.assigneeId, t.commitment])).toEqual([['a', 'proposed']]);
    // 書く事象は、ほかの命令と同じ種類だけ。
    const added = after.events.slice(before.events.length).map((e) => e.type);
    expect(added).toEqual([
      'householdSet',
      'noticeReceived',
      'itemsStated',
      'needWaysSet',
      'optionChosen',
      'assignmentProposed',
    ]);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
  });

  it('二つ目は同じやり方を使い、時刻を入れればその時刻までにする。自分を選んでも、引き受けは「きょう」で', async () => {
    const { state, add } = family();
    expect(await add('b', FORM)).toMatchObject({ status: 'ok' });
    const ways = (await state()).home.ways.length;
    expect(
      await add('b', {
        ...FORM,
        text: '町内会の倉庫の鍵を返す',
        date: '2026-11-28',
        byTime: '10:00',
        assigneeId: 'b',
        // 画面の言葉が替わっても、家にあるやり方を使う（名前は足した時のまま）。
        wayName: 'Do it ourselves',
        stepName: 'Get it done',
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await state();
    expect(after.home.ways.length).toBe(ways);
    expect(after.home.ways.find((w) => w.id === SELF_WAY_ID)?.name).toBe('自分たちで済ませる');
    const { requirement, tasks } = thingOf(after.plan, '町内会の倉庫の鍵を返す');
    expect(requirement?.by).toBe('2026-11-28T10:00+09:00');
    expect(tasks.map((t) => [t.assigneeId, t.commitment])).toEqual([['b', 'proposed']]);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
  });

  it('家族の大人でない人・過ぎた日時・やめたやり方は断り、何も書かない', async () => {
    const { state, run, add, look } = family();
    const count = async () => (await state()).events.length;
    const start = await count();
    // 子（陽菜）や頼める人には、作業を頼まない。
    await expect(look('b', { ...FORM, assigneeId: 'c' })).rejects.toThrow(/assigneeNotAnAdult/);
    // 今は 11/25 19:31。その日の 19:00 までは、もう過ぎている。日だけなら、その日のうちなので足せる。
    await expect(look('b', { ...FORM, date: '2026-11-25', byTime: '19:00' })).rejects.toThrow(
      /thingPast/,
    );
    await expect(look('b', { ...FORM, date: '2026-11-24' })).rejects.toThrow(/thingPast/);
    expect(await count()).toBe(start);
    expect(await add('b', { ...FORM, date: '2026-11-25' })).toMatchObject({ status: 'ok' });
    // やり方をやめた家では、新しくは足さない（「うちのこと」で戻すか、詳しい表で別のやり方を選ぶ）。
    const home = structuredClone((await state()).home);
    home.stoppedWayIds = [...(home.stoppedWayIds ?? []), SELF_WAY_ID];
    const preview = previewChange(
      (await state()).events,
      { memberId: 'b', now: NOW },
      {
        type: 'updateHousehold',
        household: home,
      },
    );
    if ('status' in preview) throw new Error(`preview: ${preview.status}`);
    expect(
      await run('b', {
        type: 'updateHousehold',
        household: home,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    await expect(look('b', { ...FORM, text: '別の書類を出す' })).rejects.toThrow(/wayInactive/);
  });

  it('自分たちで済ませるやり方が、頼む・決まった人などのある形に直されていれば、黙って当てずに断る', async () => {
    const { state, run, add, look } = family();
    expect(await add('b', FORM)).toMatchObject({ status: 'ok' });
    /** 「うちのこと」で、そのやり方の手順を直す（見てから保存する。画面と同じ）。 */
    const editWay = async (change: (step: Record<string, unknown>) => void) => {
      const home = structuredClone((await state()).home);
      const step = home.ways.find((w) => w.id === SELF_WAY_ID)?.steps[0];
      if (!step) throw new Error('やり方が無い');
      change(step as unknown as Record<string, unknown>);
      const preview = previewChange(
        (await state()).events,
        { memberId: 'b', now: NOW },
        {
          type: 'updateHousehold',
          household: home,
        },
      );
      if ('status' in preview) throw new Error(`preview: ${preview.status}/${preview.reason}`);
      expect(
        await run('b', {
          type: 'updateHousehold',
          household: home,
          seen: { throughSeq: preview.throughSeq, changes: preview.seen },
        }),
      ).toMatchObject({ status: 'ok' });
    };
    // おばあちゃんに頼む手順に直すと、一言の「すること」には使わない（頼みを引き継がない）。
    await editWay((step) => {
      step.external = { to: 'g', kind: 'reply' };
    });
    const count = (await state()).events.length;
    await expect(look('b', { ...FORM, text: '別の書類を出す' })).rejects.toThrow(/selfWayChanged/);
    expect((await state()).events.length).toBe(count);
    // 頼みを外して、決まった人（健太）にしても同じ（選んだ人に作業を頼めない）。
    await editWay((step) => {
      delete step.external;
      step.assigneeId = 'a';
    });
    await expect(look('b', { ...FORM, text: '別の書類を出す' })).rejects.toThrow(/selfWayChanged/);
    // 決まった人を外し、名前とかかる時間だけを直した形なら、また使う。
    await editWay((step) => {
      delete step.assigneeId;
      step.name = '片付ける';
      step.durationMin = 30;
    });
    expect(await add('b', { ...FORM, text: '別の書類を出す' })).toMatchObject({ status: 'ok' });
  });

  it('見た後に計画が変われば書かず、見せ直す。見ずには書かない', async () => {
    const { run, look, add } = family();
    const seen = await look('b', FORM);
    // 見た後に、もう一人が別の「すること」を足す。
    expect(await add('a', { ...FORM, text: '町内会の倉庫の鍵を返す' })).toMatchObject({
      status: 'ok',
    });
    expect(
      await run('b', {
        type: 'addThing',
        ...FORM,
        seen: { throughSeq: seen.throughSeq, changes: seen.seen },
      }),
    ).toMatchObject({ status: 'conflict' });
    expect(await run('b', { type: 'addThing', ...FORM })).toMatchObject({
      status: 'invalid',
      reason: 'seenRequired',
    });
  });

  it('家族の家庭（デモでない記録）でも、同じに足せる', async () => {
    const { state, add } = family(false);
    expect(await add('b', FORM)).toMatchObject({ status: 'ok' });
    const after = await state();
    expect(thingOf(after.plan, '学童の書類を出す').tasks).toHaveLength(1);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
  });
});
