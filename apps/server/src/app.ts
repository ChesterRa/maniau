// API。見る人ごとのデモの家庭（架空の家族。ログインなし）と、家族の家庭（Cloudflare Access の身元。
// Postgres）。どちらも、画面には見せる物だけを渡し、事象の列は渡さない（02-foundation §7.1）。
import { Command, Household, PreviewCommand, SourceSender, splitSentences } from '@maniau/core';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ACCESS_HEADER, type AccessVerifier } from './auth/access';
import { nowIn } from './clock';
import { type CommandResult, runCommand } from './commands';
import type { Db } from './db/store';
import { DEMO_STAGES, isDemoStage, loadDemoData } from './demo';
import {
  demoSessions,
  type NoticeReader,
  type PhotoReader,
  type UtteranceReader,
  type WayIdeasReader,
} from './demo-sessions';
import { familyInput } from './family-input';
import { type FamilyMember, type Invitations, memberFor } from './members';
import type { Notifier } from './notifier';
import { previewChange, previewChoices, previewHousehold } from './preview';
import { isPushEndpoint, removeSubscription, saveSubscription } from './push';
import { checkPhoto, PhotoMediaType } from './reading/transcribe';
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

// 写真の中身は base64 で、5MB の写真がおよそ 7,000,000 字になる。中身の外の項目には 1KB を見込む。
export const MAX_PHOTO_DATA = 7_000_000;
export const MAX_PHOTO_BODY = MAX_PHOTO_DATA + 1024;
export const MAX_JSON_BODY = 64 * 1024;
const PHOTO_PATH = /^\/api\/demo\/sessions\/[^/]+\/photos$/;
const STATUS = { ok: 200, noop: 200, conflict: 409, forbidden: 403, invalid: 400 } as const;
const statusOf = (result: CommandResult) => STATUS[result.status];

