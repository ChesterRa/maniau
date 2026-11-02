// API。見る人ごとのデモの家庭（架空の家族。ログインなし）と、家族の家庭（Cloudflare Access の身元。
// Postgres）。どちらも、画面には見せる物だけを渡し、事象の列は渡さない（02-foundation §7.1）。
import { Command } from '@maniau/core';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { ACCESS_HEADER, type AccessVerifier } from './auth/access';
import { nowIn } from './clock';
import { type CommandResult, runCommand } from './commands';
import type { Db } from './db/store';
import { DEMO_STAGES, isDemoStage, loadDemoData } from './demo';
import { demoSessions } from './demo-sessions';
import { type FamilyMember, type Invitations, memberFor } from './members';
import type { Notifier } from './notifier';
import { isPushEndpoint, removeSubscription, saveSubscription } from './push';
import type { Store } from './store';
import { viewFor } from './views';

/** 家族の家庭の置き場所と身元（無ければ、デモだけのサーバー）。 */
export interface FamilyBackend {
  db: Db;
  store: Store;
  verify: AccessVerifier;
  invitations: Invitations;
  /**
   * 画面の公開の Origin（例：https://maniau.example.jp）。ログインは Cookie なので、書き込みは、この
   * Origin から JSON で来た物だけを受ける（§7.3。別のサイトからの書き込みを断る）。
   */
  origin: string;
  /** 今の時刻（ミリ秒。試験で替える）。 */
  clock?: () => number;
  /** 知らせ（VAPID の公開鍵と、書き込みの後に知らせの仕事を起こす口）。無ければ知らせは無い。 */
  push?: { publicKey: string; notifier: Pick<Notifier, 'poke'> };
}

const STATUS = { ok: 200, noop: 200, conflict: 409, forbidden: 403, invalid: 400 } as const;
const statusOf = (result: CommandResult) => STATUS[result.status];

