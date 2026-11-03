// 家族の架空の決まりと架空の通知を、正式な計画と独立検証の両方に通す。
import {
  type Command,
  choicePreview,
  notificationIntents,
  proposalSnapshot,
  todayCards,
} from '@maniau/core';
import { computePlan, foldEvents, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { previewCommand, runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const NOW = '2026-11-25T20:00+09:00';

async function setup(changes: Record<string, unknown> = {}, now = NOW, sourceText?: string) {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  await store.withHousehold('demo', (log) => {
    const first = log.events().find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('出典が無い');
    const start = 'startTime' in changes ? changes.startTime : '10:00';
    const end = 'endTime' in changes ? changes.endTime : '12:00';
    const text =
      sourceText ??
      `12月6日（日）${typeof start === 'string' ? `${start}から` : ''}${typeof end === 'string' ? `${end}まで` : ''}、みどり公園で練習試合。`;
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            ...first.source,
            id: 'club-check',
            sender: 'club',
            title: 'クラブの連絡',
            sentences: [{ id: 'club-check#1', text }],
          },
        },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'club-check',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          output: {
            sourceId: 'club-check',
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'club-check:i',
                sourceId: 'club-check',
                sentenceIds: ['club-check#1'],
                kind: 'event',
                written: text,
                evidence: 'stated',
                effects: [],
                interpretation: {
                  what: '練習試合',
                  date: '2026-12-06',
                  startTime: '10:00',
                  endTime: '12:00',
                  place: 'みどり公園',
                  ...changes,
                },
              },
            ],
          },
        },
      ],
      'b',
      now,
    );
  });
  let sequence = 0;
  const run = (who: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId: who, now, operationId: `escort-audit-${++sequence}`, demo: true },
      command,
    );
  const read = async () => {
    const events = await store.withHousehold('demo', (log) => [...log.events()]);
    const state = events.findLast((e) => e.type === 'householdSet');
    if (state?.type !== 'householdSet') throw new Error('家族が無い');
    return { events, plan: computePlan(events, now), household: state.household };
  };
  return { run, read, store };
}

