// 知らせの仕事（02-foundation §5.7・§9）。サーバーのプロセスの中で、起動の時・5分ごと・家族の書き込み
// の後に、家庭ごとに今の計画を作り、知らせの決まり（core の純粋な関数）で出すべき物を出して送る。
//
// 回の数え方：前に見た所から、書き込みのまとまりごとに事象を再生し、無かったキーが出た時に回を一つ
// 進める（見回りの合間に、消えてまた出ても落とさない）。同じ回の間は一度だけ送る。
// 送る前に：期限付きで引き受け、家庭を押さえて作り直し、取り消し・担当・期限・身元の結びと、検証器の
// 結果を確かめる。事業者が受け付けたら、仕組み（system）が notified（キー#回）を足す。受け付けの後、
// 記録の前に止まると、二度届くことがある。

import { randomUUID } from 'node:crypto';
import {
  type DateTime,
  type DomainEvent,
  type Household,
  holdUntilMorning,
  type NotificationIntent,
  type NotificationLanguage,
  notificationHistory,
  notificationIntents,
  notificationMessage,
  type PlanResult,
  toEpochMinutes,
} from '@maniau/core';
import { foldEvents, planFromState } from '@maniau/core/engine';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { nowIn } from './clock';
import { households, notificationIntents as intents, pushSubscriptions } from './db/schema';
import { type Db, postgresStore } from './db/store';
import type { PushSender } from './push';
import type { EventBody, HouseholdLog, Store } from './store';

export const NOTIFY_INTERVAL_MS = 5 * 60_000;
/** 書き込みの後、続く書き込みをまとめるために待つ時間。 */
const POKE_DELAY_MS = 1_000;
const LEASE_MS = 2 * 60_000;
/** 一つの回を試す回数。失敗の後は、この間隔を置く。 */
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = [60_000, 5 * 60_000];
/** 事業者が、届かない端末のために持っておく時間（期限が無ければ）。 */
const DEFAULT_TTL_S = 12 * 3600;
const MAX_TTL_S = 24 * 3600;

/** 送る前の確かめ（検証器）に渡す物。 */
export interface GateInput {
  household: Household;
  plan: PlanResult;
  events: readonly DomainEvent[];
  batchEnds: readonly number[];
  intents: readonly NotificationIntent[];
}
export interface GateResult {
  /** 全部を止める（どの知らせに響くか絞れない違反）。 */
  all: boolean;
  /** 止める意図のキー。 */
  blocked: ReadonlySet<string>;
  /** 記録する種類（中身は入れない）。 */
  codes: readonly string[];
}
export type SendGate = (input: GateInput) => GateResult;
/** 実際に送る文の確かめ（決まった文か）。 */
export type MessageGate = (input: {
  language: NotificationLanguage;
  message: ReturnType<typeof notificationMessage>;
  intents: readonly NotificationIntent[];
}) => { ok: boolean; codes: readonly string[] };

export interface NotifierDeps {
  db: Db;
  store: Store;
  send: PushSender;
  /** 送った時のアプリの版（notified に残す）。 */
  appVersion: string;
  gate: SendGate;
  messageGate?: MessageGate;
  /** 今の時刻（ミリ秒。試験で替える）。 */
  clock?: () => number;
  /** 失敗の記録。家庭の ID と種類だけを渡す（中身・URL・名前は渡さない）。 */
  report?: (message: string) => void;
}

export interface Notifier {
  /** 一回まわす（一つの家庭、または全部の有効な家庭）。 */
  run(householdId?: string): Promise<void>;
  /** 家族の書き込みの後に呼ぶ。少し待って、まとめて一回まわす。 */
  poke(householdId: string): void;
  /** 起動の時に一回、その後5分ごとにまわす。止める関数を返す。 */
  start(): () => void;
}

interface Derived {
  household: Household;
  plan: PlanResult;
  intents: Map<string, NotificationIntent>;
}

/** 事象の列（の頭から）と時刻から、出すべき知らせを作る（成員の表で外した大人を除く）。 */
function derive(
  events: readonly DomainEvent[],
  now: DateTime,
  isActive: (memberId: string) => boolean,
): Derived | undefined {
  const state = foldEvents(events);
  const household = state.household;
  if (!household) return undefined;
  const plan = planFromState(state, now);
  const list = notificationIntents(plan, household, notificationHistory(events)).filter((i) =>
    isActive(i.toMemberId),
  );
  return { household, plan, intents: new Map(list.map((i) => [i.key, i])) };
}

