// 知らせの仕事（02-foundation §5.7・§9）：出すべき物を、本人の端末に、同じ回は一度だけ送り、事業者が
// 受け付けた事だけを記録する。回は、書き込みのまとまりごとに事象を再生して数える（見回りの合間に、
// 消えてまた出ても落とさない）。送る先は偽の送り手（本物の Push の事業者には送らない）。
import { type Command, NOTIFICATION_TEXT, proposalSnapshot } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { nowIn } from '../src/clock';
import { runCommand } from '../src/commands';
import { identities, members, notificationIntents, pushSubscriptions } from '../src/db/schema';
import type { Db } from '../src/db/store';
import { demoEvents } from '../src/demo';
import { messageGate, sendGate } from '../src/gate';
import { notifier, type SendGate } from '../src/notifier';
import { type PushOutcome, saveSubscription } from '../src/push';
import type { Store } from '../src/store';
import { database, H, seeded } from './pg';

const CARE = 'arr:childCare:n1:i6:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const GAKUDO = `opt:${CARE}:opt-gakudo`;
const ASK = `task:${GRANDMA}:ask`;
// デモの 12/7 の頼む時間（子の居場所の手配の区間）。送ったの記録には、画面で見せた頼む時間を付ける。
const DEMO_WINDOW = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
const ITEM = 'n1:i6';
const endpointOf = (memberId: string) => `https://web.push.apple.com/test-${memberId}`;

async function bind(db: Db, memberId: string) {
  await db.insert(identities).values({
    id: `id-${memberId}`,
    issuer: 'https://team.example.test',
    subject: `sub-${memberId}`,
  });
  await db
    .update(members)
    .set({ identityId: `id-${memberId}` })
    .where(and(eq(members.householdId, H), eq(members.id, memberId)));
}

async function setup(start: string, gate: SendGate = sendGate) {
  const db = await database();
  const store = await seeded(db, H, demoEvents('arrived'));
  for (const memberId of ['a', 'b']) {
    await bind(db, memberId);
    await saveSubscription(db, {
      endpoint: endpointOf(memberId),
      p256dh: 'test-p256dh',
      auth: 'test-auth',
      householdId: H,
      memberId,
      identityId: `id-${memberId}`,
      language: 'ja',
      requestedAt: Date.now(),
    });
  }
  let now = Date.parse(start);
  let outcome: PushOutcome = { status: 'accepted' };
  /** 送る時に一度だけ走らせる（送っている間の、登録の替わりを起こす）。 */
  let during: ((endpoint: string) => Promise<void>) | undefined;
  /** 知らせの仕事が家庭を押さえて読んだ後に一度だけ走らせる（確かめた後・書く前の替わりを起こす）。 */
  let afterLock: (() => Promise<void>) | undefined;
  const watched: Store = {
    async withHousehold(householdId, fn) {
      const result = await store.withHousehold(householdId, fn);
      const hook = afterLock;
      afterLock = undefined;
      await hook?.();
      return result;
    },
  };
  const sent: { to: string; title: string; body: string; ttlSeconds: number }[] = [];
  const reports: string[] = [];
  const make = () =>
    notifier({
      db,
      store: watched,
      appVersion: 'test-version',
      gate,
      messageGate,
      clock: () => now,
      report: (message) => reports.push(message),
      send: async (target, payload, { ttlSeconds }) => {
        sent.push({ to: target.endpoint, title: payload.title, body: payload.body, ttlSeconds });
        const hook = during;
        during = undefined;
        await hook?.(target.endpoint);
        return outcome;
      },
    });
  let operation = 0;
  return {
    db,
    store,
    jobs: make(),
    /** 止まって起き直した、新しい知らせの仕事。 */
    restart: make,
    sent,
    reports,
    at: (iso: string) => {
      now = Date.parse(iso);
    },
    respond: (next: PushOutcome) => {
      outcome = next;
    },
    whileSending: (hook: (endpoint: string) => Promise<void>) => {
      during = hook;
    },
    afterLock: (hook: () => Promise<void>) => {
      afterLock = hook;
    },
    command: async (memberId: string, command: Command) => {
      operation += 1;
      const result = await runCommand(
        store,
        H,
        {
          memberId,
          identityId: `id-${memberId}`,
          operationId: `op-${operation}`,
          now: nowIn('Asia/Tokyo', now),
          demo: false,
        },
        command,
      );
      expect(result.status, JSON.stringify(command)).toBe('ok');
    },
    shown: async (taskKey: string) => {
      const events = await store.withHousehold(H, (log) => [...log.events()]);
      const task = computePlan(events, nowIn('Asia/Tokyo', now)).tasks.find(
        (t) => t.key === taskKey,
      );
      const snapshot = task && proposalSnapshot(task);
      if (!snapshot) throw new Error(`置けていない：${taskKey}`);
      return snapshot;
    },
    notified: () =>
      store.withHousehold(H, (log) =>
        log.events().flatMap((e) => (e.type === 'notified' ? [e] : [])),
      ),
    rows: () => db.select().from(notificationIntents).where(eq(notificationIntents.householdId, H)),
  };
}

