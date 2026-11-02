// 事象の置き場所（02-foundation §6・§7.3）。家庭ごとに書き込みを一列に並べ、操作 ID で二重の書き込みを防ぐ。
// メモリの置き場所（デモと試験）と、Postgres の置き場所（db/store.ts）は、同じ形（Store）を持つ。
import { type DateTime, DomainEvent } from '@maniau/core';
import type { Db } from './db/store';

type Envelope = 'id' | 'householdId' | 'seq' | 'version' | 'occurredAt' | 'recordedAt' | 'actorId';
type Body<E> = E extends DomainEvent ? Omit<E, Envelope> : never;
/** 事象の中身（通し番号・時刻・操作した人は、置き場所が付ける）。 */
export type EventBody = Body<DomainEvent>;

/** 一つの操作の記録（§7.3 の 4・7）。何も起きなかった操作も残す。 */
export interface Operation {
  id: string;
  actorId: string;
  /** 命令の要約（同じ操作 ID で中身の違う送り直しを見分ける）。 */
  digest: string;
  /** この操作の後の、最後の通し番号。 */
  throughSeq: number;
}

/** 押さえた家庭の事象の列。withHousehold の中でだけ使う。 */
export interface HouseholdLog {
  readonly householdId: string;
  events(): readonly DomainEvent[];
  /** 事象に通し番号を付けて足す。型に合わない物は足さずに投げる。 */
  append(bodies: readonly EventBody[], actorId: string, at: DateTime): DomainEvent[];
  operation(id: string): Operation | undefined;
  recordOperation(operation: Operation): void;
  /**
   * 成員の表（権限の正本）で、今も有効な大人か。押さえた中で読んだ物（§7.3 の 3）。成員の表の無い
   * 置き場所（デモのメモリ）には無く、事象の家族の情報だけで確かめる。
   */
  isActiveAdult?(memberId: string): boolean;
  /**
   * 確かめた身元が、今もその大人に結ばれているか（有効な大人で、身元を外していない）。押さえた中で
   * 読んだ物。身元で入る家族の家庭は、家庭の物を読む・書く前に、必ずこれで確かめ直す。
   */
  isBound?(memberId: string, identityId: string): boolean;
  /**
   * 書き込みのまとまり（一度の withHousehold で足した事象）ごとの、最後の通し番号（昇順）。知らせの
   * 回を数える時に、まとまりの途中の形を見ないために使う。まとまりの分からない古い事象は、一つずつ
   * を一まとまりとする。
   */
  batchEnds?(): readonly number[];
  /**
   * 家庭を押さえている取引（Postgres の置き場所だけ）。事象の他の表（知らせの登録先など）を、押さえた
   * 中で確かめた事と同じ取引で書く時に使う（確かめた後・書く前に外された身元で、書きを残さない。外す
   * 側も家庭を押さえる）。
   */
  transaction?: Db;
}

export interface Store {
  /** 家庭の行を押さえて fn を走らせる。同じ家庭の書き込みは一列に並ぶ（§7.3 の 2）。 */
  withHousehold<T>(householdId: string, fn: (log: HouseholdLog) => T | Promise<T>): Promise<T>;
}

interface MemoryHousehold {
  events: DomainEvent[];
  /** 書き込みのまとまりの、最後の通し番号。 */
  batchEnds: number[];
  operations: Map<string, Operation>;
  /** 前の書き込みが終わるのを待つための鎖。 */
  tail: Promise<unknown>;
}

/** メモリの置き場所。デモの家庭（ログインの無い、架空の家族）と試験に使う。 */
export function memoryStore(
  seed: ReadonlyMap<string, readonly DomainEvent[]> = new Map(),
): Store & {
  create(householdId: string, events: readonly DomainEvent[]): void;
  drop(householdId: string): void;
  has(householdId: string): boolean;
} {
  const households = new Map<string, MemoryHousehold>();
  const create = (householdId: string, events: readonly DomainEvent[]) => {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    households.set(householdId, {
      events: sorted,
      // 最初に置いた事象は、まとまりが分からないので一つずつ。
      batchEnds: sorted.map((e) => e.seq),
      operations: new Map(),
      tail: Promise.resolve(),
    });
  };
  for (const [id, events] of seed) create(id, events);

  return {
    create,
    drop: (householdId) => households.delete(householdId),
    has: (householdId) => households.has(householdId),
    withHousehold<T>(householdId: string, fn: (log: HouseholdLog) => T | Promise<T>) {
      const household = households.get(householdId);
      if (!household) return Promise.reject(new Error(`家庭が無い：${householdId}`));
      // 置き場所のキー（デモでは見る人ごとの家庭）と、事象の中の家庭の ID は別でよい。
      const eventHouseholdId = household.events[0]?.householdId ?? householdId;
      const log: HouseholdLog = {
        householdId: eventHouseholdId,
        events: () => household.events,
        append(bodies, actorId, at) {
          // 全部を確かめてから足す（途中で投げても、半分だけ足さない）。
          let seq = household.events.at(-1)?.seq ?? 0;
          const added = bodies.map((body) => {
            seq += 1;
            return DomainEvent.parse({
              id: `${householdId}-${seq}`,
              householdId: eventHouseholdId,
              seq,
              version: 1,
              occurredAt: at,
              recordedAt: at,
              actorId,
              ...body,
            });
          });
          household.events.push(...added);
          return added;
        },
        operation: (id) => household.operations.get(id),
        recordOperation: (operation) => household.operations.set(operation.id, operation),
        batchEnds: () => household.batchEnds,
      };
      const run = household.tail.then(async () => {
        const before = household.events.length;
        const operations = new Map(household.operations);
        try {
          const result = await fn(log);
          const last = household.events.at(-1);
          if (household.events.length > before && last) household.batchEnds.push(last.seq);
          return result;
        } catch (error) {
          // Postgres の取引と同じく、途中で投げたら、この中で足した事象と操作の控えを戻す（半分だけ残さない）。
          household.events.length = before;
          household.operations = operations;
          throw error;
        }
      });
      // 失敗しても、次の書き込みは待たせない。
      household.tail = run.catch(() => undefined);
      return run;
    },
  };
}
