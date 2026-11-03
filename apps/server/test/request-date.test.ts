// 日が直された後の依頼（架空のデモ・正式な命令）：前の日の返事で今の日を決めない。今の日の分を頼み直せ、
// その「はい」で本命が決まると、予備をたたみ、前の日の依頼（返事待ち・「はい」）には取り消しを伝える作業を
// 出す。送った記録は、見せた頼む時間と今の控えが同じ時だけ受ける（日が直された後の古い画面から、新しい日を
// 送ったことにしない）。同じ作業の同じ日の分は一通だけ。
import { type Command, isActiveTask } from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../src/demo';
import { type EventBody, memoryStore } from '../src/store';

const care = 'arr:childCare:n1:i6:c';
const primary = keys.option(care, 'opt-grandma');
const backup = keys.option(care, 'opt-gakudo');
const ask = keys.task(primary, 'ask');
const write = keys.task(backup, 'write');
const NEW_DAY = { date: '2026-12-14', writtenWeekday: 1 };

/** デモの段から始める家庭（命令を通し、計画と頼む時間を読む）。 */
function household(stage: DemoStageId) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const store = memoryStore(new Map([['demo', demoEvents(stage)]]));
  let seq = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `date-${++seq}`, now, demo: true }, command);
  const state = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      return { events, plan: computePlan(events, now) };
    });
  const window = async () => {
    const arrangement = (await state()).plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('子の居場所の手配が無い');
    return { start: arrangement.start, end: arrangement.end };
  };
  const violations = async () => {
    const { events, plan } = await state();
    const set = events.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家族が無い');
    return verifyPlan({ household: set.household, events, plan })
      .issues.filter((i) => i.kind === 'violation')
      .map((i) => i.code);
  };
  // 画面に入口の無い変化（家族の登録の直し）は、事象を直接書く。
  const append = (bodies: readonly EventBody[], actorId: string) =>
    store.withHousehold('demo', (log) => log.append(bodies, actorId, now));
  return { run, state, window, violations, append };
}

describe('日が直された後の依頼', () => {
  for (const reply of ['yes', 'no', 'waiting'] as const) {
    it(`前の日の返事（${reply}）では今の日を決めず、今の日の分を頼み直して、その「はい」で本命に決める`, async () => {
      const h = household('chase');
      expect(
        await h.run('b', {
          type: 'chooseOption',
          arrangementKey: care,
          optionKey: backup,
          role: 'backup',
          assigneeId: 'a',
        }),
      ).toMatchObject({ status: 'ok' });
      if (reply !== 'waiting') {
        expect(
          await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply }),
        ).toMatchObject({ status: 'ok' });
      }
      expect(
        await h.run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: NEW_DAY }),
      ).toMatchObject({ status: 'ok' });

      // 前の日の返事では、今の日を決めない：予備は進めたまま、頼む作業は今の日の分として開き直す。
      const corrected = (await h.state()).plan;
      const window = await h.window();
      expect(window.start.startsWith('2026-12-14')).toBe(true);
      expect(corrected.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
        live: true,
        needsCheck: true,
      });
      const backupWrite = corrected.tasks.find((t) => t.key === write);
      expect(backupWrite && isActiveTask(corrected, backupWrite)).toBe(true);
      expect(corrected.tasks.find((t) => t.key === ask)?.commitment).not.toBe('done');

      expect(
        await h.run('b', { type: 'recordSent', taskKey: ask, requestId: 'r-new', window }),
      ).toMatchObject({ status: 'ok' });
      expect(
        await h.run('b', { type: 'recordReply', requestId: 'r-new', reply: 'yes' }),
      ).toMatchObject({ status: 'ok' });

      const { plan } = await h.state();
      expect(plan.arrangements.find((a) => a.key === care)).toMatchObject({
        inUseOptionKey: primary,
        status: 'decidable',
      });
      expect(plan.requests.find((r) => r.requestId === 'r-new')).toMatchObject({
        state: 'confirmed',
        live: true,
        window,
      });
      const folded = plan.tasks.find((t) => t.key === write);
      expect(folded && isActiveTask(plan, folded)).toBe(false);
      // 前の日の依頼は要らない。返事待ち・「はい」だった物は、取り消しを伝える（断られた物は伝えない）。
      expect(plan.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(false);
      expect(plan.tasks.some((t) => t.cancels === 'r-grandma' && t.live)).toBe(reply !== 'no');
      expect(await h.violations()).toEqual([]);
    });
  }

  it('日が直される前の画面から「送った」を押しても、新しい日を送ったことにしない', async () => {
    const h = household('arrived');
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: primary,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const shown = await h.window();
    expect(shown.start.startsWith('2026-12-07')).toBe(true);
    expect(
      await h.run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: NEW_DAY }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', { type: 'recordSent', taskKey: ask, requestId: 'r-old', window: shown }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect((await h.state()).plan.requests.some((r) => r.requestId === 'r-old')).toBe(false);
    const window = await h.window();
    expect(
      await h.run('b', { type: 'recordSent', taskKey: ask, requestId: 'r-new', window }),
    ).toMatchObject({ status: 'ok' });
    expect((await h.state()).plan.requests.find((r) => r.requestId === 'r-new')?.window).toEqual(
      window,
    );
  });

  it('同じ作業の同じ日の分は二度送らない。頼む時間を付けない記録は受けない', async () => {
    const h = household('chase');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-again',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'conflict', reason: 'alreadySent' });
    expect(
      await h.run('b', { type: 'recordSent', taskKey: ask, requestId: 'r-bare' }),
    ).toMatchObject({ status: 'invalid', reason: 'windowRequired' });
  });
});

