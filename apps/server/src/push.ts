// Web Push の送り手と登録先（02-foundation §9）。中身は暗号にして、Push の事業者に渡すだけ。届いた・
// 読んだは分からない（事業者が受け付けた事だけが分かる）。
import { randomUUID } from 'node:crypto';
import { and, eq, gt, ne, or } from 'drizzle-orm';
import webpush from 'web-push';
import { pushSubscriptions } from './db/schema';
import type { Db } from './db/store';

/** VAPID の鍵（.env にだけ置く。公開鍵は画面に渡す）。 */
export interface Vapid {
  publicKey: string;
  privateKey: string;
  /** 事業者が困った時の連絡先（mailto: か https:）。 */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** ロック画面に出す物（名前を含まない決まった文だけ）。 */
export interface PushPayload {
  title: string;
  body: string;
  /** 同じ印の前の知らせを置き換える（溜めない）。 */
  tag: string;
  url: string;
}

export type PushOutcome =
  | { status: 'accepted' }
  /** 登録先が無くなった（404・410）。登録を消す。 */
  | { status: 'gone' }
  /** それ以外の失敗。理由は種類だけ（中身や URL は残さない）。 */
  | { status: 'failed'; reason: string };

export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
  options: { ttlSeconds: number },
) => Promise<PushOutcome>;

export function webPushSender(vapid: Vapid): PushSender {
  return async (target, payload, { ttlSeconds }) => {
    try {
      const result = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        { vapidDetails: vapid, TTL: ttlSeconds, urgency: 'high', timeout: 10_000 },
      );
      return result.statusCode >= 200 && result.statusCode < 300
        ? { status: 'accepted' }
        : { status: 'failed', reason: `http-${result.statusCode}` };
    } catch (error) {
      if (error instanceof webpush.WebPushError) {
        if (error.statusCode === 404 || error.statusCode === 410) return { status: 'gone' };
        return { status: 'failed', reason: `http-${error.statusCode}` };
      }
      return { status: 'failed', reason: 'network' };
    }
  };
}

/**
 * 知っている Push の事業者の登録先か。サーバーは登録先の URL へ送るので、家族の画面から来た任意の
 * URL（内部の住所など）へは送らない。
 */
const PUSH_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
] as const;
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

export function isPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_HOSTS.some((h) => host === h) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export interface NewSubscription extends PushTarget {
  householdId: string;
  memberId: string;
  identityId: string;
  language: 'ja' | 'en';
  /** 端末が登録を頼んだ時（その端末の時計のミリ秒）。 */
  requestedAt: number;
}

/**
 * 登録する。同じ登録先を前に使っていた人と、この大人の前の登録先は外す（大人ごとに一つ。一台の
 * iPhone で使う人が替われば、前の人には送らない）。同じ登録先で、後から頼まれた登録が先に済んで
 * いれば、遅れて届いたこの登録は使わない（stale）。
 */
export async function saveSubscription(
  db: Db,
  subscription: NewSubscription,
): Promise<'saved' | 'stale'> {
  return db.transaction(async (tx) => {
    const [newer] = await tx
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, subscription.endpoint),
          or(
            gt(pushSubscriptions.requestedAt, subscription.requestedAt),
            // 同じ時に頼まれた別の人の登録は、どちらが後か分からないので、先に済んだ方を残す。
            and(
              eq(pushSubscriptions.requestedAt, subscription.requestedAt),
              or(
                ne(pushSubscriptions.householdId, subscription.householdId),
                ne(pushSubscriptions.memberId, subscription.memberId),
              ),
            ),
          ),
        ),
      )
      .for('update');
    if (newer) return 'stale';
    await tx
      .delete(pushSubscriptions)
      .where(
        or(
          eq(pushSubscriptions.endpoint, subscription.endpoint),
          and(
            eq(pushSubscriptions.householdId, subscription.householdId),
            eq(pushSubscriptions.memberId, subscription.memberId),
          ),
        ),
      );
    await tx.insert(pushSubscriptions).values({ ...subscription, registration: randomUUID() });
    return 'saved';
  });
}

/** この大人の登録を外す（その登録先の物だけ）。 */
export async function removeSubscription(
  db: Db,
  householdId: string,
  memberId: string,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.householdId, householdId),
        eq(pushSubscriptions.memberId, memberId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    );
}