/**
 * 前に見た所（cursor）より後の、書き込みのまとまりごとに再生して、キーが無い所から出た回数を数える。
 * 最後に今の時刻で作り直す。cursor が無ければ（初めて）、今の形だけを見る。
 */
function observe(
  log: HouseholdLog,
  at: number,
  cursor: number | null,
  present: ReadonlySet<string>,
): { current: Derived; appeared: Map<string, number>; through: number } | undefined {
  const events = log.events();
  const isActive = (memberId: string) => log.isActiveAdult?.(memberId) ?? true;
  const appeared = new Map<string, number>();
  let seen = new Set(present);
  const step = (keys: Iterable<string>) => {
    const next = new Set(keys);
    for (const key of next) if (!seen.has(key)) appeared.set(key, (appeared.get(key) ?? 0) + 1);
    seen = next;
  };
  if (cursor !== null) {
    const ends = (log.batchEnds?.() ?? events.map((e) => e.seq)).filter((end) => end > cursor);
    for (const end of ends) {
      const prefix = events.filter((e) => e.seq <= end);
      const last = prefix.at(-1);
      if (!last) continue;
      const then = derive(prefix, last.recordedAt, isActive);
      if (then) step(then.intents.keys());
    }
  }
  const household = foldEvents(events).household;
  if (!household) return undefined;
  const current = derive(events, nowIn(household.timeZone, at), isActive);
  if (!current) return undefined;
  step(current.intents.keys());
  return { current, appeared, through: events.at(-1)?.seq ?? 0 };
}

const toDate = (value: DateTime) => new Date(toEpochMinutes(value) * 60_000);
const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

