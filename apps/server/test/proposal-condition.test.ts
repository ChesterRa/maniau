// 引き受けの控えに条件が入る：開いた画面で見た条件が、ほかの大人の直しと読み直しで別の式になったら、
// 古い画面からの引き受けは断り、今の条件を見せ直す（時刻・用件・担当が同じでも）。
import { DomainEvent, proposalSnapshot } from '@maniau/core';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const at = '2026-11-25T20:05+09:00';
const written = (date: string) => `発表会が${date}なら、11月27日までに出欠票を提出してください。`;
const reading = (value: string) => ({
  sourceId: 'n3',
  unknowns: [],
  irrelevantSentenceIds: [],
  ambiguities: [],
  conditions: [{ id: 'n3:c1', kind: 'eq', unknownId: 'n1:u1', value }],
  items: [
    {
      id: 'n3:i1',
      sourceId: 'n3',
      sentenceIds: ['n3#1'],
      kind: 'submission',
      written: written(value === '2026-12-05' ? '12月5日' : '12月8日'),
      interpretation: { what: '出欠票', date: '2026-11-27' },
      conditionNodeId: 'n3:c1',
      evidence: 'stated',
      effects: [],
    },
  ],
});

it('見せた条件が別の式に替わったら、古い画面の引き受けは断り、今の提案なら引き受ける', async () => {
  const events = [...demoEvents('arrived')];
  const add = (actorId: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `cond-${events.length + 1}`,
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  const first = events.find((e) => e.type === 'noticeReceived');
  if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
  add('b', {
    type: 'noticeReceived',
    source: {
      ...first.source,
      id: 'n3',
      title: '出欠票',
      sentences: [{ id: 'n3#1', text: written('12月5日') }],
    },
  });
  add('system', {
    type: 'modelOutputRecorded',
    call: 'extract',
    sourceId: 'n3',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: 'n3-v1',
    sourceVersion: 1,
    output: reading('2026-12-05'),
  });
  const taskKey = 'task:submit:n3:i1';
  add('b', { type: 'assignmentProposed', taskKey, assigneeId: 'b' });
  const store = memoryStore(new Map([['demo', events]]));
  const before = viewFor(events, 'b', at).plan.tasks.find((t) => t.key === taskKey);
  const shown = before && proposalSnapshot(before);
  if (!shown) throw new Error('提案を置けない');

  // もう一人の大人が文を直し、読み直すと、条件の日が替わる（時刻・用件・担当は同じ）。
  await store.withHousehold('demo', (log) =>
    log.append(
      [
        {
          type: 'transcriptionCorrected',
          sourceId: 'n3',
          sourceVersion: 2,
          sentences: [{ id: 'n3#1', text: written('12月8日') }],
        },
      ],
      'a',
      at,
    ),
  );
  await store.withHousehold('demo', (log) =>
    log.append(
      [
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'n3',
          model: 'hand-written',
          promptVersion: 'fixture',
          inputHash: 'n3-v2',
          sourceVersion: 2,
          output: reading('2026-12-08'),
        },
      ],
      'system',
      at,
    ),
  );
  const now = await store.withHousehold('demo', (log) =>
    viewFor(log.events(), 'b', at).plan.tasks.find((t) => t.key === taskKey),
  );
  expect(now).toMatchObject({ start: shown.start, end: shown.end, titleKey: shown.titleKey });
  expect(now?.condition).not.toBe(shown.condition);

  const stale = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'accept-old', now: at, demo: true },
    { type: 'accept', taskKey, shown },
  );
  expect(stale).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
  const still = await store.withHousehold('demo', (log) =>
    viewFor(log.events(), 'b', at).plan.tasks.find((t) => t.key === taskKey),
  );
  expect(still?.commitment).toBe('proposed');

  const current = now && proposalSnapshot(now);
  if (!current) throw new Error('今の提案を置けない');
  const ok = await runCommand(
    store,
    'demo',
    { memberId: 'b', operationId: 'accept-new', now: at, demo: true },
    { type: 'accept', taskKey, shown: current },
  );
  expect(ok).toMatchObject({ status: 'ok' });
  const done = await store.withHousehold('demo', (log) =>
    viewFor(log.events(), 'b', at).plan.tasks.find((t) => t.key === taskKey),
  );
  expect(done).toMatchObject({ commitment: 'accepted' });
  expect(done?.reconfirm).toBeUndefined();
});
