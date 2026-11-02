// 事象の置き場所（02-foundation §6・§7.3）。家庭ごとに書き込みを一列に並べ、操作 ID で二重の書き込みを防ぐ。
// 今はメモリの置き場所だけ（デモと試験）。Postgres の置き場所は、同じ形で後に足す。
import { type DateTime, DomainEvent } from '@maniau/core';

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
}

export interface Store {
  /** 家庭の行を押さえて fn を走らせる。同じ家庭の書き込みは一列に並ぶ（§7.3 の 2）。 */
  withHousehold<T>(householdId: string, fn: (log: HouseholdLog) => T | Promise<T>): Promise<T>;
  has(householdId: string): boolean;
}

interface MemoryHousehold {
  events: DomainEvent[];
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
} {
  const households = new Map<string, MemoryHousehold>();
  const create = (householdId: string, events: readonly DomainEvent[]) => {
    households.set(householdId, {
      events: [...events].sort((a, b) => a.seq - b.seq),
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
      };
      const run = household.tail.then(() => fn(log));
      // 失敗しても、次の書き込みは待たせない。
      household.tail = run.catch(() => undefined);
      return run;
    },
  };
}