export function notifier(deps: NotifierDeps): Notifier {
  const { db, store, send, gate } = deps;
  const clock = deps.clock ?? Date.now;
  const report = deps.report ?? (() => {});
  /** 同じ家庭のまわしを重ねない（一つのプロセスから送る。§9）。 */
  const running = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 自分が引き受けた回の状態を替える。自分の札で、今も送っている行だけ（期限が切れて別の工程が引き
   * 受け直した行や、次の回に進んだ行は触らない）。
   */
  const settle = (
    householdId: string,
    token: string,
    rows: readonly { key: string; round: number }[],
    change: PgUpdateSetSource<typeof intents>,
  ) =>
    Promise.all(
      rows.map((r) =>
        db
          .update(intents)
          .set({ ...change, leaseUntil: null, leaseToken: null, updatedAt: new Date(clock()) })
          .where(
            and(
              eq(intents.householdId, householdId),
              eq(intents.key, r.key),
              eq(intents.round, r.round),
              eq(intents.state, 'sending'),
              eq(intents.leaseToken, token),
            ),
          ),
      ),
    );

  /**
   * 事象を見て、回と、出ているかを表に書く。見た位置・意図の表を読み、再生し、書き戻すまでを一つの
   * トランザクションで行い、家庭の行を押さえる（命令とも、別のプロセスの知らせの仕事とも重ならず、
   * 同じ回を二度数えない）。
   */
  function record(
    householdId: string,
    at: number,
  ): Promise<(Derived & { through: number }) | undefined> {
    return db.transaction(async (tx) => {
      const [home] = await tx
        .select({ cursor: households.notifiedThroughSeq })
        .from(households)
        .where(eq(households.id, householdId))
        .for('update');
      if (!home) return undefined;
      const rows = await tx.select().from(intents).where(eq(intents.householdId, householdId));
      const present = new Set(rows.filter((r) => r.present).map((r) => r.key));
      const seen = await postgresStore(tx).withHousehold(householdId, (log) =>
        observe(log, at, home.cursor, present),
      );
      if (!seen) return undefined;
      const { current, appeared, through } = seen;
      const nowDate = new Date(at);
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const leased = (r: (typeof rows)[number]) =>
        r.state === 'sending' && r.leaseUntil !== null && r.leaseUntil > nowDate;
      for (const [key, count] of appeared) {
        const row = byKey.get(key);
        const intent = current.intents.get(key);
        // 新しい回：今も出ていれば送る待ち。もう消えていれば、送らずに閉じる。
        const fresh = {
          round: (row?.round ?? 0) + count,
          present: intent !== undefined,
          state: intent ? ('pending' as const) : ('dropped' as const),
          attempts: 0,
          notBefore: null,
          lastError: null,
          leaseUntil: null,
          leaseToken: null,
          updatedAt: nowDate,
          ...(intent ? { until: intent.until ? toDate(intent.until) : null } : {}),
        };
        if (row) {
          await tx
            .update(intents)
            .set(fresh)
            .where(and(eq(intents.householdId, householdId), eq(intents.key, key)));
        } else if (intent) {
          await tx.insert(intents).values({
            householdId,
            key,
            memberId: intent.toMemberId,
            kind: intent.kind,
            ...fresh,
          });
        }
      }
      // 回が進まずに消えた物：出ていない印を付け、まだ送っていなければ閉じる。
      for (const row of rows) {
        if (appeared.has(row.key) || !row.present || current.intents.has(row.key)) continue;
        const open = row.state === 'pending' || (row.state === 'sending' && !leased(row));
        await tx
          .update(intents)
          .set({
            present: false,
            updatedAt: nowDate,
            ...(open ? { state: 'dropped' as const, leaseUntil: null, leaseToken: null } : {}),
          })
          .where(and(eq(intents.householdId, householdId), eq(intents.key, row.key)));
      }
      await tx
        .update(households)
        .set({ notifiedThroughSeq: through })
        .where(eq(households.id, householdId));
      return { ...current, through };
    });
  }

  async function runHousehold(householdId: string): Promise<void> {
    const at = clock();
    const nowDate = new Date(at);
    const current = await record(householdId, at);
    if (!current) return;

    // 登録先と、登録した身元が今も結ばれているか。外された身元の登録は消す。
    const subscriptions = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.householdId, householdId));
    const unbound = await store.withHousehold(householdId, (log) =>
      subscriptions.filter((s) => !(log.isBound?.(s.memberId, s.identityId) ?? false)),
    );
    if (unbound.length > 0) {
      // 読んだ時の登録（同じ版の物）だけを消す。その後に同じ端末で登録し直された物は消さない。
      await db
        .delete(pushSubscriptions)
        .where(
          or(
            ...unbound.map((s) =>
              and(
                eq(pushSubscriptions.endpoint, s.endpoint),
                eq(pushSubscriptions.registration, s.registration),
              ),
            ),
          ),
        );
    }
    const bound = new Map(
      subscriptions.filter((s) => !unbound.includes(s)).map((s) => [s.memberId, s] as const),
    );

    const free = () =>
      or(
        eq(intents.state, 'pending'),
        and(eq(intents.state, 'sending'), lt(intents.leaseUntil, nowDate)),
      );
    const open = await db
      .select()
      .from(intents)
      .where(and(eq(intents.householdId, householdId), eq(intents.present, true), free()))
      .orderBy(intents.key);
    const nowMin = Math.floor(at / 60_000);
    const sendable = open.filter((r) => {
      const intent = current.intents.get(r.key);
      if (!intent || !bound.has(r.memberId)) return false;
      if (r.notBefore && r.notBefore > nowDate) return false;
      // 夜は、朝まで待てる物を待つ。
      return holdUntilMorning(intent, nowMin, current.household.timeZone) === undefined;
    });
    if (sendable.length === 0) return;
    // 引き受ける（他のまわしと同じ物を送らない）。この引き受けの札を付ける。
    const token = randomUUID();
    const leased = (
      await Promise.all(
        sendable.map((r) =>
          db
            .update(intents)
            .set({
              state: 'sending',
              leaseUntil: new Date(at + LEASE_MS),
              leaseToken: token,
              attempts: sql`${intents.attempts} + 1`,
              updatedAt: nowDate,
            })
            .where(
              and(
                eq(intents.householdId, householdId),
                eq(intents.key, r.key),
                eq(intents.round, r.round),
                free(),
              ),
            )
            .returning({
              key: intents.key,
              round: intents.round,
              memberId: intents.memberId,
              attempts: intents.attempts,
            }),
        ),
      )
    ).flat();
    if (leased.length === 0) return;

    // 送る直前に、押さえて作り直す（取り消し・担当・期限、身元の結び、検証器）。
    const sendAt = clock();
    const checked = await store.withHousehold(householdId, (log) => {
      const events = log.events();
      // 回を数えた後に家族の書き込みがあれば、その間に消えてまた出た（次の回になった）かもしれない。
      // 今は送らず、次のまわし（その書き込みが起こす）で数え直してから送る。知らせの記録だけの書き
      // 込みは、意図を変えないので数えない。
      if (events.some((e) => e.seq > current.through && e.type !== 'notified')) return undefined;
      const again = derive(
        events,
        nowIn(current.household.timeZone, sendAt),
        (memberId) => log.isActiveAdult?.(memberId) ?? true,
      );
      const verdict = again
        ? gate({
            household: again.household,
            plan: again.plan,
            events,
            batchEnds: log.batchEnds?.() ?? events.map((e) => e.seq),
            intents: [...again.intents.values()],
          })
        : undefined;
      // この回を、もう別の工程が送って記録していれば、送らない。
      const notified = foldEvents(events).notified;
      return leased.map((r) => {
        const sub = bound.get(r.memberId);
        const stillBound =
          sub !== undefined && (log.isBound?.(r.memberId, sub.identityId) ?? false);
        const intent = again?.intents.get(r.key);
        const stopped = !verdict || verdict.all || verdict.blocked.has(r.key);
        const recorded = notified.has(`${r.key}#${r.round}`);
        return { ...r, intent, stillBound, stopped, recorded, codes: verdict?.codes ?? [] };
      });
    });
    if (!checked) {
      await settle(householdId, token, leased, {
        state: 'pending',
        attempts: sql`${intents.attempts} - 1`,
      });
      return;
    }
    await settle(
      householdId,
      token,
      checked.filter((r) => r.recorded),
      { state: 'sent' },
    );
    const codes = [...new Set(checked.flatMap((r) => (r.stopped ? r.codes : [])))];
    if (codes.length > 0) report(`知らせを止めた（検証）：${householdId} ${codes.join(',')}`);
    // 結びが外れた・検証で止めた物は、送る待ちに戻す（次のまわしで確かめ直す）。もう出すべきでない物は
    // 閉じる。
    const unsent = checked.filter((r) => !r.recorded);
    await settle(
      householdId,
      token,
      unsent.filter((r) => r.intent && (!r.stillBound || r.stopped)),
      { state: 'pending', attempts: sql`${intents.attempts} - 1` },
    );
    await settle(
      householdId,
      token,
      unsent.filter((r) => !r.intent),
      { state: 'dropped' },
    );
    const ready = unsent.flatMap((r) =>
      r.intent && r.stillBound && !r.stopped ? [{ ...r, intent: r.intent }] : [],
    );

    // 大人ごとに一通にまとめて送る。
    const byMember = new Map<string, typeof ready>();
    for (const r of ready) byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r]);
    for (const [memberId, batch] of byMember) {
      const loaded = bound.get(memberId);
      if (!loaded) continue;
      // 送る直前に、登録先がまだこの大人の、同じ登録の物かを確かめる（一台の iPhone で使う人が替わり、
      // 登録し直されていれば送らない）。登録ごとの版で比べる。送る事と記録は一つにできないので、この
      // 間の替わりまでは防げない（ロック画面の文に名前を入れず、開いた時に今の身元で確かめる）。
      const [sub] = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, loaded.endpoint));
      if (
        !sub ||
        sub.householdId !== householdId ||
        sub.memberId !== memberId ||
        sub.identityId !== loaded.identityId ||
        sub.registration !== loaded.registration
      ) {
        await settle(householdId, token, batch, {
          state: 'pending',
          attempts: sql`${intents.attempts} - 1`,
        });
        continue;
      }
      const shown = batch.map((r) => r.intent);
      const message = notificationMessage(sub.language, shown);
      const messageCheck = deps.messageGate?.({ language: sub.language, message, intents: shown });
      if (messageCheck && !messageCheck.ok) {
        report(`知らせを止めた（文）：${householdId} ${messageCheck.codes.join(',')}`);
        await settle(householdId, token, batch, {
          state: 'pending',
          attempts: sql`${intents.attempts} - 1`,
        });
        continue;
      }
      // 事業者に持たせるのは、期限までの残りだけ（それより長く持たせて、期限の後に出さない）。
      const untils = shown.flatMap((i) => (i.until ? [toDate(i.until).getTime()] : []));
      const left = untils.length === 0 ? undefined : Math.min(...untils) - clock();
      if (left !== undefined && left <= 0) {
        await settle(householdId, token, batch, { state: 'dropped' });
        continue;
      }
      const ttlSeconds =
        left === undefined ? DEFAULT_TTL_S : Math.min(MAX_TTL_S, Math.floor(left / 1000));
      const outcome = await send(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        { title: message.title, body: message.body, tag: 'maniau', url: '/' },
        { ttlSeconds },
      );
      if (outcome.status === 'accepted') {
        // 事業者が受け付けた事だけを記録する（届いた・読んだの証拠にしない）。
        const params: Record<string, string> =
          message.count > 1 ? { count: String(message.count) } : {};
        const content = { titleKey: message.titleKey, params };
        await store.withHousehold(householdId, (log) => {
          const notified = foldEvents(log.events()).notified;
          const bodies: EventBody[] = batch
            .map((r) => ({ ...r, notificationKey: `${r.key}#${r.round}` }))
            .filter((r) => !notified.has(r.notificationKey))
            .map((r) => ({
              type: 'notified',
              notificationKey: r.notificationKey,
              toMemberId: memberId,
              channel: 'webPush',
              result: 'accepted',
              kind: r.intent.kind,
              content,
              appVersion: deps.appVersion,
            }));
          if (bodies.length > 0) {
            log.append(bodies, 'system', nowIn(current.household.timeZone, clock()));
          }
        });
        await settle(householdId, token, batch, { state: 'sent', lastError: null });
        continue;
      }
      if (outcome.status === 'gone') {
        // 登録先が無くなった。その登録（同じ版の物）だけを消し、意図は次の登録を待つ。その間に登録
        // し直された物は消さない。
        await db
          .delete(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.endpoint, sub.endpoint),
              eq(pushSubscriptions.registration, sub.registration),
            ),
          );
        await settle(householdId, token, batch, { state: 'pending', lastError: 'gone' });
        continue;
      }
      report(`知らせを送れなかった：${householdId} ${outcome.reason}`);
      for (const r of batch) {
        const wait = RETRY_AFTER_MS[r.attempts - 1];
        await settle(
          householdId,
          token,
          [r],
          r.attempts >= MAX_ATTEMPTS || wait === undefined
            ? { state: 'failed', lastError: outcome.reason }
            : { state: 'pending', lastError: outcome.reason, notBefore: new Date(clock() + wait) },
        );
      }
    }
  }

  const runOne = (householdId: string): Promise<void> => {
    const previous = running.get(householdId) ?? Promise.resolve();
    const next = previous
      .then(() => runHousehold(householdId))
      .catch((error: unknown) => {
        // 中身を出さない（エンジンの誤りの文に、家族の物が入ることがある）。
        report(`知らせの仕事に失敗：${householdId} ${errorName(error)}`);
      });
    running.set(householdId, next);
    return next.finally(() => {
      if (running.get(householdId) === next) running.delete(householdId);
    });
  };

  async function run(householdId?: string): Promise<void> {
    if (householdId !== undefined) return runOne(householdId);
    const active = await db
      .select({ id: households.id })
      .from(households)
      .where(eq(households.status, 'active'));
    for (const { id } of active) await runOne(id);
  }

  return {
    run,
    poke(householdId) {
      if (timers.has(householdId)) return;
      timers.set(
        householdId,
        setTimeout(() => {
          timers.delete(householdId);
          void runOne(householdId);
        }, POKE_DELAY_MS),
      );
    },
    start() {
      const tick = () =>
        void run().catch((error: unknown) => report(`知らせの仕事に失敗：${errorName(error)}`));
      tick();
      const interval = setInterval(tick, NOTIFY_INTERVAL_MS);
      return () => {
        clearInterval(interval);
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      };
    },
  };
}