describe('実際の計画と独立検証器の接続', () => {
  it('引き受け後の再読と条件の変更で作業が止まっても、確認の知らせを通す', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    const text = '12月6日（日）09:00から11:00まで、みどり公園で練習試合。';
    const output = {
      sourceId: 'club-check',
      unknowns: [{ id: 'rain-audit', label: '雨か', values: ['yes', 'no'], kind: 'schedule' }],
      conditions: [{ id: 'dry-audit', kind: 'eq', unknownId: 'rain-audit', value: 'no' }],
      irrelevantSentenceIds: [],
      ambiguities: [],
      items: [
        {
          id: 'club-check:i',
          sourceId: 'club-check',
          sentenceIds: ['club-check#1'],
          kind: 'event',
          written: text,
          evidence: 'stated',
          effects: [],
          conditionNodeId: 'dry-audit',
          interpretation: {
            what: '練習試合',
            date: '2026-12-06',
            startTime: '09:00',
            endTime: '11:00',
            place: 'みどり公園',
          },
        },
      ],
    };
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'club-check',
            sourceVersion: 1,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output,
          },
          { type: 'answered', unknownId: 'rain-audit', value: 'no' },
        ],
        'b',
        now,
      ),
    );
    let current = await app.read();
    const proposed = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!proposed) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: proposed.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === proposed.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: proposed.key, shown })).status).toBe(
      'ok',
    );
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [
          {
            type: 'transcriptionCorrected',
            sourceId: 'club-check',
            sourceVersion: 2,
            sentences: [{ id: 'club-check#1', text }],
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'club-check',
            sourceVersion: 2,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output,
          },
          { type: 'answered', unknownId: 'rain-audit', value: 'yes' },
        ],
        'b',
        now,
      ),
    );
    current = await app.read();
    expect(current.plan.tasks.find((t) => t.key === proposed.key)?.live).toBe(false);
    expect(current.plan.released?.find((r) => r.taskKey === proposed.key)?.reason).toBe(
      'unconfirmed',
    );
    const intents = notificationIntents(current.plan, current.household).filter(
      (n) => n.subject.id === proposed.key,
    );
    expect(intents.map((n) => n.titleKey)).toContain('notify.releasedCheck');
    const gate = sendGate({ ...current, intents, batchEnds: current.events.map((e) => e.seq) });
    expect(gate).toMatchObject({ all: false, codes: [] });
  });
  it('既定の送り・迎え、片方を不要にした計画の両方に違反を出さない', async () => {
    const app = await setup();
    let current = await app.read();
    expect(current.plan.tasks.filter((t) => t.titleKey.startsWith('task.escort'))).toHaveLength(2);
    expect(verifyPlan(current).issues.filter((i) => i.kind === 'violation')).toEqual([]);
    const result = await app.run('b', {
      type: 'stateEscort',
      itemId: 'club-check:i',
      leg: 'to',
      needed: false,
      seen: { throughSeq: current.plan.throughSeq },
    });
    expect(result.status).toBe('ok');
    current = await app.read();
    expect(current.plan.tasks.filter((t) => t.titleKey.startsWith('task.escort'))).toHaveLength(1);
    expect(verifyPlan(current).issues.filter((i) => i.kind === 'violation')).toEqual([]);
  });

  it('終了時刻のない迎えも、事実を補わず day のまま検証する', async () => {
    const app = await setup({ endTime: undefined });
    const current = await app.read();
    const pickup = current.plan.tasks.find((t) => t.titleKey === 'task.escortFrom');
    expect(pickup?.timing).toBe('day');
    expect(verifyPlan(current).issues.filter((i) => i.kind === 'violation')).toEqual([]);
  });

  it('始まりが書かれず終了だけ翌日と書かれた行事を、前日に迎えへ置かない', async () => {
    const app = await setup(
      { startTime: undefined, endTime: '01:00' },
      NOW,
      '12月6日開催の練習は、翌日01:00終了です。',
    );
    const current = await app.read();
    const pickup = current.plan.tasks.find((t) => t.titleKey === 'task.escortFrom');
    expect(pickup).toBeDefined();
    expect(
      pickup?.titleParams.date === '2026-12-07' || pickup?.titleParams.date === undefined,
    ).toBe(true);
  });

  it('翌日と明記した終了が始まりより遅い時刻でも、同日に置かない', async () => {
    const app = await setup(
      { startTime: '09:00', endTime: '10:00' },
      NOW,
      '12月6日09:00から翌日10:00まで練習します。',
    );
    const current = await app.read();
    const pickup = current.plan.tasks.find((t) => t.titleKey === 'task.escortFrom');
    expect(pickup).toBeDefined();
    expect(
      pickup?.titleParams.date === '2026-12-07' || pickup?.titleParams.date === undefined,
    ).toBe(true);
  });

  it('「翌日の終了」の時刻を読み取れなかった時も、迎えの日を前日に決めない', async () => {
    const app = await setup(
      { startTime: '23:00', endTime: undefined, endTimeUnconfirmed: true },
      NOW,
      '12月6日23:00から翌日午前1時まで練習します。',
    );
    const current = await app.read();
    const pickup = current.plan.tasks.find((t) => t.titleKey === 'task.escortFrom');
    expect(pickup).toBeDefined();
    expect(
      pickup?.titleParams.date === '2026-12-07' || pickup?.titleParams.date === undefined,
    ).toBe(true);
  });

  it('他の人は引き受けを消せず、本人が外した後に戻すと担当が空く', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const proposed = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!proposed) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: proposed.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const task = current.plan.tasks.find((t) => t.key === proposed.key);
    if (!task) throw new Error('提案が無い');
    const shown = proposalSnapshot(task);
    expect(shown).toBeDefined();
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    current = await app.read();
    expect(current.plan.tasks.find((t) => t.key === task.key)?.commitment).toBe('accepted');
    const seqBefore = current.plan.throughSeq;
    expect(
      await app.run('b', {
        type: 'stateEscort',
        itemId: 'club-check:i',
        leg: 'to',
        needed: false,
        seen: { throughSeq: seqBefore },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'heldByOther' });
    current = await app.read();
    expect(current.plan.throughSeq).toBe(seqBefore);
    expect(current.plan.tasks.find((t) => t.key === task.key)?.commitment).toBe('accepted');
    expect(
      await app.run('a', {
        type: 'stateEscort',
        itemId: 'club-check:i',
        leg: 'to',
        needed: false,
        seen: { throughSeq: seqBefore },
      }),
    ).toMatchObject({ status: 'ok' });
    current = await app.read();
    expect(current.events.slice(-2)).toMatchObject([
      { type: 'commitmentChanged', taskKey: task.key, assigneeId: 'a', action: 'withdraw' },
      { type: 'escortStated', leg: 'to', needed: false },
    ]);
    expect(current.plan.tasks.some((t) => t.key === task.key)).toBe(false);
    expect(
      await app.run('b', {
        type: 'stateEscort',
        itemId: 'club-check:i',
        leg: 'to',
        needed: true,
        seen: { throughSeq: current.plan.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    current = await app.read();
    expect(current.plan.tasks.find((t) => t.key === task.key)?.commitment).not.toBe('accepted');
    for (const memberId of ['a', 'b']) {
      expect(
        todayCards(current.plan, memberId).main.some(
          (card) => card.kind === 'unowned' && card.task.key === task.key,
        ),
      ).toBe(true);
    }
    expect(verifyPlan(current).issues.filter((i) => i.kind === 'violation')).toEqual([]);
  });
  it('急な中止のお知らせの後も、引き受けた人に出発前に知らせる', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const proposed = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!proposed) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: proposed.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === proposed.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: proposed.key, shown })).status).toBe(
      'ok',
    );
    await app.store.withHousehold('demo', (log) => {
      const old = log.events().find((e) => e.type === 'noticeReceived');
      if (old?.type !== 'noticeReceived') throw new Error('通知が無い');
      const text = '雨のため、練習試合を中止します。';
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              ...old.source,
              id: 'cancel-check',
              sender: 'club',
              receivedAt: now,
              title: '中止の連絡',
              sentences: [{ id: 'cancel-check#1', text }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'cancel-check',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'cancel-check',
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [
                {
                  id: 'cancel-check:i',
                  sourceId: 'cancel-check',
                  sentenceIds: ['cancel-check#1'],
                  kind: 'event',
                  written: text,
                  evidence: 'stated',
                  interpretation: { what: '中止' },
                  effects: [{ type: 'cancel', itemId: 'club-check:i' }],
                },
              ],
            },
          },
        ],
        'b',
        now,
      );
    });
    current = await app.read();
    const notices = notificationIntents(current.plan, current.household).filter(
      (n) => n.toMemberId === 'a',
    );
    expect(notices.some((n) => n.subject.id === proposed.key)).toBe(true);
    const gate = sendGate({
      ...current,
      intents: notices,
      batchEnds: current.events.map((e) => e.seq),
    });
    expect(gate).toMatchObject({ all: false, codes: [] });
    expect(gate.blocked.size).toBe(0);
  });

  it('本人が「もう要らない」を画面で見た後で戻った時、古い引き受けを無言で使わない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const original = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!original) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: original.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === original.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: original.key, shown })).status).toBe(
      'ok',
    );
    await app.store.withHousehold('demo', (log) => {
      const old = log.events().find((event) => event.type === 'noticeReceived');
      if (old?.type !== 'noticeReceived') throw new Error('通知が無い');
      const text = '雨のため、練習試合を中止します。';
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              ...old.source,
              id: 'cancel-view',
              sender: 'club',
              receivedAt: now,
              title: '中止の連絡',
              sentences: [{ id: 'cancel-view#1', text }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'cancel-view',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'cancel-view',
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [
                {
                  id: 'cancel-view:i',
                  sourceId: 'cancel-view',
                  sentenceIds: ['cancel-view#1'],
                  kind: 'event',
                  written: text,
                  evidence: 'stated',
                  interpretation: { what: '中止' },
                  effects: [{ type: 'cancel', itemId: 'club-check:i' }],
                },
              ],
            },
          },
        ],
        'b',
        now,
      );
    });
    current = await app.read();
    const visible = viewFor(current.events, 'a', now);
    expect(visible.today.main[0]).toMatchObject({
      kind: 'released',
      released: { taskKey: original.key, reason: 'gone' },
    });
    // この札を見ただけで「わかりました」は押さず、Push もまだ送られていない。
    expect((await app.run('b', { type: 'withdrawSource', sourceId: 'cancel-view' })).status).toBe(
      'ok',
    );
    current = await app.read();
    const restored = current.plan.tasks.find((t) => t.key === original.key);
    expect(restored?.commitment).toBe('proposed');
    expect(
      viewFor(current.events, 'a', now).today.main.some(
        (card) => card.kind === 'proposal' && card.task.key === original.key,
      ),
    ).toBe(true);
  });

  it('戻る前の「わかりました」を遅れて押しても、戻った引き受けを取り下げない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const task = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!task) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === task.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    await app.store.withHousehold('demo', (log) => {
      const old = log.events().find((event) => event.type === 'noticeReceived');
      if (old?.type !== 'noticeReceived') throw new Error('通知が無い');
      const text = '雨のため練習を中止します。';
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              ...old.source,
              id: 'cancel-late',
              sender: 'club',
              receivedAt: now,
              title: '中止の連絡',
              sentences: [{ id: 'cancel-late#1', text }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'cancel-late',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'cancel-late',
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [
                {
                  id: 'cancel-late:i',
                  sourceId: 'cancel-late',
                  sentenceIds: ['cancel-late#1'],
                  kind: 'event',
                  written: text,
                  evidence: 'stated',
                  interpretation: { what: '中止' },
                  effects: [{ type: 'cancel', itemId: 'club-check:i' }],
                },
              ],
            },
          },
        ],
        'b',
        now,
      );
    });
    current = await app.read();
    expect(viewFor(current.events, 'a', now).today.main[0]).toMatchObject({ kind: 'released' });
    const seen = { throughSeq: current.plan.throughSeq };
    expect((await app.run('b', { type: 'withdrawSource', sourceId: 'cancel-late' })).status).toBe(
      'ok',
    );
    const beforeLateClick = await app.read();
    const result = await app.run('a', { type: 'acknowledgeReleased', taskKey: task.key, seen });
    expect(result.status).toBe('conflict');
    expect((await app.read()).plan.throughSeq).toBe(beforeLateClick.plan.throughSeq);
  });

  it('出典の中身が消えたら、現在の計画から消えても不要になったとは分からない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const task = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!task) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === task.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [{ type: 'sourceContentPurged', sourceId: 'club-check', scope: 'all' }],
        'system',
        now,
      ),
    );
    current = await app.read();
    const state = foldEvents(current.events);
    expect(current.plan.tasks.some((t) => t.key === task.key)).toBe(false);
    expect(state.sources.has('club-check')).toBe(false);
    expect(state.shown.get(task.key)?.titleParams.what).toBe('練習試合');
  });

  it('旧い引き受けで根拠の出典が記録されていない時、消した出典の用件を控えから再表示しない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const task = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!task) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === task.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [{ type: 'sourceContentPurged', sourceId: 'club-check', scope: 'all' }],
        'system',
        now,
      ),
    );
    current = await app.read();
    // 以前の正式な accept には basisSourceIds が無かった。出典だけを消した列でも、控えは事象に残り得る。
    const legacy = current.events.map((event) =>
      event.type === 'commitmentChanged' && event.action === 'accept' && event.taskKey === task.key
        ? { ...event, basisSourceIds: undefined }
        : event,
    );
    const after = computePlan(legacy, now);
    const release = after.released?.find((r) => r.taskKey === task.key);
    expect(release).toMatchObject({ taskKey: task.key, assigneeId: 'a', reason: 'unconfirmed' });
    expect(release?.content).toBeUndefined();
    expect(release?.start).toBeUndefined();
    expect(release?.end).toBeUndefined();
  });

  it('直した文を再読して元の事項が見つからないだけでは、引き受けを不要と断定しない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const task = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!task) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === task.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    const text = '12月6日（日）09:00から11:00まで、みどり公園で練習試合。';
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [
          {
            type: 'transcriptionCorrected',
            sourceId: 'club-check',
            sourceVersion: 2,
            sentences: [{ id: 'club-check#1', text }],
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'club-check',
            sourceVersion: 2,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'club-check',
              unknowns: [],
              conditions: [],
              items: [],
              irrelevantSentenceIds: ['club-check#1'],
              ambiguities: [],
            },
          },
        ],
        'b',
        now,
      ),
    );
    current = await app.read();
    const release = current.plan.released?.find((r) => r.taskKey === task.key);
    expect(release).toMatchObject({ taskKey: task.key, assigneeId: 'a', reason: 'unconfirmed' });
    const notices = notificationIntents(current.plan, current.household).filter(
      (n) => n.subject.id === task.key,
    );
    expect(notices.map((n) => n.titleKey)).not.toContain('notify.released');
    const gate = sendGate({
      ...current,
      intents: notices,
      batchEnds: current.events.map((e) => e.seq),
    });
    expect(gate).toMatchObject({ all: false, codes: [] });
    expect(gate.blocked.size).toBe(0);
    // その後に中止が届いても、再読後の ID が元の事項と同じか確かめられない。
    await app.store.withHousehold('demo', (log) => {
      const old = log.events().find((event) => event.type === 'noticeReceived');
      if (old?.type !== 'noticeReceived') throw new Error('通知が無い');
      const cancelled = '練習試合を中止します。';
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              ...old.source,
              id: 'cancel-after-read',
              sender: 'club',
              receivedAt: now,
              title: '中止',
              sentences: [{ id: 'cancel-after-read#1', text: cancelled }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'cancel-after-read',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'cancel-after-read',
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [
                {
                  id: 'cancel-after-read:i',
                  sourceId: 'cancel-after-read',
                  sentenceIds: ['cancel-after-read#1'],
                  kind: 'event',
                  written: cancelled,
                  evidence: 'stated',
                  interpretation: { what: '中止' },
                  effects: [{ type: 'cancel', itemId: 'club-check:i' }],
                },
              ],
            },
          },
        ],
        'b',
        now,
      );
    });
    current = await app.read();
    expect(current.plan.released?.find((r) => r.taskKey === task.key)?.reason).toBe('unconfirmed');
    const sentAfterCancel = notificationIntents(current.plan, current.household).filter(
      (n) => n.subject.id === task.key,
    );
    const gateAfterCancel = sendGate({
      ...current,
      intents: sentAfterCancel,
      batchEnds: current.events.map((e) => e.seq),
    });
    expect(gateAfterCancel).toMatchObject({ all: false, codes: [] });
  });

  it('再読で同じ ID を別の種類に使っても、元の行事が不要と決めない', async () => {
    const now = '2026-12-06T08:00+09:00';
    const app = await setup({ startTime: '09:00', endTime: '11:00' }, now);
    let current = await app.read();
    const task = current.plan.tasks.find((t) => t.titleKey === 'task.escortTo');
    if (!task) throw new Error('送りが無い');
    expect(
      (await app.run('a', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'a' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    const assigned = current.plan.tasks.find((t) => t.key === task.key);
    const shown = assigned && proposalSnapshot(assigned);
    if (!shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    const text = '12月6日（日）09:00から11:00まで、みどり公園で練習試合。';
    await app.store.withHousehold('demo', (log) =>
      log.append(
        [
          {
            type: 'transcriptionCorrected',
            sourceId: 'club-check',
            sourceVersion: 2,
            sentences: [{ id: 'club-check#1', text }],
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'club-check',
            sourceVersion: 2,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId: 'club-check',
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [
                {
                  id: 'club-check:i',
                  sourceId: 'club-check',
                  sentenceIds: ['club-check#1'],
                  kind: 'contact',
                  written: text,
                  interpretation: { what: '練習試合' },
                  evidence: 'stated',
                  effects: [],
                },
              ],
            },
          },
        ],
        'b',
        now,
      ),
    );
    current = await app.read();
    const release = current.plan.released?.find((r) => r.taskKey === task.key);
    expect(release).toMatchObject({ taskKey: task.key, assigneeId: 'a', reason: 'unconfirmed' });
    // 家族が再読された別種の事項を「読み違い」としただけでは、元の行事の中止ではない。
    expect(
      (await app.run('a', { type: 'dismissItem', itemId: 'club-check:i', reason: 'misread' }))
        .status,
    ).toBe('ok');
    current = await app.read();
    expect(current.plan.released?.find((r) => r.taskKey === task.key)?.reason).toBe('unconfirmed');
  });

  it('以前の案へ戻す時、選ぶ前の計算にも再提案を反映する', async () => {
    const app = await setup();
    const arr = 'arr:childCare:n1:i6:c';
    const school = keys.option(arr, 'opt-gakudo');
    const grandma = keys.option(arr, 'opt-grandma');
    expect(
      (await app.run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' })).status,
    ).toBe('ok');
    expect(
      (
        await app.run('b', {
          type: 'chooseOption',
          arrangementKey: arr,
          optionKey: school,
          role: 'primary',
          assigneeId: 'a',
        })
      ).status,
    ).toBe('ok');
    let current = await app.read();
    const task = current.plan.tasks.find(
      (t) => t.basis.optionKey === school && t.step?.stepId === 'write',
    );
    const shown = task && proposalSnapshot(task);
    if (!task || !shown) throw new Error('控えがない');
    expect((await app.run('a', { type: 'accept', taskKey: task.key, shown })).status).toBe('ok');
    expect(
      (
        await app.run('b', {
          type: 'chooseOption',
          arrangementKey: arr,
          optionKey: grandma,
          role: 'primary',
          assigneeId: 'b',
        })
      ).status,
    ).toBe('ok');
    current = await app.read();
    expect(current.plan.released?.some((r) => r.taskKey === task.key)).toBe(true);
    const command = {
      type: 'chooseOption' as const,
      arrangementKey: arr,
      optionKey: school,
      role: 'primary' as const,
      assigneeId: 'a',
    };
    const simulated = previewCommand(current.events, { memberId: 'a', now: NOW }, command);
    if (simulated.status !== 'ok') throw new Error('選んだらがない');
    const preview = choicePreview(simulated.before, simulated.after, arr, school);
    expect((await app.run('a', command)).status).toBe('ok');
    const after = await app.read();
    const actual = choicePreview(current.plan, after.plan, arr, school);
    expect(after.plan.tasks.find((t) => t.key === task.key)?.commitment).toBe('proposed');
    expect({
      steps: preview.steps,
      moved: preview.moved,
      conflicts: preview.conflicts,
      released: preview.released,
    }).toEqual({
      steps: actual.steps,
      moved: actual.moved,
      conflicts: actual.conflicts,
      released: actual.released,
    });
    expect(simulated.after.tasks.find((t) => t.key === task.key)?.commitment).toBe('proposed');
  });
});
