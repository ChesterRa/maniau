// 通用の「すること」の頼み事も、返事が記録されないまま窓が近づいたら追う（子の居場所と同じ決まり）：窓の始まりの
// 26 時間前から、送った本人の今やることに上げ、知らせの候補にする。もう一人の大人には上げない。返事を記録すれば
// 消える。受け持ちが全部要る時も要らない時も同じ。締切の形の「すること」は、いつを返事の期限とするかを決めて
// いないので上げない。命令の層で、言う → やり方を選ぶ → 選ぶ → 送ったと記録、の順に進め、知らせは門（独立した
// 検証器）を通す（家の情報は試験の材料だけ）。
import {
  type Household,
  type NeedInterpretation,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  taskContent,
  todayCards,
  type Way,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const sat = (time: string) => `2026-11-28T${time}+09:00`;
/** 窓（11/28 13:00–15:00）の始まりの 26 時間前。 */
const THRESHOLD = '2026-11-27T11:00+09:00';
const BEFORE = '2026-11-27T10:59+09:00';
const cost = { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 };

/** 祖母に頼むやり方（cover：窓を受け持つ手順にするか）。 */
const askGrandma = (cover: boolean): Way => ({
  id: 'way-ask-g',
  name: '祖母に来てもらう',
  steps: [
    {
      id: 'ask',
      name: '来てもらうよう頼む',
      durationMin: 5,
      segments: ['home'],
      waitAfterMin: 0,
      external: { to: 'g', kind: 'reply' },
      ...(cover ? { cover: true } : {}),
    },
  ],
  cost: { ...cost, helperRequests: 1 },
});

async function setup(
  way: Way,
  interpretation: NeedInterpretation,
  backup?: Way,
  others: Way[] = [],
) {
  const events0 = demoEvents('arrived').map((e) => {
    if (e.type !== 'householdSet') return e;
    const household = structuredClone(e.household);
    household.ways.push(way, ...(backup ? [backup] : []), ...others);
    return { ...e, household };
  });
  const store = memoryStore(new Map([['demo', events0]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3], memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `no-reply-${++sequence}`, demo: true },
      command,
    );
  const plan = async (at = NOW) => computePlan(await events(), at);
  const previewed = async (command: Parameters<typeof previewChange>[2]) => {
    const shown = await previewChange(await events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = await plan();
    return run({ ...command, seen: { throughSeq, changes: shown.seen } } as never);
  };
  expect(
    await previewed({ type: 'stateNeed', text: interpretation.what, interpretation }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('言明の「すること」が無い');
  expect(
    await previewed({
      type: 'setNeedWays',
      itemId,
      wayIds: [way.id, ...(backup ? [backup.id] : []), ...others.map((w) => w.id)],
    }),
  ).toMatchObject({ status: 'ok' });
  const p = await plan();
  const arrangement = p.arrangements.find((a) => a.kind === 'need' && a.live);
  const option = arrangement?.options.find((o) => o.templateId === way.id);
  if (!arrangement || !option) throw new Error('案が無い');
  expect(
    await run({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: 'b',
    }),
  ).toMatchObject({ status: 'ok' });
  const task = (await plan()).tasks.find(
    (t) => t.live && t.basis.optionKey === option.key && t.external?.to === 'g',
  );
  if (!task) throw new Error('頼む作業が無い');
  if (backup) {
    // 予備を押さえ、その手順を本人が引き受けて済ませる（子の居場所なら「確保できた予備」に当たる形）。
    const backupOption = arrangement.options.find((o) => o.templateId === backup.id);
    if (!backupOption) throw new Error('予備の案が無い');
    expect(
      await run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: backupOption.key,
        role: 'backup',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const step = (await plan()).tasks.find((t) => t.live && t.basis.optionKey === backupOption.key);
    const shown = step && proposalSnapshot(step);
    if (!step || !shown) throw new Error('予備の手順が無い');
    expect(await run({ type: 'accept', taskKey: step.key, shown })).toMatchObject({
      status: 'ok',
    });
    expect(
      await run({
        type: 'commitment',
        taskKey: step.key,
        action: 'done',
        seen: taskContent(step),
      }),
    ).toMatchObject({ status: 'ok' });
  }
  /** その時の計画で、二人の札・知らせの候補と、門（独立した検証器）の結果。 */
  const at = async (time: string) => {
    const all = await events();
    const p = computePlan(all, time);
    const household = all.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
    if (!household) throw new Error('家庭が無い');
    expect(
      verifyPlan({ household, plan: p, events: all })
        .issues.filter((i) => i.kind === 'violation')
        .map((i) => i.code),
    ).toEqual([]);
    const intents = notificationIntents(p, household, notificationHistory(all));
    const gate = sendGate({
      household,
      plan: p,
      events: all,
      intents,
      batchEnds: all.map((e) => e.seq),
    });
    const raised = (member: string) =>
      todayCards(p, member).main.flatMap((c) =>
        c.kind === 'noReply' ? [c.request.requestId] : [],
      );
    const waiting = (member: string) =>
      todayCards(p, member).quiet.flatMap((c) =>
        c.kind === 'waiting' ? [c.request.requestId] : [],
      );
    const reminded = (member: string) =>
      intents.filter((i) => i.titleKey === 'notify.noReply' && i.toMemberId === member);
    const backups = (member: string) =>
      todayCards(p, member).main.flatMap((c) => (c.kind === 'backup' ? [c.option.key] : []));
    return {
      plan: p,
      intents,
      gate,
      raised,
      waiting,
      reminded,
      backups,
      arrangementKey: arrangement.key,
    };
  };
  /** 家の情報を直す（見た「この変更で変わること」と同じ時だけ保存する。画面と同じ）。 */
  const editHousehold = async (change: (h: Household) => void) => {
    const all = await events();
    const current = all.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
    if (!current) throw new Error('家庭が無い');
    const next = structuredClone(current);
    change(next);
    return previewed({ type: 'updateHousehold', household: next });
  };
  return { run, task, at, editHousehold };
}

const WINDOW: NeedInterpretation = {
  what: '発表会を見に来てもらう',
  shape: 'window',
  date: '2026-11-28',
  startTime: '13:00',
  endTime: '15:00',
};

describe('通用の「すること」の頼み事の返事を追う', () => {
  for (const cover of [false, true]) {
    it(`窓の 26 時間前から送った本人にだけ上げ、門を通して一度知らせ、返事で消える（受け持ちが${cover ? '要る' : '要らない'}）`, async () => {
      const { run, task, at } = await setup(askGrandma(cover), {
        ...WINDOW,
        holdNeeded: cover,
      });
      expect(
        await run({
          type: 'recordSent',
          taskKey: task.key,
          requestId: 'r-grandma-need',
          window: { start: sat('13:00'), end: sat('15:00') },
        }),
      ).toMatchObject({ status: 'ok' });

      const before = await at(BEFORE);
      expect(before.raised('b')).toEqual([]);
      expect(before.waiting('b')).toContain('r-grandma-need');
      expect(before.reminded('b')).toEqual([]);

      const near = await at(THRESHOLD);
      expect(near.plan.arrangements.find((a) => a.key === near.arrangementKey)?.status).toBe(
        'dependsOnReply',
      );
      expect(near.raised('b')).toEqual(['r-grandma-need']);
      // 上げた頼み事は、下の「返事待ち」に二度並べない。もう一人の大人には上げない。
      expect(near.waiting('b')).not.toContain('r-grandma-need');
      expect(near.raised('a')).toEqual([]);
      const reminder = near.reminded('b');
      expect(reminder).toHaveLength(1);
      expect(reminder[0]).toMatchObject({
        subject: { type: 'request', id: 'r-grandma-need' },
        until: sat('13:00'),
      });
      expect(near.reminded('a')).toEqual([]);
      // 門（独立した検証器）が、この知らせを止めない。
      expect(near.gate.all).toBe(false);
      expect(near.intents.filter((i) => near.gate.blocked.has(i.key))).toEqual([]);

      expect(
        await run({ type: 'recordReply', requestId: 'r-grandma-need', reply: 'yes' }),
      ).toMatchObject({ status: 'ok' });
      const replied = await at(THRESHOLD);
      expect(replied.raised('b')).toEqual([]);
      expect(replied.reminded('b')).toEqual([]);
    });
  }

  it('予備の手順が済んでいても、「すること」の窓では追うのをやめず、門も止めない（予備の確保は子の居場所だけで数える）', async () => {
    const prepare: Way = {
      id: 'way-prepare',
      name: '近所の人の連絡先を確かめておく',
      steps: [
        {
          id: 'check',
          name: '連絡先を確かめる',
          durationMin: 5,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'b',
        },
      ],
      cost,
    };
    const { run, task, at } = await setup(
      askGrandma(false),
      { ...WINDOW, holdNeeded: false },
      prepare,
    );
    expect(
      await run({
        type: 'recordSent',
        taskKey: task.key,
        requestId: 'r-with-backup',
        window: { start: sat('13:00'), end: sat('15:00') },
      }),
    ).toMatchObject({ status: 'ok' });
    const near = await at(THRESHOLD);
    expect(near.raised('b')).toEqual(['r-with-backup']);
    expect(near.reminded('b')).toHaveLength(1);
    expect(near.intents.filter((i) => near.gate.blocked.has(i.key))).toEqual([]);
  });

  it('ほかのやり方を家族がやめた時は、予備の札の代わりに返事を追う札を上げ、門も止めない', async () => {
    // 前の日の 21 時までに申し込むやり方（窓の 26 時間前には、その決め時が 26 時間以内に来る）。
    const book: Way = {
      id: 'way-book',
      name: '一時保育を申し込む',
      steps: [
        {
          id: 'book',
          name: '申し込む',
          durationMin: 10,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'b',
          deadline: { type: 'daysBefore', days: 1, at: '21:00' },
        },
      ],
      cost,
    };
    const { run, task, at, editHousehold } = await setup(
      askGrandma(false),
      { ...WINDOW, holdNeeded: false },
      undefined,
      [book],
    );
    expect(
      await run({
        type: 'recordSent',
        taskKey: task.key,
        requestId: 'r-stopped',
        window: { start: sat('13:00'), end: sat('15:00') },
      }),
    ).toMatchObject({ status: 'ok' });
    // やめる前は、予備を押さえるかの札が同じ返事を追う（返事を追う札は出さない）。
    const before = await at(THRESHOLD);
    expect(before.backups('b')).toHaveLength(1);
    expect(before.raised('b')).toEqual([]);
    expect(await editHousehold((h) => (h.stoppedWayIds = ['way-book']))).toMatchObject({
      status: 'ok',
    });
    const near = await at(THRESHOLD);
    expect(near.backups('b')).toEqual([]);
    expect(near.raised('b')).toEqual(['r-stopped']);
    expect(near.reminded('b')).toHaveLength(1);
    expect(near.intents.filter((i) => near.gate.blocked.has(i.key))).toEqual([]);
  });

  it('締切の形の「すること」の頼み事は、上げない（返事の期限を決めていない）', async () => {
    const { run, task, at } = await setup(askGrandma(false), {
      what: '書類を出してもらう',
      shape: 'by',
      date: '2026-11-28',
      deadline: sat('15:00'),
    });
    expect(await run({ type: 'recordSent', taskKey: task.key, requestId: 'r-by' })).toMatchObject({
      status: 'ok',
    });
    for (const time of [THRESHOLD, sat('14:00')]) {
      const shown = await at(time);
      expect(shown.raised('b')).toEqual([]);
      expect(shown.reminded('b')).toEqual([]);
      expect(shown.waiting('b')).toContain('r-by');
    }
  });
});