export function createApp(options: { family?: FamilyBackend } = {}): Hono {
  // 起きる時に、デモの家族とお知らせを読み、型と家族の決まりを確かめる（誤りなら起きない）。
  loadDemoData();
  const sessions = demoSessions();
  const { family } = options;
  const app = new Hono();
  // API の返事は、どれも控えに残さない（家族の予定・場所を、端末や途中の控えに置かない）。
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.get('/api/health', (c) => c.json({ ok: true }));

  // 家族の家庭：毎回の要求で Access のトークンを確かめ、成員の表で、今も有効な大人かを引く。
  const memberOf = async (c: Context, backend: FamilyBackend): Promise<FamilyMember | Response> => {
    const identity = await backend.verify(c.req.header(ACCESS_HEADER));
    if (!identity) return c.json({ error: 'unauthenticated' }, 401);
    const member = await memberFor(backend.db, identity, backend.invitations);
    return member ?? c.json({ error: 'notAMember' }, 403);
  };
  // 家庭の物は、家庭を押さえた中で、身元が今もその大人に結ばれているかを確かめ直してから作る
  // （押さえる前に外された大人・身元には、何も見せない）。
  const viewOf = (backend: FamilyBackend, member: FamilyMember) =>
    backend.store.withHousehold(member.householdId, (log) =>
      log.isBound?.(member.memberId, member.identityId)
        ? viewFor(log.events(), member.memberId, nowIn(member.timeZone, backend.clock?.()))
        : undefined,
    );
  const notAMember = (c: Context) => c.json({ error: 'notAMember' }, 403);
  // 書き込みは、画面の Origin から、JSON で来た物だけ（Host や転送の見出しからは決めない）。
  const refuseWrite = (c: Context, backend: FamilyBackend): Response | undefined => {
    if (c.req.header('origin') !== backend.origin) return c.json({ error: 'badOrigin' }, 403);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'notJson' }, 415);
    }
    return undefined;
  };
  // どちらの家庭を見せるか（画面が最初に聞く）。家族の家庭の無いサーバーは、デモだけ。
  // 知らせがあれば、登録に使う公開鍵も渡す。
  app.get('/api/me', async (c) => {
    if (!family) return c.json({ mode: 'demo' });
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    return c.json({
      mode: 'family',
      memberId: member.memberId,
      ...(family.push ? { pushKey: family.push.publicKey } : {}),
    });
  });
  // 画面は、自分が見ていると思っている大人（as）を毎回添える。今の身元と違えば（別の画面でログインが
  // 替わった等）、家庭の物を返さず、画面に確かめ直させる。as は比べるだけで、権限には使わない。
  const switched = (c: Context) => c.json({ error: 'identityChanged' }, 409);
  app.get('/api/view', async (c) => {
    if (!family) return c.json({ error: 'familyDisabled' }, 404);
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    if (c.req.query('as') !== member.memberId) return switched(c);
    const view = await viewOf(family, member);
    return view ? c.json(view) : notAMember(c);
  });
  app.post('/api/commands', async (c) => {
    if (!family) return c.json({ error: 'familyDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    // 操作する人は身元から決める（本文の memberId は使わない）。as は画面が見ていた大人で、今の身元と
    // 違えば、命令を処理せずに確かめ直させる（前の人の画面で、次の人として書かない）。
    const body = z
      .object({ as: z.string().min(1), operationId: z.string().min(1), command: Command })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badCommand' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    const result = await runCommand(
      family.store,
      member.householdId,
      {
        memberId: member.memberId,
        identityId: member.identityId,
        operationId: body.data.operationId,
        now: nowIn(member.timeZone, family.clock?.()),
        demo: false,
      },
      body.data.command,
    );
    // 書いたら、知らせの仕事を起こす（出すべき物が増えた・消えたかを見る）。
    if (result.status === 'ok') family.push?.notifier.poke(member.householdId);
    // 断られた命令でも、今も家族の大人なら、新しい見せる物を返す（外された人には返さない）。
    const view = await viewOf(family, member);
    return view ? c.json({ result, view }, statusOf(result)) : notAMember(c);
  });
  // 知らせの登録（この端末に送る）。大人ごとに一つ。登録先は、知っている Push の事業者の物だけ。
  const PushRegistration = z.object({
    as: z.string().min(1),
    subscription: z.object({
      endpoint: z.string().min(1).max(2048),
      keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
    }),
    language: z.enum(['ja', 'en']),
    /** 端末が登録を頼んだ時（その端末の時計のミリ秒）。同じ端末の中の順にだけ使う。 */
    requestedAt: z.number().int().nonnegative(),
  });
  app.post('/api/push/subscriptions', async (c) => {
    if (!family?.push) return c.json({ error: 'pushDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = PushRegistration.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badSubscription' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    const { endpoint, keys } = body.data.subscription;
    if (!isPushEndpoint(endpoint)) return c.json({ error: 'badEndpoint' }, 400);
    // 押さえた中で、今もこの大人に結ばれた身元かを確かめ、同じ取引の中で登録する（送る前にも確かめ
    // 直す）。
    const saved = await family.store.withHousehold(member.householdId, async (log) => {
      if (!log.transaction || !(log.isBound?.(member.memberId, member.identityId) ?? false)) {
        return 'unbound' as const;
      }
      return saveSubscription(log.transaction, {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        householdId: member.householdId,
        memberId: member.memberId,
        identityId: member.identityId,
        language: body.data.language,
        requestedAt: body.data.requestedAt,
      });
    });
    if (saved === 'unbound') return notAMember(c);
    // 同じ端末で、後から頼まれた登録が先に済んでいる（使う人が替わった後に届いた、前の人の登録）。
    if (saved === 'stale') return c.json({ error: 'staleRegistration' }, 409);
    family.push.notifier.poke(member.householdId);
    return c.json({ ok: true });
  });
  app.delete('/api/push/subscriptions', async (c) => {
    if (!family?.push) return c.json({ error: 'pushDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = z
      .object({ as: z.string().min(1), endpoint: z.string().min(1).max(2048) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badSubscription' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    // 外すのも、押さえた中で結びを確かめ直し、同じ取引の中で（外された身元の書きを受けない）。
    const removed = await family.store.withHousehold(member.householdId, async (log) => {
      if (!log.transaction || !(log.isBound?.(member.memberId, member.identityId) ?? false)) {
        return false;
      }
      await removeSubscription(
        log.transaction,
        member.householdId,
        member.memberId,
        body.data.endpoint,
      );
      return true;
    });
    if (!removed) return notAMember(c);
    return c.json({ ok: true });
  });
  // デモの家庭を、見る人ごとにサーバーに作る。計画はサーバーで作り、画面は見せる物を受け取る（§7.1）。
  app.post('/api/demo/sessions', async (c) => {
    const body = z.object({ stage: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || !isDemoStage(body.data.stage)) {
      return c.json({ error: 'unknownStage' }, 400);
    }
    // 家族（使う人を選ぶため）、読み取りの出どころ（録った応答か、手で書いた形か）、段の一覧も返す。
    const data = loadDemoData();
    return c.json({
      sessionId: sessions.create(body.data.stage),
      household: data.household,
      readings: data.readings.map(({ sourceId, origin, model }) => ({ sourceId, origin, model })),
      stages: DEMO_STAGES.map((s) => ({ id: s.id, now: s.now, viewer: s.viewer })),
    });
  });
  app.get('/api/demo/sessions/:sid/view', async (c) => {
    const member = c.req.query('member');
    if (!member) return c.json({ error: 'memberRequired' }, 400);
    const view = await sessions.view(c.req.param('sid'), member);
    return view ? c.json(view) : c.json({ error: 'unknownSession' }, 404);
  });
  app.post('/api/demo/sessions/:sid/commands', async (c) => {
    const body = z
      .object({ memberId: z.string().min(1), operationId: z.string().min(1), command: Command })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badCommand' }, 400);
    const { memberId, operationId, command } = body.data;
    const done = await sessions.command(c.req.param('sid'), memberId, operationId, command);
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    return c.json(done, statusOf(done.result));
  });
  return app;
}
