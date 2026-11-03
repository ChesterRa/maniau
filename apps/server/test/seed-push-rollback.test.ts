// 意図を確かめる gate が断ったら、途中で追加した架空事象も残さない。
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { identities, members } from '../src/db/schema';
import { postgresStore, setupHousehold } from '../src/db/store';
import { demoEvents } from '../src/demo';
import { saveSubscription } from '../src/push';
import { database, H } from './pg';

vi.mock('../src/gate', () => ({ sendGate: () => ({ all: true, blocked: new Set<string>() }) }));

it('gate が断れば、追加した二つの事象はまとめて戻る', async () => {
  const { seedPushTest } = await import('../scripts/seed-push-test');
  const db = await database();
  const initial = demoEvents('arrived').find((event) => event.type === 'householdSet');
  if (initial?.type !== 'householdSet') throw new Error('家族がない');
  const now = '2026-11-04T12:00+09:00';
  await setupHousehold(db, 'test', initial.household, now);
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
    requestedAt: Date.parse(now),
  });
  await expect(seedPushTest(db, now)).rejects.toThrow('fixture_gate_failed');
  const events = await postgresStore(db).withHousehold(H, (log) => [...log.events()]);
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('householdSet');
});
