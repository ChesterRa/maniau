// Postgres の置き場所（02-foundation §6・§7.3）。メモリの置き場所と同じ形（Store）で、一つの命令を
// 一つのトランザクションで処理する：家庭の行を押さえ、事象と中身を読んで戻し、命令の処理の後に、
// 足した事象を乾かして書き、操作を記録する。途中で投げれば、何も書かない。
import { type DateTime, DomainEvent, type Household } from '@maniau/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { EventBody, HouseholdLog, Operation, Store } from '../store';
import { type DriedEvent, dehydrate, rehydrate } from './dry';
import { events, households, identities, members, operations, payloads } from './schema';

// biome-ignore lint/suspicious/noExplicitAny: drizzle の型の引数（ドライバーごとに違う）
export type Db = PgDatabase<PgQueryResultHKT, any>;

export interface NewHousehold {
  id: string;
  kind: 'real' | 'test';
  region: string;
  timeZone: string;
}

/** 成員の表に置く物（権限の正本。名前などの中身は置かない）。 */
export interface MemberRow {
  id: string;
  kind: 'adult' | 'child' | 'helper';
  active: boolean;
}

/**
 * 家庭の行と、成員の行を作る（最初の設定・試験）。事象（家族の情報など）は、作った後に足す。
 * 成員の表は、家族の情報の事象と同じ顔ぶれにする（家族の情報を替える時は、両方を一緒に替える）。
 */
export async function createHousehold(
  db: Db,
  household: NewHousehold,
  people: readonly MemberRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(households).values(household);
    if (people.length > 0) {
      await tx.insert(members).values(
        people.map((m) => ({
          householdId: household.id,
          id: m.id,
          kind: m.kind,
          active: m.active,
        })),
      );
    }
  });
}

/**
 * 家庭を作る（最初の一度）：家庭の行・成員の行・家族の情報の事象（householdSet）を、一つのトランザク
 * ションで作る。家庭の ID は、家族の情報の ID を使う（二つを別々に決めない）。途中で失敗すれば何も
 * 残さないので、そのままやり直せる。
 */
export async function setupHousehold(
  db: Db,
  kind: 'real' | 'test',
  household: Household,
  at: DateTime,
): Promise<void> {
  await db.transaction(async (tx) => {
    await createHousehold(
      tx,
      { id: household.id, kind, region: household.region, timeZone: household.timeZone },
      household.members.map((m) => ({ id: m.id, kind: m.kind, active: m.active })),
    );
    await postgresStore(tx).withHousehold(household.id, (log) => {
      log.append([{ type: 'householdSet', household }], 'system', at);
    });
  });
}

