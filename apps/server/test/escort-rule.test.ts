// 子の習い事の送り迎えの決まり（clubEscort）を「うちのこと」で直す。直すと、習い事・クラブの行事の送り・迎えの作業が
// 決まりのとおりに増え・減り、引き受けた作業は本人に確かめてもらう（保存の前に、変わることに出る）。決まりは子だけ。
// 見本の家族（架空）と架空のクラブの連絡で、画面と同じ命令の道（見てから書く）を通し、検証器と知らせの門も照らす。
import {
  type Command,
  type Household,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  todayCards,
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
const CHILD = 'c';

/** 見本の段 arrived に、12/13 の練習試合（クラブの連絡、架空。大人が家にいる日曜の午後）を足す。start は、始める前の家（決まりの形を替える）。 */
async function family(start: (h: Household) => Household = (h) => h) {
  const initial = demoEvents('arrived').map((event) =>
    event.type === 'householdSet' ? { ...event, household: start(event.household) } : event,
  );
  const store = memoryStore(new Map([['demo', initial]]));
  const text = '12月13日（日）13:00から15:00まで、みどり公園で練習試合。';
  await store.withHousehold('demo', (log) => {
    const first = log.events().find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('出典が無い');
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            ...first.source,
            id: 'club-rule',
            sender: 'club',
            title: 'クラブの連絡',
            sentences: [{ id: 'club-rule#1', text }],
          },
        },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'club-rule',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          output: {
            sourceId: 'club-rule',
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'club-rule:i',
                sourceId: 'club-rule',
                sentenceIds: ['club-rule#1'],
                kind: 'event',
                written: text,
                evidence: 'stated',
                effects: [],
                interpretation: {
                  what: '練習試合',
                  date: '2026-12-13',
                  startTime: '13:00',
                  endTime: '15:00',
                  place: 'みどり公園',
                },
              },
            ],
          },
        },
      ],
      'b',
      NOW,
    );
  });
  let op = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `escort-rule-${++op}`, now: NOW, demo: true },
      command,
    );
  const state = (at = NOW) =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      const set = events.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家庭が無い');
      return { events, home: set.household, plan: computePlan(events, at) };
    });
  /** 見てから、見た物で家の情報を書く（画面と同じ）。見た物の変わることも返す。 */
  const save = async (edit: (h: Household) => void) => {
    const current = await state();
    const next = structuredClone(current.home);
    edit(next);
    const preview = previewChange(
      current.events,
      { memberId: 'a', now: NOW },
      { type: 'updateHousehold', household: next },
    );
    if ('status' in preview) return { result: { status: preview.status, reason: preview.reason } };
    const result = await run('a', {
      type: 'updateHousehold',
      household: next,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
    return { result, preview };
  };
  const rule = (to: boolean, from: boolean) =>
    save((h) => {
      const child = h.members.find((m) => m.id === CHILD);
      if (child) child.clubEscort = { to, from };
    });
  return { run, state, save, rule };
}

/** 練習試合の送り（to）・迎え（from）の、生きている作業。 */
const escorts = (plan: ReturnType<typeof computePlan>) => ({
  to: plan.tasks.filter((t) => t.live && t.titleKey === 'task.escortTo'),
  from: plan.tasks.filter((t) => t.live && t.titleKey === 'task.escortFrom'),
});
const violations = (s: {
  home: Household;
  events: unknown;
  plan: ReturnType<typeof computePlan>;
}) =>
  verifyPlan({ household: s.home, events: s.events, plan: s.plan })
    .issues.filter((i) => i.kind === 'violation')
    .map((i) => i.code);
const blocked = (s: {
  home: Household;
  events: Parameters<typeof notificationHistory>[0];
  plan: ReturnType<typeof computePlan>;
}) => {
  const intents = notificationIntents(s.plan, s.home, notificationHistory(s.events));
  const gate = sendGate({
    household: s.home,
    plan: s.plan,
    events: s.events,
    intents,
    batchEnds: s.events.map((e) => e.seq),
  });
  return intents.filter((i) => gate.blocked.has(i.key)).map((i) => i.key);
};

describe('子の習い事の送り迎えの決まりを直す', () => {
  it('決めていない子に決まりを入れると、行事の送り・迎えの作業ができる', async () => {
    const { state, rule } = await family((h) => ({
      ...h,
      members: h.members.map((m) => {
        if (m.id !== CHILD) return m;
        const { clubEscort: _, ...rest } = m;
        return rest;
      }),
    }));
    const before = await state();
    expect(escorts(before.plan)).toEqual({ to: [], from: [] });
    const saved = await rule(true, true);
    expect(saved.result).toMatchObject({ status: 'ok' });
    // 保存の前に、増える作業を見せている。
    expect(saved.preview?.changes.added.length).toBeGreaterThan(0);
    const now = await state();
    expect(escorts(now.plan).to).toHaveLength(1);
    expect(escorts(now.plan).from).toHaveLength(1);
    expect(violations(now)).toEqual([]);
    expect(blocked(now)).toEqual([]);
  });

  it('行きだけを外すと、送りの作業が無くなり、迎えは残る', async () => {
    const { state, rule } = await family();
    const before = escorts((await state()).plan);
    expect(before.to).toHaveLength(1);
    expect(before.from).toHaveLength(1);
    const saved = await rule(false, true);
    expect(saved.result).toMatchObject({ status: 'ok' });
    expect(saved.preview?.changes.removed.length).toBeGreaterThan(0);
    const now = await state();
    expect(escorts(now.plan).to).toEqual([]);
    expect(escorts(now.plan).from.map((t) => t.key)).toEqual(before.from.map((t) => t.key));
    expect(violations(now)).toEqual([]);
  });

  it('引き受けた送りの作業は、決まりを外すと、保存の前に見せ、本人に確かめてもらう（取り消しとは言わない）', async () => {
    const { state, run, rule } = await family();
    const first = escorts((await state()).plan).to[0];
    if (!first) throw new Error('送りの作業が無い');
    // 健太（a）が自分に提案して、引き受ける（画面の「やります」と同じ道）。
    expect(
      await run('a', { type: 'proposeAssignment', taskKey: first.key, assigneeId: 'a' }),
    ).toMatchObject({ status: 'ok' });
    const to = (await state()).plan.tasks.find((t) => t.key === first.key);
    const shown = to && proposalSnapshot(to);
    if (!to || !shown) throw new Error('提案が無い');
    expect(await run('a', { type: 'accept', taskKey: to.key, shown })).toMatchObject({
      status: 'ok',
    });
    const saved = await rule(false, true);
    expect(saved.result).toMatchObject({ status: 'ok' });
    expect(saved.preview?.changes.released.map((r) => r.taskKey)).toEqual([to.key]);
    const now = await state();
    expect(now.plan.released?.find((r) => r.taskKey === to.key)).toMatchObject({
      assigneeId: 'a',
    });
    expect(todayCards(now.plan, 'a').main.some((c) => c.kind === 'released')).toBe(true);
    // 外の相手への頼み事は無い（家族の中の作業）。取り消しの連絡を作らない。
    expect(now.plan.tasks.some((t) => t.live && t.cancels !== undefined)).toBe(false);
    expect(violations(now)).toEqual([]);
    expect(blocked(now)).toEqual([]);
  });

  it('決まりは子だけ。大人や頼める人に入れる直しは断り、何も書かない', async () => {
    const { state, save } = await family();
    const before = (await state()).events.length;
    const saved = await save((h) => {
      const adult = h.members.find((m) => m.id === 'a');
      if (adult) adult.clubEscort = { to: true, from: true };
    });
    expect(saved.result).toMatchObject({ status: 'invalid', reason: 'membersLocked' });
    expect((await state()).events.length).toBe(before);
  });

  it('行事ごとに「今回は要らない」と決めた回は、家の決まりを替えても、その回の決めたほうを使う', async () => {
    const { state, run, rule } = await family();
    // 札の「今回は要らない」と同じ言明（この回の送りだけ）。
    expect(
      await run('b', {
        type: 'stateEscort',
        itemId: 'club-rule:i',
        leg: 'to',
        needed: false,
        seen: { throughSeq: (await state()).plan.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(escorts((await state()).plan).to).toEqual([]);
    // 家の決まりを「帰りだけ」にしてから「行きも帰りも」に戻しても、この回の送りは作らない（迎えは決まりどおり）。
    expect((await rule(false, true)).result).toMatchObject({ status: 'ok' });
    expect((await rule(true, true)).result).toMatchObject({ status: 'ok' });
    const now = await state();
    expect(escorts(now.plan).to).toEqual([]);
    expect(escorts(now.plan).from).toHaveLength(1);
    expect(violations(now)).toEqual([]);
  });
});
