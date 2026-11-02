// 試験の Postgres：PGlite に移行を当て、事象を入れた家庭を作る（成員の表は家族の情報の事象から）。
import { PGlite } from '@electric-sql/pglite';
import type { DomainEvent } from '@maniau/core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS } from '../src/db/connect';
import { createHousehold, type Db, postgresStore } from '../src/db/store';

/** デモの家族の情報の ID（試験の家庭の ID に使う）。 */
export const H = 'demo-toyosu';

import type { EventBody } from '../src/store';

export async function database(): Promise<Db> {
  const db = drizzle(new PGlite());
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

/** 事象の本体（通し番号・時刻・操作した人を除いた物）。 */
export function bodyOf(event: DomainEvent): EventBody {
  const {
    id: _i,
    householdId: _h,
    seq: _s,
    version: _v,
    occurredAt: _o,
    recordedAt: _r,
    ...rest
  } = event;
  const { actorId: _a, ...body } = rest;
  return body as EventBody;
}

/**
 * 事象を、その順で新しい家庭に入れる（試験の種）。家庭の ID は家族の情報の ID（事象の家庭と揃える）。
 * 成員の表は、家族の情報の事象から作る。
 */
export async function seeded(db: Db, householdId: string, source: readonly DomainEvent[]) {
  const set = source.find((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw new Error('家族の情報が無い');
  if (set.household.id !== householdId) throw new Error('家庭の ID が家族の情報と違う');
  await createHousehold(
    db,
    { id: householdId, kind: 'test', region: 'JP', timeZone: 'Asia/Tokyo' },
    set.household.members.map((m) => ({ id: m.id, kind: m.kind, active: m.active })),
  );
  const store = postgresStore(db);
  await store.withHousehold(householdId, (log) => {
    for (const event of source) log.append([bodyOf(event)], event.actorId, event.occurredAt);
  });
  return store;
}