export function createApp(
  options: {
    family?: FamilyBackend;
    /** お知らせを Claude で読む口（API の鍵がある時だけ）。無ければ、デモに文を入れられない。 */
    reader?: NoticeReader;
    /** 家族の一言を Claude で読む口（同じく鍵がある時だけ）。 */
    listener?: UtteranceReader;
    /** 「すること」のやり方の案を Claude で考える口。 */
    ideaReader?: WayIdeasReader;
    /** お知らせの写真・PDF を Claude で書き起こす口（同じく鍵がある時だけ）。 */
    transcriber?: PhotoReader;
    /**
     * デモだけのサーバーを Access の後ろに置く時の、身元の確かめ。あれば、/api/* の要求ごとに Access の
     * トークンを確かめ、確かめられなければ断る（Access を通らずに届いた要求も、ここで止まる）。
     * /api/health（中身の無い生存の確かめ。置き場所の healthcheck はトークンを持たない）だけは除く。
     * 家族の家庭とは一緒に使わない（家族の口は、成員ごとに自分で確かめる）。
     */
    demoAccess?: AccessVerifier;
  } = {},
): Hono {
  // 起きる時に、デモの家族とお知らせを読み、型と家族の決まりを確かめる（誤りなら起きない）。
  loadDemoData();
  const sessions = demoSessions();
  const { family, demoAccess } = options;
  if (family && demoAccess) {
    throw new Error('デモの入口の確かめと家族の家庭は、同じサーバーで同時に使わない');
  }
  // 家族の家庭を出すアプリでは、デモの読み取りを開けない（ログインの無いデモの道で、Claude の費用を
  // 使わせない）。読み取りを試すのは、デモだけのサーバー。
  const reader = family ? undefined : options.reader;
  // 一言も同じ（デモの家族の名前を前提に送るので、家族の家庭では開けない。01-model §10）。
  const listener = family ? undefined : options.listener;
  const ideaReader = family ? undefined : options.ideaReader;
  // 写真の書き起こしも同じ（家族の家庭では、まだ開けない）。
  const transcriber = family ? undefined : options.transcriber;
  const familyInputs = family
    ? familyInput({ store: family.store, ...(family.clock ? { clock: family.clock } : {}) })
    : undefined;
  const app = new Hono();
  // API の返事は、どれも控えに残さない（家族の予定・場所を、端末や途中の控えに置かない）。
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  if (demoAccess) {
    app.use('/api/*', async (c, next) => {
      if (c.req.path === '/api/health') return next();
      const identity = await demoAccess(c.req.header(ACCESS_HEADER));
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      return next();
    });
  }
  // 要求の中身は、読む前に大きさで断る（JSON を読み終えてから形を確かめるのでは、大きな中身を先に抱える）。
  // 写真の口だけを大きくし、他の口は文の上限（お知らせ 4,000 字）を UTF-8 で送っても収まる大きさにする。
  const jsonLimit = bodyLimit({
    maxSize: MAX_JSON_BODY,
    onError: (c) => c.json({ error: 'bodyTooLarge' }, 413),
  });
  const photoLimit = bodyLimit({
    maxSize: MAX_PHOTO_BODY,
    onError: (c) => c.json({ error: 'photoTooLarge' }, 413),
  });
  app.use('/api/*', (c, next) =>
    PHOTO_PATH.test(c.req.path) ? photoLimit(c, next) : jsonLimit(c, next),
  );
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
    const canUseInput =
      familyInputs && (options.reader || options.listener)
        ? await familyInputs.canUse(member)
        : false;
    return c.json({
      mode: 'family',
      memberId: member.memberId,
      ...(canUseInput && options.reader ? { canRead: true } : {}),
      ...(canUseInput && options.listener ? { canHear: true } : {}),
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
  // 決める画面の「選んだら」（書き込まずに同じ計算をした結果。preview.ts）。見る物と同じく、身元を確かめ直す。
  app.get('/api/preview', async (c) => {
    if (!family) return c.json({ error: 'familyDisabled' }, 404);
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    if (c.req.query('as') !== member.memberId) return switched(c);
    const arrangementKey = c.req.query('arrangement');
    if (!arrangementKey) return c.json({ error: 'arrangementRequired' }, 400);
    const previews = await family.store.withHousehold(member.householdId, (log) =>
      log.isBound?.(member.memberId, member.identityId)
        ? previewChoices(
            log.events(),
            {
              memberId: member.memberId,
              now: nowIn(member.timeZone, family.clock?.()),
            },
            arrangementKey,
          )
        : null,
    );
    if (previews === null) return notAMember(c);
    return previews ? c.json({ previews }) : c.json({ error: 'unknownArrangement' }, 404);
  });
  // 家と暮らしの情報の直しの「この変更で変わること」（書き込まずに同じ命令を展開した結果。preview.ts）。
  app.post('/api/household-preview', async (c) => {
    if (!family) return c.json({ error: 'familyDisabled' }, 404);
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    if (c.req.query('as') !== member.memberId) return switched(c);
    const body = z.object({ household: Household }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalidBody' }, 400);
    const preview = await family.store.withHousehold(member.householdId, (log) =>
      log.isBound?.(member.memberId, member.identityId)
        ? previewHousehold(
            log.events(),
            { memberId: member.memberId, now: nowIn(member.timeZone, family.clock?.()) },
            body.data.household,
          )
        : null,
    );
    if (preview === null) return notAMember(c);
    return 'reason' in preview
      ? c.json({ error: preview.reason }, preview.status === 'forbidden' ? 403 : 409)
      : c.json({ preview });
  });
  // 保存の前に「この変更で変わること」を見る（家の情報の直し・「すること」の言明・やり方の選び）。何も書かない。
  app.post('/api/change-preview', async (c) => {
    if (!family) return c.json({ error: 'familyDisabled' }, 404);
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    if (c.req.query('as') !== member.memberId) return switched(c);
    const body = z
      .object({ command: PreviewCommand })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalidBody' }, 400);
    const preview = await family.store.withHousehold(member.householdId, (log) =>
      log.isBound?.(member.memberId, member.identityId)
        ? previewChange(
            log.events(),
            { memberId: member.memberId, now: nowIn(member.timeZone, family.clock?.()) },
            body.data.command,
          )
        : null,
    );
    if (preview === null) return notAMember(c);
    return 'reason' in preview
      ? c.json({ error: preview.reason }, preview.status === 'forbidden' ? 403 : 409)
      : c.json({ preview });
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

  // 家族の読み取り：本文の as は切り替わりの検出だけに使う。モデルへ送る前と、結果を足す前に、
  // 身元と家庭をもう一度確かめる。デモの認証なしの口は、家族の家庭では引き続き開かない。
  const FamilyInputBody = z.object({
    as: z.string().min(1),
    operationId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(4000),
    sender: SourceSender.default('school'),
  });
  const FamilyUtteranceBody = z.object({
    as: z.string().min(1),
    operationId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(500),
  });
  const FamilyProposalBody = z.object({
    as: z.string().min(1),
    operationId: z.string().min(1).max(100),
  });
  const WayIdeasFields = {
    operationId: z.string().min(1).max(100),
    arrangementKey: z.string().min(1).max(512),
    text: z.string().trim().max(500).optional(),
    language: z.enum(['ja', 'en']),
  };
  const FamilyWayIdeasBody = z.object({ as: z.string().min(1), ...WayIdeasFields });
  const inputError = (c: Context, status: string, reason?: string) => {
    switch (status) {
      case 'forbidden':
        return c.json({ error: 'notAMember' }, 403);
      case 'testOnly':
        return c.json({ error: 'testHouseholdOnly' }, 403);
      case 'conflict':
        return c.json({ error: 'operationReused' }, 409);
      case 'stale':
        return c.json({ error: 'readingStale' }, 409);
      case 'uncertain':
        return c.json({ error: 'readingUncertain' }, 409);
      case 'busy':
        return c.json({ error: 'readingBusy' }, 429);
      case 'limit':
        return c.json({ error: 'readingLimit' }, 429);
      case 'gone':
        return c.json({ error: 'unknownProposal' }, 404);
      case 'needGone':
        return c.json({ error: 'needGone' }, 409);
      default:
        return c.json({ error: 'readingFailed', ...(reason ? { reason } : {}) }, 502);
    }
  };
  app.post('/api/notices', async (c) => {
    if (!family || !familyInputs) return c.json({ error: 'familyDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = FamilyInputBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badNotice' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    if (splitSentences(body.data.text, 'input').length === 0)
      return c.json({ error: 'badNotice' }, 400);
    if (!options.reader) return c.json({ error: 'readingUnavailable' }, 503);
    const recheck = async () => {
      const current = await memberOf(c, family);
      return (
        !(current instanceof Response) &&
        current.householdId === member.householdId &&
        current.memberId === member.memberId &&
        current.identityId === member.identityId
      );
    };
    const done = await familyInputs.notice(member, body.data, options.reader, recheck);
    if (done.status !== 'ok')
      return inputError(c, done.status, 'reason' in done ? done.reason : undefined);
    if (!(await recheck())) return notAMember(c);
    const view = await viewOf(family, member);
    if (!view) return notAMember(c);
    family.push?.notifier.poke(member.householdId);
    return c.json({ view, sourceId: done.sourceId, check: done.check });
  });
  app.post('/api/utterances', async (c) => {
    if (!family || !familyInputs) return c.json({ error: 'familyDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = FamilyUtteranceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badUtterance' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    if (!options.listener) return c.json({ error: 'readingUnavailable' }, 503);
    const recheck = async () => {
      const current = await memberOf(c, family);
      return (
        !(current instanceof Response) &&
        current.householdId === member.householdId &&
        current.memberId === member.memberId &&
        current.identityId === member.identityId
      );
    };
    const done = await familyInputs.utterance(member, body.data, options.listener, recheck);
    if (done.status !== 'ok')
      return inputError(c, done.status, 'reason' in done ? done.reason : undefined);
    if (!(await recheck())) return notAMember(c);
    const view = await viewOf(family, member);
    if (!view) return notAMember(c);
    // 読み取り中に進んだ計画に、前の答えを並べない。
    if (view.throughSeq !== done.view.throughSeq || view.now !== done.view.now)
      return inputError(c, 'stale');
    return c.json({ view, reply: done.reply });
  });
  // 確かめた「すること」の案だけを作る。保存は別の画面のプレビューと命令に任せる。
  app.post('/api/way-ideas', async (c) => {
    if (!family || !familyInputs) return c.json({ error: 'familyDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = FamilyWayIdeasBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badWayIdeas' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    if (!options.ideaReader) return c.json({ error: 'readingUnavailable' }, 503);
    const recheck = async () => {
      const current = await memberOf(c, family);
      return (
        !(current instanceof Response) &&
        current.householdId === member.householdId &&
        current.memberId === member.memberId &&
        current.identityId === member.identityId
      );
    };
    const done = await familyInputs.wayIdeas(member, body.data, options.ideaReader, recheck);
    if (done.status !== 'ok')
      return inputError(c, done.status, 'reason' in done ? done.reason : undefined);
    if (!(await recheck())) return notAMember(c);
    // 身元を引き直す間にも事象・家庭の印は変わりうる。同じ操作の控えで今の前提をもう一度照らす（外へ送り直さない）。
    const current = await familyInputs.wayIdeas(member, body.data, options.ideaReader, recheck);
    if (current.status !== 'ok')
      return inputError(c, current.status, 'reason' in current ? current.reason : undefined);
    return c.json({ ideas: current.ideas, sent: current.sent });
  });
  app.post('/api/proposals/:pid', async (c) => {
    if (!family || !familyInputs) return c.json({ error: 'familyDisabled' }, 404);
    const refused = refuseWrite(c, family);
    if (refused) return refused;
    const member = await memberOf(c, family);
    if (member instanceof Response) return member;
    const body = FamilyProposalBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badConfirm' }, 400);
    if (body.data.as !== member.memberId) return switched(c);
    const done = await familyInputs.confirm(member, c.req.param('pid'), body.data.operationId);
    if (done.status !== 'ok') {
      if (done.status === 'stale') return c.json({ error: 'proposalChanged' }, 409);
      return inputError(c, done.status, 'reason' in done ? done.reason : undefined);
    }
    const current = await memberOf(c, family);
    if (
      current instanceof Response ||
      current.householdId !== member.householdId ||
      current.memberId !== member.memberId ||
      current.identityId !== member.identityId
    )
      return notAMember(c);
    const view = await viewOf(family, member);
    if (!view) return notAMember(c);
    family.push?.notifier.poke(member.householdId);
    return c.json({ view });
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
      // お知らせの文を入れて読めるか（読み取りの鍵があるサーバーだけ）。一言を読めるか。
      canRead: reader !== undefined,
      canHear: listener !== undefined,
      canPhoto: reader !== undefined && transcriber !== undefined,
    });
  });
  app.get('/api/demo/sessions/:sid/view', async (c) => {
    const member = c.req.query('member');
    if (!member) return c.json({ error: 'memberRequired' }, 400);
    const view = await sessions.view(c.req.param('sid'), member);
    return view ? c.json(view) : c.json({ error: 'unknownSession' }, 404);
  });
  app.get('/api/demo/sessions/:sid/preview', async (c) => {
    const member = c.req.query('member');
    const arrangementKey = c.req.query('arrangement');
    if (!member || !arrangementKey) return c.json({ error: 'memberRequired' }, 400);
    const previews = await sessions.preview(c.req.param('sid'), member, arrangementKey);
    if (previews === null) return c.json({ error: 'unknownSession' }, 404);
    return previews ? c.json({ previews }) : c.json({ error: 'unknownArrangement' }, 404);
  });
  app.post('/api/demo/sessions/:sid/household-preview', async (c) => {
    const body = z
      .object({ memberId: z.string().min(1), household: Household })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalidBody' }, 400);
    const preview = await sessions.householdPreview(
      c.req.param('sid'),
      body.data.memberId,
      body.data.household,
    );
    if (preview === null) return c.json({ error: 'unknownSession' }, 404);
    return 'reason' in preview
      ? c.json({ error: preview.reason }, preview.status === 'forbidden' ? 403 : 409)
      : c.json({ preview });
  });
  app.post('/api/demo/sessions/:sid/change-preview', async (c) => {
    const body = z
      .object({ memberId: z.string().min(1), command: PreviewCommand })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalidBody' }, 400);
    const preview = await sessions.changePreview(
      c.req.param('sid'),
      body.data.memberId,
      body.data.command,
    );
    if (preview === null) return c.json({ error: 'unknownSession' }, 404);
    return 'reason' in preview
      ? c.json({ error: preview.reason }, preview.status === 'forbidden' ? 403 : 409)
      : c.json({ preview });
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
  // デモの家庭に、お知らせの文を入れる（貼る・キーボードのマイクで話す）。Claude で読み、計画に入れる。
  const NoticeInput = z.object({
    memberId: z.string().min(1),
    operationId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(4000),
    sender: SourceSender.default('school'),
    // 写真・PDF から書き起こし、家族が見比べて直した文か。
    medium: z.enum(['text', 'photo']).default('text'),
  });
  app.post('/api/demo/sessions/:sid/notices', async (c) => {
    if (!reader) return c.json({ error: 'readingUnavailable' }, 503);
    const body = NoticeInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badNotice' }, 400);
    const { memberId, operationId, text, sender, medium } = body.data;
    const done = await sessions.notice(
      c.req.param('sid'),
      memberId,
      { text, sender, medium, operationId },
      reader,
    );
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    switch (done.status) {
      case 'ok':
        return c.json({ view: done.view, sourceId: done.sourceId, check: done.check });
      case 'limit':
        return c.json({ error: 'readingLimit' }, 429);
      case 'busy':
        return c.json({ error: 'readingBusy' }, 429);
      case 'invalid':
        return c.json({ error: 'notAMember' }, 400);
      case 'conflict':
        return c.json({ error: 'operationReused' }, 409);
      case 'stale':
        return c.json({ error: 'readingStale' }, 409);
      case 'failed':
        // 中身や理由の文は返さない（種類だけ）。
        return c.json({ error: 'readingFailed', reason: done.reason }, 502);
    }
  });
  // デモの家庭で、お知らせの写真・PDF を書き起こし、文を返す。何も書かず、写真も残さない（家族が見比べて
  // 直してから、文として入れる）。写真は画面で長い辺 2576px までに縮める。中身の大きさの上限は、写真で
  // およそ 5MB。
  const PhotoBody = z.object({
    memberId: z.string().min(1),
    operationId: z.string().min(1).max(100),
    mediaType: PhotoMediaType,
    data: z
      .string()
      .min(1)
      .max(MAX_PHOTO_DATA)
      .regex(/^[A-Za-z0-9+/]+=*$/),
  });
  app.post('/api/demo/sessions/:sid/photos', async (c) => {
    if (!transcriber || !reader) return c.json({ error: 'readingUnavailable' }, 503);
    const body = PhotoBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badPhoto' }, 400);
    const { memberId, operationId, mediaType, data } = body.data;
    // 形の崩れた・言った形式と違う・大きすぎる中身は、呼ぶ前に断る（モデルの費用を使わない）。
    const checked = checkPhoto({ mediaType, data });
    if (checked === 'badPhoto') return c.json({ error: 'badPhoto' }, 400);
    if (checked === 'tooLarge') return c.json({ error: 'photoTooLarge' }, 413);
    const done = await sessions.photo(
      c.req.param('sid'),
      memberId,
      { mediaType, data, operationId },
      transcriber,
    );
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    switch (done.status) {
      case 'ok':
        return c.json({ text: done.text });
      case 'limit':
        return c.json({ error: 'readingLimit' }, 429);
      case 'busy':
        return c.json({ error: 'readingBusy' }, 429);
      case 'invalid':
        return c.json({ error: 'notAMember' }, 400);
      case 'conflict':
        return c.json({ error: 'operationReused' }, 409);
      case 'tooLarge':
        return c.json({ error: 'photoTooLarge' }, 413);
      case 'failed':
        return c.json({ error: 'readingFailed', reason: done.reason }, 502);
    }
  });
  // デモの家庭で、家族の一言（話した・打った短い文）を読み、記録の候補を返す。何も書かない。
  const UtteranceBody = z.object({
    memberId: z.string().min(1),
    operationId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(500),
  });
  app.post('/api/demo/sessions/:sid/utterances', async (c) => {
    if (!listener) return c.json({ error: 'readingUnavailable' }, 503);
    const body = UtteranceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badUtterance' }, 400);
    const { memberId, operationId, text } = body.data;
    const done = await sessions.utterance(
      c.req.param('sid'),
      memberId,
      { text, operationId },
      listener,
    );
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    switch (done.status) {
      case 'ok':
        return c.json({ view: done.view, reply: done.reply });
      case 'limit':
        return c.json({ error: 'readingLimit' }, 429);
      case 'busy':
        return c.json({ error: 'readingBusy' }, 429);
      case 'invalid':
        return c.json({ error: 'notAMember' }, 400);
      case 'conflict':
        return c.json({ error: 'operationReused' }, 409);
      case 'stale':
        return c.json({ error: 'readingStale' }, 409);
      case 'failed':
        return c.json({ error: 'readingFailed', reason: done.reason }, 502);
    }
  });
  // デモの家庭で、同じ前提と検査を使ってやり方の案を作る。
  app.post('/api/demo/sessions/:sid/way-ideas', async (c) => {
    if (!ideaReader) return c.json({ error: 'readingUnavailable' }, 503);
    const body = z
      .object({ memberId: z.string().min(1), ...WayIdeasFields })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badWayIdeas' }, 400);
    const { memberId, ...input } = body.data;
    const done = await sessions.wayIdeas(c.req.param('sid'), memberId, input, ideaReader);
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    switch (done.status) {
      case 'ok':
        return c.json({ ideas: done.ideas, sent: done.sent });
      case 'limit':
        return c.json({ error: 'readingLimit' }, 429);
      case 'busy':
        return c.json({ error: 'readingBusy' }, 429);
      case 'invalid':
        return c.json({ error: 'notAMember' }, 400);
      case 'conflict':
        return c.json({ error: 'operationReused' }, 409);
      case 'stale':
        return c.json({ error: 'readingStale' }, 409);
      case 'needGone':
        return c.json({ error: 'needGone' }, 409);
      case 'failed':
        return c.json({ error: 'readingFailed', reason: done.reason }, 502);
    }
  });
  // 一言の候補を、言った本人が確かめて記録する。見せた後に対象が変わっていれば、記録せず見せ直す。
  app.post('/api/demo/sessions/:sid/proposals/:pid', async (c) => {
    const body = z
      .object({ memberId: z.string().min(1), operationId: z.string().min(1).max(100) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badConfirm' }, 400);
    const { memberId, operationId } = body.data;
    const done = await sessions.confirm(
      c.req.param('sid'),
      memberId,
      c.req.param('pid'),
      operationId,
    );
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    switch (done.status) {
      case 'ok':
        return c.json({ view: done.view });
      case 'changed':
        return c.json({ error: 'proposalChanged', view: done.view }, 409);
      case 'refused':
        return c.json(
          { error: 'refused', result: done.result, view: done.view },
          statusOf(done.result),
        );
      case 'gone':
        return c.json({ error: 'unknownProposal' }, 404);
      case 'forbidden':
        return c.json({ error: 'notTheSpeaker' }, 403);
    }
  });
  return app;
}
