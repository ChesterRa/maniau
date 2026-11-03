// 架空の家庭だけの通知試験：PGlite と偽の送り手で、意図・gate・事業者受付の記録まで確かめる。
import { NOTIFICATION_TEXT, notificationHistory, notificationIntents } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { seedPushTest } from '../scripts/seed-push-test';
import { identities, members } from '../src/db/schema';
import { type Db, postgresStore, setupHousehold } from '../src/db/store';
import { demoEvents } from '../src/demo';
import { messageGate, sendGate } from '../src/gate';
import { notifier } from '../src/notifier';
import { saveSubscription } from '../src/push';
import { database, H } from './pg';

const NOW = '2026-11-04T12:00+09:00';
const source = demoEvents('arrived').find((e) => e.type === 'householdSet');
if (source?.type !== 'householdSet') throw new Error('デモの家族が無い');
const household = source.household;

async function subscribe(db: Db) {
  await db
    .insert(identities)
    .values({ id: 'fake-id', issuer: 'https://example.test', subject: 'fake' });
  await db
    .update(members)
    .set({ identityId: 'fake-id' })
    .where(and(eq(members.householdId, H), eq(members.id, 'b')));
  await saveSubscription(db, {
    endpoint: 'https://web.push.apple.com/test-b',
    p256dh: 'test-p256dh',
    auth: 'test-auth',
    householdId: H,
    memberId: 'b',
    identityId: 'fake-id',
    language: 'ja',
    requestedAt: Date.parse(NOW),
  });
}

it('相対期限の架空の意図は gate を通り、偽の送り手の受付を一回だけ記録する', async () => {
  const db = await database();
  await setupHousehold(db, 'test', household, NOW);
  await expect(seedPushTest(db, NOW)).rejects.toThrow('no_active_subscription');
  expect(await postgresStore(db).withHousehold(H, (log) => log.events().length)).toBe(1);
  await subscribe(db);
  await seedPushTest(db, NOW);
  const store = postgresStore(db);
  const events = await store.withHousehold(H, (log) => [...log.events()]);
  const plan = computePlan(events, NOW);
  const intents = notificationIntents(plan, household, notificationHistory(events));
  const wanted = intents.filter((i) => i.titleKey === 'notify.unowned');
  expect(wanted.map((i) => i.toMemberId).sort()).toEqual(['a', 'b']);
  expect(wanted.every((i) => i.until === '2026-11-04T13:30+09:00')).toBe(true);
  expect(
    verifyPlan({ household, plan, events }).issues.filter((i) => i.kind === 'violation'),
  ).toEqual([]);
  const gate = sendGate({ household, plan, events, intents, batchEnds: events.map((e) => e.seq) });
  expect(gate.all).toBe(false);
  expect(wanted.some((i) => gate.blocked.has(i.key))).toBe(false);
  const sent: { body: string }[] = [];
  const jobs = notifier({
    db,
    store,
    appVersion: 'fixture-test',
    gate: sendGate,
    messageGate,
    clock: () => Date.parse(NOW),
    report: () => {},
    send: async (_target, payload) => {
      sent.push({ body: payload.body });
      return { status: 'accepted' };
    },
  });
  await jobs.run(H);
  await jobs.run(H);
  expect(sent).toEqual([{ body: NOTIFICATION_TEXT.ja['notify.unowned'] }]);
  const notified = await store.withHousehold(H, (log) =>
    log.events().filter((e) => e.type === 'notified'),
  );
  expect(notified).toHaveLength(1);
  expect(notified[0]).toMatchObject({ toMemberId: 'b', channel: 'webPush', result: 'accepted' });
});

it('別の実家庭がある DB は、試験の家庭にも何も足さず拒否する', async () => {
  const db = await database();
  await setupHousehold(db, 'test', household, NOW);
  await subscribe(db);
  await setupHousehold(db, 'real', { ...household, id: 'unsafe-example' }, NOW);
  await expect(seedPushTest(db, NOW)).rejects.toThrow('not_dedicated_test_database');
  const events = await postgresStore(db).withHousehold(H, (log) => [...log.events()]);
  expect(events).toHaveLength(1);
});

it('日が変わってからでも、入力した時刻から 90 分後を期限にする', async () => {
  const db = await database();
  const at = '2026-11-05T16:20+09:00';
  await setupHousehold(db, 'test', household, at);
  await subscribe(db);
  await seedPushTest(db, at);
  const events = await postgresStore(db).withHousehold(H, (log) => [...log.events()]);
  const plan = computePlan(events, at);
  const wanted = notificationIntents(plan, household, notificationHistory(events)).filter(
    (intent) => intent.titleKey === 'notify.unowned',
  );
  expect(wanted).toHaveLength(2);
  expect(wanted.every((intent) => intent.until === '2026-11-05T17:50+09:00')).toBe(true);
});

it('一つだけでも real の家庭や、別の ID の家庭なら拒否する', async () => {
  const real = await database();
  await setupHousehold(real, 'real', household, NOW);
  await expect(seedPushTest(real, NOW)).rejects.toThrow('not_dedicated_test_database');
  expect(await postgresStore(real).withHousehold(H, (log) => log.events().length)).toBe(1);

  const other = await database();
  await setupHousehold(other, 'test', { ...household, id: 'other-test' }, NOW);
  await expect(seedPushTest(other, NOW)).rejects.toThrow('not_dedicated_test_database');
  expect(await postgresStore(other).withHousehold('other-test', (log) => log.events().length)).toBe(
    1,
  );
});

it('同じ ID の異なる家庭・繰り返し・夜間は、事象を足さず拒否する', async () => {
  const changed = await database();
  await setupHousehold(
    changed,
    'test',
    {
      ...household,
      members: household.members.map((m, i) => (i === 0 ? { ...m, name: '別の名前' } : m)),
    },
    NOW,
  );
  await expect(seedPushTest(changed, NOW)).rejects.toThrow('not_empty_demo_household');
  const db = await database();
  await setupHousehold(db, 'test', household, NOW);
  await expect(seedPushTest(db, '2026-11-04T22:00+09:00')).rejects.toThrow('outside_test_hours');
  const store = postgresStore(db);
  expect(await store.withHousehold(H, (log) => log.events().length)).toBe(1);
  await subscribe(db);
  await seedPushTest(db, NOW);
  expect(await store.withHousehold(H, (log) => log.events().length)).toBe(3);
  await expect(seedPushTest(db, NOW)).rejects.toThrow('not_empty_demo_household');
  expect(await store.withHousehold(H, (log) => log.events().length)).toBe(3);
});