export function postgresStore(db: Db): Store {
  return {
    withHousehold<T>(householdId: string, fn: (log: HouseholdLog) => T | Promise<T>) {
      return db.transaction(async (tx) => {
        // 家庭の行を押さえる。同じ家庭の書き込みは、ここで一列に並ぶ（§7.3 の 2）。
        const [household] = await tx
          .select()
          .from(households)
          .where(eq(households.id, householdId))
          .for('update');
        if (!household) throw new Error(`家庭が無い：${householdId}`);
        if (household.status !== 'active') throw new Error(`使えない家庭：${householdId}`);

        const rows = await tx
          .select()
          .from(events)
          .where(eq(events.householdId, householdId))
          .orderBy(asc(events.seq));
        const contents = new Map(
          (await tx.select().from(payloads).where(eq(payloads.householdId, householdId))).map(
            (p) => [p.id, p],
          ),
        );
        const stored: DomainEvent[] = rows.map((row) => {
          const body = row.body as DriedEvent['row']['body'];
          const payloadId = typeof body.payloadId === 'string' ? body.payloadId : undefined;
          const { payloadId: _, ...kept } = body;
          const payload = payloadId ? contents.get(payloadId) : undefined;
          const live = payload && payload.deletedAt === null ? payload : undefined;
          return rehydrate(
            householdId,
            { ...row, body: kept },
            live ? (live.body as Record<string, unknown> | null) : undefined,
            payloadId !== undefined,
            live?.sha256 ?? null,
          );
        });
        const ops = new Map(
          (await tx.select().from(operations).where(eq(operations.householdId, householdId))).map(
            (o) => [o.opId, o],
          ),
        );
        // 押さえた中で、成員の表と身元から、今の大人と結びを読む（押さえる前に外した大人・身元を、
        // 押さえた後にも断る）。
        const people = await tx.select().from(members).where(eq(members.householdId, householdId));
        const adults = new Set(
          people.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id),
        );
        const boundIds = people.flatMap((m) => (m.identityId === null ? [] : [m.identityId]));
        const liveIdentities = new Set(
          boundIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: identities.id })
                  .from(identities)
                  .where(and(inArray(identities.id, boundIds), isNull(identities.removedAt)))
              ).map((r) => r.id),
        );

        // 命令の処理は、読んだ物の上で、足す物を溜める（書くのは、処理が終わってから）。
        const added: DomainEvent[] = [];
        const recorded: Operation[] = [];
        const all = () => [...stored, ...added];
        const log: HouseholdLog = {
          householdId,
          events: all,
          append(bodies: readonly EventBody[], actorId, at) {
            let seq = Math.max(household.nextSeq - 1, all().at(-1)?.seq ?? 0);
            const parsed = bodies.map((body) => {
              seq += 1;
              return DomainEvent.parse({
                id: `${householdId}-${seq}`,
                householdId,
                seq,
                version: 1,
                occurredAt: at,
                recordedAt: at,
                actorId,
                ...body,
              });
            });
            added.push(...parsed);
            return parsed;
          },
          operation: (id) => {
            const found = ops.get(id);
            return found
              ? {
                  id: found.opId,
                  actorId: found.actorId,
                  digest: found.digest,
                  throughSeq: found.throughSeq,
                }
              : recorded.find((o) => o.id === id);
          },
          recordOperation: (operation) => {
            recorded.push(operation);
          },
          transaction: tx,
          isActiveAdult: (memberId) => adults.has(memberId),
          isBound: (memberId, identityId) =>
            adults.has(memberId) &&
            liveIdentities.has(identityId) &&
            people.some((m) => m.id === memberId && m.identityId === identityId),
          batchEnds: () => {
            const ends: number[] = [];
            rows.forEach((row, i) => {
              const next = rows[i + 1];
              // 印の無い古い行は、一つずつを一まとまりとする。
              if (!next || row.batch === null || next.batch !== row.batch) ends.push(row.seq);
            });
            const pending = added.at(-1);
            if (pending) ends.push(pending.seq);
            return ends;
          },
        };

        const result = await fn(log);

        // 一つの命令は、操作を一つ記録する。その操作で足した事象に、操作の ID を付ける（たどれるように）。
        // 足した事象は一つの書き込みのまとまりで、最初の通し番号で印を付ける（知らせの回を数える区切り）。
        const opId = recorded.length === 1 ? recorded[0]?.id : undefined;
        const batch = added[0]?.seq;
        for (const event of added) {
          const { row, payload } = dehydrate(event);
          if (payload) {
            await tx.insert(payloads).values({
              householdId,
              id: payload.id,
              kind: payload.kind,
              sha256: payload.sha256,
              body: payload.body,
            });
          }
          await tx.insert(events).values({
            householdId,
            ...row,
            ...(opId === undefined ? {} : { opId }),
            batch,
            // 中身の ID は body に置く（§6.1）。許す一覧に payloadId は無いので、事象の欄とは混ざらない。
            body: payload ? { ...row.body, payloadId: payload.id } : row.body,
          });
        }
        for (const operation of recorded) {
          await tx.insert(operations).values({
            householdId,
            opId: operation.id,
            actorId: operation.actorId,
            digest: operation.digest,
            throughSeq: operation.throughSeq,
          });
        }
        const last = all().at(-1)?.seq ?? 0;
        if (last + 1 !== household.nextSeq) {
          await tx
            .update(households)
            .set({ nextSeq: last + 1 })
            .where(eq(households.id, householdId));
        }
        return result;
      });
    },
  };
}