describe('知らせの仕事', () => {
  it('決め時の前の日：二人に一通ずつ送り、受け付けを記録する。同じ回は二度送らない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    await t.jobs.run(H);
    expect(t.sent.map((s) => s.to).sort()).toEqual([endpointOf('a'), endpointOf('b')]);
    expect(t.sent.every((s) => s.title === 'まにあう')).toBe(true);
    expect(t.sent.every((s) => s.body === NOTIFICATION_TEXT.ja['notify.decide'])).toBe(true);
    // 事業者に持たせるのは最長24時間（期限の 11/30 17:20 は、それより先）。
    expect(t.sent[0]?.ttlSeconds).toBe(24 * 3600);
    const notified = await t.notified();
    expect(notified.map((e) => e.toMemberId).sort()).toEqual(['a', 'b']);
    for (const e of notified) {
      expect(e.actorId).toBe('system');
      expect(e.notificationKey).toBe(`decide:${CARE}:${GAKUDO}:${e.toMemberId}#1`);
      expect(e).toMatchObject({
        channel: 'webPush',
        result: 'accepted',
        kind: 'decisionApproaching',
        content: { titleKey: 'notify.decide', params: {} },
        appVersion: 'test-version',
      });
    }
    t.at('2026-11-29T16:05+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
    expect(await t.notified()).toHaveLength(2);
  });

  it('夜は朝まで待てる物を待ち、7時に送る', async () => {
    const t = await setup('2026-11-29T23:30+09:00');
    await t.jobs.run(H);
    expect(t.sent).toEqual([]);
    expect((await t.rows()).map((r) => r.state)).toEqual(['pending', 'pending']);
    t.at('2026-11-30T07:00+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
  });

  it('頼まれた人にはすぐ。断って頼み直されたら、見回りの合間（同じ分）でも次の回として知らせる', async () => {
    const t = await setup('2026-11-25T19:40+09:00');
    await t.jobs.run(H);
    expect(t.sent).toEqual([]);
    // 彩が祖母の案を選び、祖母に頼む作業を健太に頼む。
    await t.command('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'a',
    });
    await t.jobs.run(H);
    expect(t.sent.map((s) => [s.to, s.body])).toEqual([
      [endpointOf('a'), NOTIFICATION_TEXT.ja['notify.proposal']],
    ]);
    // 健太が断り、彩が同じ分にもう一度頼む。その間に見回りは走らない。
    await t.command('a', { type: 'commitment', taskKey: ASK, action: 'decline' });
    await t.command('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'a' });
    await t.jobs.run(H);
    expect(t.sent.map((s) => s.to)).toEqual([endpointOf('a'), endpointOf('a')]);
    expect((await t.notified()).map((e) => e.notificationKey)).toEqual([
      `proposal:${ASK}:a#1`,
      `proposal:${ASK}:a#2`,
    ]);
  });

  it('取り消しの札が、消えてまた出たら（同じ分の書き込みでも）、次の回として知らせる', async () => {
    const t = await setup('2026-11-25T19:40+09:00');
    await t.command('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'b',
    });
    await t.command('b', { type: 'accept', taskKey: ASK, shown: await t.shown(ASK) });
    await t.command('b', {
      type: 'recordSent',
      taskKey: ASK,
      requestId: 'r-1',
      window: DEMO_WINDOW,
    });
    await t.jobs.run(H);
    expect(t.sent).toEqual([]);
    // うちの子に関係ないと外すと、頼んだ依頼が要らなくなる。
    await t.command('b', { type: 'dismissItem', itemId: ITEM, reason: 'notOurs' });
    await t.jobs.run(H);
    expect(t.sent.map((s) => [s.to, s.body])).toEqual([
      [endpointOf('b'), NOTIFICATION_TEXT.ja['notify.cancel']],
    ]);
    // 戻して（確かめて）、また外す。見回りは、その後に一度だけ。
    await t.command('b', { type: 'confirmItem', itemId: ITEM });
    await t.command('b', { type: 'dismissItem', itemId: ITEM, reason: 'notOurs' });
    await t.jobs.run(H);
    expect((await t.notified()).map((e) => e.notificationKey)).toEqual([
      'cancel:r-1:b#1',
      'cancel:r-1:b#2',
    ]);
  });

  it('回を数えた後・送る前に、札が消えてまた出たら、前の回は送らず、数え直した回だけを送る', async () => {
    const t = await setup('2026-11-25T19:40+09:00');
    await t.command('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'b',
    });
    await t.command('b', { type: 'accept', taskKey: ASK, shown: await t.shown(ASK) });
    await t.command('b', {
      type: 'recordSent',
      taskKey: ASK,
      requestId: 'r-1',
      window: DEMO_WINDOW,
    });
    await t.command('b', { type: 'dismissItem', itemId: ITEM, reason: 'notOurs' });
    // 取り消しの一回目を数えた後、送る前の確かめの前に、戻して（確かめて）また外す。
    t.afterLock(async () => {
      await t.command('b', { type: 'confirmItem', itemId: ITEM });
      await t.command('b', { type: 'dismissItem', itemId: ITEM, reason: 'notOurs' });
    });
    await t.jobs.run(H);
    expect(t.sent).toEqual([]);
    expect((await t.rows()).map((r) => [r.key, r.round, r.state, r.attempts])).toEqual([
      ['cancel:r-1:b', 1, 'pending', 0],
    ]);
    // 次のまわしで数え直し、二回目として一度だけ送る。
    await t.jobs.run(H);
    expect(t.sent.map((s) => [s.to, s.body])).toEqual([
      [endpointOf('b'), NOTIFICATION_TEXT.ja['notify.cancel']],
    ]);
    expect((await t.notified()).map((e) => e.notificationKey)).toEqual(['cancel:r-1:b#2']);
  });

  it('同じ大人に同時にいくつも出れば、件数の文で一通にまとめ、意図ごとに記録する', async () => {
    const t = await setup('2026-11-29T21:00+09:00');
    // 学童の案を選び、手順を健太に頼む（記入と提出）。
    await t.command('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GAKUDO,
      role: 'primary',
      assigneeId: 'a',
    });
    await t.jobs.run(H);
    const toA = t.sent.filter((s) => s.to === endpointOf('a'));
    expect(toA).toHaveLength(1);
    const notifiedA = (await t.notified()).filter((e) => e.toMemberId === 'a');
    expect(notifiedA.length).toBeGreaterThan(1);
    expect(toA[0]?.body).toBe(`確かめてほしいことが ${notifiedA.length} 件あります。`);
    for (const e of notifiedA) {
      expect(e.content).toEqual({
        titleKey: 'notify.many',
        params: { count: String(notifiedA.length) },
      });
    }
  });

  it('登録先が無くなったら（410）、登録を消し、送ったと記録しない。次の登録を待つ', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    // Postgres の時刻はマイクロ秒まで持つ（プログラムの時刻はミリ秒）。登録の版は時刻で比べない。
    await t.db.execute(
      sql`update push_subscriptions set created_at = '2026-11-29T15:00:00.123456+09:00'`,
    );
    t.respond({ status: 'gone' });
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
    expect(await t.notified()).toEqual([]);
    expect(await t.db.select().from(pushSubscriptions)).toEqual([]);
    expect((await t.rows()).map((r) => r.state)).toEqual(['pending', 'pending']);
  });

  it('送れなければ間を置いて試し直し、三回であきらめる。記録はしない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    t.respond({ status: 'failed', reason: 'http-500' });
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
    // 間の前は試さない。
    t.at('2026-11-29T16:00:30+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
    t.at('2026-11-29T16:01+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(4);
    t.at('2026-11-29T16:06+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(6);
    t.at('2026-11-29T16:20+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(6);
    expect((await t.rows()).map((r) => [r.state, r.attempts, r.lastError])).toEqual([
      ['failed', 3, 'http-500'],
      ['failed', 3, 'http-500'],
    ]);
    expect(await t.notified()).toEqual([]);
    expect(t.reports.every((m) => !m.includes('web.push.apple.com'))).toBe(true);
  });

  it('身元を外された大人には送らず、その登録を消す', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    await t.db
      .update(identities)
      .set({ removedAt: new Date('2026-11-29T15:00+09:00') })
      .where(eq(identities.id, 'id-a'));
    await t.jobs.run(H);
    expect(t.sent.map((s) => s.to)).toEqual([endpointOf('b')]);
    expect((await t.db.select().from(pushSubscriptions)).map((s) => s.memberId)).toEqual(['b']);
  });

  it('外された身元の登録を消す間に、同じ端末で別の大人が登録し直した物は消さない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    await t.db
      .update(identities)
      .set({ removedAt: new Date('2026-11-29T15:00+09:00') })
      .where(eq(identities.id, 'id-a'));
    // 健太（a）の登録を「外された」と確かめた後、消す前に、同じ端末で彩（b）が登録し直す。
    t.afterLock(async () => {
      await saveSubscription(t.db, {
        endpoint: endpointOf('a'),
        p256dh: 'test-p256dh',
        auth: 'test-auth',
        householdId: H,
        memberId: 'b',
        identityId: 'id-b',
        language: 'ja',
        requestedAt: Date.now(),
      });
    });
    await t.jobs.run(H);
    const left = await t.db.select().from(pushSubscriptions);
    expect(left.map((s) => [s.endpoint, s.memberId])).toEqual([[endpointOf('a'), 'b']]);
    // 古く読んだ登録先（彩の前の端末）には送らず、次のまわしで、彩が今使う端末に送る。
    expect(t.sent).toEqual([]);
    await t.jobs.run(H);
    expect(t.sent.map((s) => s.to)).toEqual([endpointOf('a')]);
    expect((await t.notified()).map((e) => e.toMemberId)).toEqual(['b']);
  });

  it('検証器が違反を見つけたら、どの知らせに響くか絞れないので、その家庭の知らせを全部止める', async () => {
    const stop: SendGate = () => ({ all: true, blocked: new Set(), codes: ['test_violation'] });
    const t = await setup('2026-11-29T16:00+09:00', stop);
    await t.jobs.run(H);
    expect(t.sent).toEqual([]);
    expect(await t.notified()).toEqual([]);
    expect((await t.rows()).map((r) => [r.state, r.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
    ]);
    expect(t.reports.some((m) => m.includes('test_violation'))).toBe(true);
  });

  it('止まって起き直しても、見た所の続きから数える（同じ回を二度送らない）', async () => {
    const t = await setup('2026-11-25T19:40+09:00');
    await t.command('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'a',
    });
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(1);
    const again = t.restart();
    await again.run(H);
    expect(t.sent).toHaveLength(1);
    await t.command('a', { type: 'commitment', taskKey: ASK, action: 'decline' });
    await t.command('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'a' });
    await again.run(H);
    expect(t.sent).toHaveLength(2);
  });

  it('期限の間際は、残りの時間しか事業者に持たせない', async () => {
    const t = await setup('2026-11-30T17:19:30+09:00');
    await t.jobs.run(H);
    expect(t.sent.map((s) => s.ttlSeconds)).toEqual([30, 30]);
  });

  it('二つの工程が同時にまわっても、同じ回を二度数えず、二度送らない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    const other = t.restart();
    await Promise.all([t.jobs.run(H), other.run(H), t.jobs.run(H)]);
    expect(t.sent).toHaveLength(2);
    expect((await t.rows()).map((r) => [r.round, r.state])).toEqual([
      [1, 'sent'],
      [1, 'sent'],
    ]);
    expect(await t.notified()).toHaveLength(2);
  });

  it('送っている間に、一台の iPhone の登録先が別の大人に替わったら、前の人の知らせはその端末に送らない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    // 健太への送り出しの最中に、彩の端末（登録先）で健太がログインして登録し直す。
    t.whileSending(async () => {
      await saveSubscription(t.db, {
        endpoint: endpointOf('b'),
        p256dh: 'test-p256dh',
        auth: 'test-auth',
        householdId: H,
        memberId: 'a',
        identityId: 'id-a',
        language: 'ja',
        requestedAt: Date.now(),
      });
    });
    await t.jobs.run(H);
    // 健太（a）には送ったが、彩（b）の知らせを、今は健太の物になった端末へは送らない。
    expect(t.sent.map((s) => s.to)).toEqual([endpointOf('a')]);
    const notified = await t.notified();
    expect(notified.map((e) => e.toMemberId)).toEqual(['a']);
    expect((await t.rows()).find((r) => r.memberId === 'b')?.state).toBe('pending');
  });

  it('登録先が無くなった時、その間に別の大人が登録し直した物は消さない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    t.respond({ status: 'gone' });
    // 健太の端末への送り出しが「無い」と返る間に、同じ登録先で彩が登録し直す。
    t.whileSending(async (endpoint) => {
      await saveSubscription(t.db, {
        endpoint,
        p256dh: 'test-p256dh',
        auth: 'test-auth',
        householdId: H,
        memberId: 'b',
        identityId: 'id-b',
        language: 'ja',
        requestedAt: Date.now(),
      });
    });
    await t.jobs.run(H);
    const left = await t.db.select().from(pushSubscriptions);
    expect(left.map((s) => [s.endpoint, s.memberId])).toEqual([[endpointOf('a'), 'b']]);
  });

  it('引き受けの期限が切れて別の工程が送った後に、古い工程が失敗を返しても、送った回を戻さない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    // 彩の登録を外し、健太の一通だけにする。
    await t.db.delete(pushSubscriptions).where(eq(pushSubscriptions.memberId, 'b'));
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 一つ目の工程は、送っている途中で止まる。
    t.whileSending(() => paused);
    const first = t.jobs.run(H);
    while (t.sent.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    // 引き受けの期限（2分）が過ぎ、二つ目の工程が引き受け直して送り、記録する。
    t.at('2026-11-29T16:03+09:00');
    const second = t.restart();
    await second.run(H);
    expect(t.sent).toHaveLength(2);
    expect(await t.notified()).toHaveLength(1);
    // 一つ目の工程が、遅れて失敗を返す。
    t.respond({ status: 'failed', reason: 'network' });
    release();
    await first;
    // 健太の回は送ったまま（彩の分は、登録先が無いので送る待ちのまま）。
    const state = Object.fromEntries((await t.rows()).map((r) => [r.memberId, r.state]));
    expect(state).toEqual({ a: 'sent', b: 'pending' });
    t.respond({ status: 'accepted' });
    t.at('2026-11-29T16:10+09:00');
    await t.restart().run(H);
    expect(t.sent).toHaveLength(2);
  });

  it('受け付けを記録した後、状態を替える前に止まっても、起き直した時に同じ回を送り直さない', async () => {
    const t = await setup('2026-11-29T16:00+09:00');
    await t.jobs.run(H);
    expect(t.sent).toHaveLength(2);
    // 記録の後、行を「送った」にする前に止まった形にする（送っている・引き受けの期限切れ）。
    await t.db
      .update(notificationIntents)
      .set({ state: 'sending', leaseUntil: new Date('2026-11-29T16:01+09:00'), leaseToken: 'gone' })
      .where(eq(notificationIntents.householdId, H));
    t.at('2026-11-29T16:05+09:00');
    await t.restart().run(H);
    expect(t.sent).toHaveLength(2);
    expect((await t.rows()).map((r) => r.state)).toEqual(['sent', 'sent']);
  });
});