describe('確かめの要る本命と、取り消した依頼', () => {
  /** 予備（学童）を送った後、本命（祖母）が「はい」と答えた家庭。 */
  async function confirmedWithBackup() {
    const h = household('backup');
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    // 疑いの無い「はい」なら、予備はたたむ（送った予備には取り消しを伝える）。
    const { plan } = await h.state();
    expect(plan.requests.find((r) => r.requestId === 'r-gakudo')?.live).toBe(false);
    expect(plan.tasks.some((t) => t.cancels === 'r-gakudo' && t.live)).toBe(true);
    return h;
  }

  /** 予備がまだ要るか：依頼が生きていて、取り消しを伝える作業が無い。 */
  async function backupKept(h: Awaited<ReturnType<typeof confirmedWithBackup>>) {
    const { plan } = await h.state();
    return {
      primary: plan.requests.find((r) => r.requestId === 'r-grandma'),
      backupLive: plan.requests.find((r) => r.requestId === 'r-gakudo')?.live,
      cancelBackup: plan.tasks.some((t) => t.cancels === 'r-gakudo' && t.live),
    };
  }

  it('同じ日の頼む時間が長くなったら、前の時間への「はい」で予備をたたまない', async () => {
    const h = await confirmedWithBackup();
    // 大人 a の月曜の帰りが遅くなり、子を見てもらう時間が 18:15 から延びる（家族の登録を直す）。
    const { events } = await h.state();
    const set = events.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家族が無い');
    const changed = structuredClone(set.household);
    const monday = changed.routines.find((r) => r.memberId === 'a' && r.weekday === 1);
    const home = monday?.segments.find((s) => s.kind === 'home' && s.start === '18:15');
    const commute = monday?.segments.find((s) => s.kind === 'commute' && s.end === '18:15');
    if (!home || !commute) throw new Error('月曜の帰りが無い');
    home.start = '19:30';
    commute.end = '19:30';
    await h.append([{ type: 'householdSet', household: changed }], 'a');
    expect((await h.state()).plan.arrangements.find((a) => a.key === care)?.end).toBe(
      '2026-12-07T19:10+09:00',
    );
    const kept = await backupKept(h);
    expect(kept.primary).toMatchObject({ state: 'confirmed', live: true, needsCheck: true });
    expect(kept.backupLive).toBe(true);
    expect(kept.cancelBackup).toBe(false);
  });

  it('取り消しを伝えた日が戻ったら、その日を頼み直せる。頼み直すまで、新しい日の依頼は取り消させない', async () => {
    const h = household('chase');
    expect(
      await h.run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: NEW_DAY }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-new',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('a', {
        type: 'correctItem',
        itemId: 'n1:i6',
        interpretation: { date: '2026-12-07', writtenWeekday: 1 },
      }),
    ).toMatchObject({ status: 'ok' });
    let { plan } = await h.state();
    // 取り消した前の依頼は、今の日の分として数えない。新しい日（12/14）の依頼は、頼み直すまで確かめる物。
    expect(plan.requests.find((r) => r.requestId === 'r-new')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(plan.tasks.some((t) => t.cancels === 'r-new' && t.live)).toBe(false);
    const askTask = plan.tasks.find((t) => t.key === ask);
    expect(askTask?.commitment).not.toBe('done');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-again',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'ok' });
    ({ plan } = await h.state());
    expect(plan.requests.find((r) => r.requestId === 'r-again')).toMatchObject({
      live: true,
      state: 'awaitingReply',
    });
    // 頼み直した後は、12/14 の依頼は要らない（取り消しを伝える）。
    expect(plan.requests.find((r) => r.requestId === 'r-new')?.live).toBe(false);
    expect(plan.tasks.some((t) => t.cancels === 'r-new' && t.live)).toBe(true);
    expect(await h.violations()).toEqual([]);
  });

  it('案を選び直して取り消した依頼は、また選んだら同じ日でも頼み直せる', async () => {
    const h = household('chase');
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: backup,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    expect((await h.state()).plan.tasks.some((t) => t.cancels === 'r-grandma' && t.live)).toBe(
      true,
    );
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.violations()).toEqual([]);
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: primary,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.violations()).toEqual([]);
    const { plan } = await h.state();
    expect(plan.tasks.find((t) => t.key === ask)?.commitment).not.toBe('done');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-again',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.violations()).toEqual([]);
  });

  it('断られた後、新しい日の依頼を取り消して案を選び直したら、前の日の断りで使えないとする', async () => {
    const h = household('chase');
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'no' }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: NEW_DAY }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-new',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'ok' });
    for (const [optionKey, assigneeId] of [
      [backup, 'a'],
      [primary, 'b'],
    ] as const) {
      expect(
        await h.run('b', {
          type: 'chooseOption',
          arrangementKey: care,
          optionKey,
          role: 'primary',
          assigneeId,
        }),
      ).toMatchObject({ status: 'ok' });
      if (optionKey === backup) {
        expect(
          await h.run('b', { type: 'recordCancellationSent', requestId: 'r-new' }),
        ).toMatchObject({ status: 'ok' });
      }
    }
    // 今の日（12/14）の依頼は取り消したので、返事が無い。前の日の断りを見て、祖母の案は使えないとする
    // （頼み直すまで、勝手に使える側へ倒さない）。
    const arrangement = (await h.state()).plan.arrangements.find((a) => a.key === care);
    expect(arrangement?.chosenOptionKey).toBe(primary);
    expect(arrangement?.inUseOptionKey).toBeUndefined();
    expect(arrangement?.reasons).toContainEqual({ code: 'turnedDown', refs: ['r-grandma'] });
    expect(arrangement?.recommendedOptionKey).toBe(backup);
    expect(await h.violations()).toEqual([]);
  });
});
