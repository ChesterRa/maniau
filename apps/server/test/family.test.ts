// 家族の家庭の入口（02-foundation §6.1・§7.3、01-model §11「身元」）：Access のトークンを毎回確かめ、
// 成員の表で今も有効な大人かを引く。初めての身元は招きのメールで一度だけ結び、後は発行元と中の ID で
// 引く。操作する人は身元から決め、本文の名乗りは使わない。鍵は試験の中で作る（本物の鍵を使わない）。
import { type Command, proposalSnapshot } from '@maniau/core';
import { and, eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend } from '../src/app';
import { accessVerifier } from '../src/auth/access';
import { identities, members } from '../src/db/schema';
import { demoEvents } from '../src/demo';
import { invitationsFrom } from '../src/members';
import type { Store } from '../src/store';
import { database, H, seeded } from './pg';

const TEAM = 'https://example-team.cloudflareaccess.com';
const AUD = 'test-audience';
const ORIGIN = 'https://maniau.example.test';
const CARE = 'arr:childCare:n1:i6:c';
const ASK = `task:opt:${CARE}:opt-grandma:ask`;
// 試験の時計：お知らせが届いた夜。
const NOW_MS = Date.parse('2026-11-25T19:40+09:00');

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let other: KeyPair;
let jwk: JWK;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  other = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' };
});

interface Claims {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string;
  /** null なら期限を付けない。 */
  exp?: string | number | null;
  key?: KeyPair;
}
function token(claims: Claims = {}) {
  const jwt = new SignJWT({ ...(claims.email === undefined ? {} : { email: claims.email }) })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt();
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? '1h');
  if (claims.sub !== '') jwt.setSubject(claims.sub ?? 'sub-b');
  return jwt.sign((claims.key ?? keys).privateKey);
}

async function setup() {
  const db = await database();
  const base = await seeded(db, H, demoEvents('arrived'));
  // 次に家庭を押さえる直前に一度だけ走らせる（身元を確かめた後、押さえる前の取り消しを起こす）。
  let beforeLock: (() => Promise<unknown>) | undefined;
  const store: Store = {
    async withHousehold(householdId, fn) {
      const hook = beforeLock;
      beforeLock = undefined;
      await hook?.();
      return base.withHousehold(householdId, fn);
    },
  };
  const family: FamilyBackend = {
    db,
    store,
    verify: accessVerifier({ teamDomain: TEAM, audience: AUD }, createLocalJWKSet({ keys: [jwk] })),
    invitations: invitationsFrom(
      H,
      JSON.stringify({ 'B@Example.test': 'b', 'a@example.test': 'a', 'g@example.test': 'g' }),
    ),
    origin: ORIGIN,
    clock: () => NOW_MS,
  };
  const app = createApp({ family });
  const call = async (
    path: string,
    jwt?: string,
    body?: unknown,
    extra: Record<string, string | undefined> = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
    if (jwt) headers['cf-access-jwt-assertion'] = jwt;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete headers[k];
      else headers[k] = v;
    }
    const response = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // 家族の家庭の返事は、成功も失敗も、控えに残さない。
    expect(response.headers.get('cache-control')).toBe('no-store');
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const count = () => base.withHousehold(H, (log) => log.events().length);
  const revokeBeforeLock = (fn: () => Promise<unknown>) => {
    beforeLock = fn;
  };
  return { db, app, call, count, revokeBeforeLock };
}

describe('家族の家庭の入口', () => {
  it('トークンが無い・確かめられない要求は、どの入口でも断る（401）', async () => {
    const { call } = await setup();
    const bad = [
      undefined,
      'not-a-token',
      await token({ aud: 'other-audience' }),
      await token({ iss: 'https://evil.cloudflareaccess.com' }),
      // 期限は本物の時計で確かめる（試験の時計は計画の時刻だけ）。
      await token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      await token({ key: other }),
      // 人でない（サービスの）トークンは sub が空。
      await token({ sub: '' }),
      // 期限の無いトークン（招かれた本人の物でも）。
      await token({ exp: null, email: 'b@example.test' }),
    ];
    for (const jwt of bad) {
      expect((await call('/api/me', jwt)).status).toBe(401);
      expect((await call('/api/view?as=b', jwt)).status).toBe(401);
      expect(
        (
          await call('/api/commands', jwt, {
            operationId: 'x',
            command: { type: 'confirmItem', itemId: 'n1:i5' },
          })
        ).status,
      ).toBe(401);
    }
  });

  it('招きのメールで一度だけ結び、後は発行元と中の ID で引く（メールが替わっても同じ人）', async () => {
    const { call, db } = await setup();
    const first = await call('/api/me', await token({ sub: 'sub-b', email: 'b@example.test' }));
    expect(first).toEqual({ status: 200, body: { mode: 'family', memberId: 'b' } });
    const later = await call('/api/me', await token({ sub: 'sub-b', email: 'new@example.test' }));
    expect(later.body).toEqual({ mode: 'family', memberId: 'b' });
    // 同じメールでも、別の身元は、結んだ大人を取れない。
    const thief = await call('/api/me', await token({ sub: 'sub-x', email: 'b@example.test' }));
    expect(thief.status).toBe(403);
    const rows = await db.select().from(identities);
    expect(rows.map((r) => r.subject)).toEqual(['sub-b']);
  });

  it('招かれていない身元と、大人でない成員への招きは断る（403）', async () => {
    const { call } = await setup();
    expect(
      (await call('/api/me', await token({ sub: 's1', email: 'z@example.test' }))).status,
    ).toBe(403);
    expect((await call('/api/me', await token({ sub: 's2' }))).status).toBe(403);
    // 祖母（頼める人）は、招かれていても家族の画面を使えない。
    expect(
      (await call('/api/me', await token({ sub: 's3', email: 'g@example.test' }))).status,
    ).toBe(403);
  });

  it('外した大人は、結んだ後でもすぐ使えない', async () => {
    const { call, db } = await setup();
    const jwt = await token({ sub: 'sub-b', email: 'b@example.test' });
    expect((await call('/api/me', jwt)).status).toBe(200);
    await db
      .update(members)
      .set({ active: false })
      .where(and(eq(members.householdId, H), eq(members.id, 'b')));
    expect((await call('/api/me', jwt)).status).toBe(403);
    expect((await call('/api/view?as=b', jwt)).status).toBe(403);
  });

  it('書き込みは画面の Origin から JSON で来た物だけ。別のサイト・Origin 無し・JSON でない物は書かない', async () => {
    const { call, count } = await setup();
    const jwt = await token({ sub: 'sub-b', email: 'b@example.test' });
    const before = await count();
    const command = { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' };
    const send = (operationId: string, extra: Record<string, string | undefined>) =>
      call('/api/commands', jwt, { as: 'b', operationId, command }, extra);
    expect((await send('o1', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('o2', { origin: undefined })).status).toBe(403);
    expect((await send('o3', { 'content-type': 'text/plain' })).status).toBe(415);
    expect(await count()).toBe(before);
    expect((await send('o4', {})).status).toBe(200);
    expect(await count()).toBe(before + 1);
  });

  it('身元を確かめた後、家庭を押さえる前に外された大人・身元には、何も見せず、何も書かない', {
    timeout: 60_000,
  }, async () => {
    const revocations: [string, (db: Awaited<ReturnType<typeof database>>) => Promise<unknown>][] =
      [
        [
          '大人を外した',
          (db) =>
            db
              .update(members)
              .set({ active: false })
              .where(and(eq(members.householdId, H), eq(members.id, 'b'))),
        ],
        [
          '身元を外した（大人はそのまま）',
          (db) => db.update(identities).set({ removedAt: new Date() }),
        ],
        [
          '大人と身元の結びを外した',
          (db) =>
            db
              .update(members)
              .set({ identityId: null })
              .where(and(eq(members.householdId, H), eq(members.id, 'b'))),
        ],
      ];
    for (const [label, revoke] of revocations) {
      const { call, db, count, revokeBeforeLock } = await setup();
      const jwt = await token({ sub: 'sub-b', email: 'b@example.test' });
      expect((await call('/api/me', jwt)).status, label).toBe(200);
      revokeBeforeLock(() => revoke(db));
      const view = await call('/api/view?as=b', jwt);
      expect(view, label).toEqual({ status: 403, body: { error: 'notAMember' } });
      // 命令：押さえた中で断り、事象を足さず、見せる物も返さない。
      const { call: call2, db: db2, count: count2, revokeBeforeLock: revoke2 } = await setup();
      expect((await call2('/api/me', jwt)).status, label).toBe(200);
      const before = await count2();
      revoke2(() => revoke(db2));
      const done = await call2('/api/commands', jwt, {
        as: 'b',
        operationId: 'op-r',
        command: { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' },
      });
      expect(done, label).toEqual({ status: 403, body: { error: 'notAMember' } });
      expect(await count2(), label).toBe(before);
      void count;
    }
  });

  it('見せる物と命令は、身元の大人として。本文で別の人を名乗っても使わない', async () => {
    const { call } = await setup();
    const jwt = await token({ sub: 'sub-b', email: 'b@example.test' });
    const view = await call('/api/view?as=b', jwt);
    expect(view.status).toBe(200);
    expect(view.body.now).toBe('2026-11-25T19:40+09:00');
    const propose: Command = { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' };
    const done = await call('/api/commands', jwt, {
      as: 'b',
      memberId: 'a',
      operationId: 'op-1',
      command: propose,
    });
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({ status: 'ok' });
    // 提案は彩（身元の大人）の物として足された：本人が、その提案を引き受けられる。
    const plan = (done.body.view as { plan: { tasks: { key: string }[] } }).plan;
    const task = plan.tasks.find((t) => t.key === ASK);
    const shown = task && proposalSnapshot(task as Parameters<typeof proposalSnapshot>[0]);
    if (!shown) throw new Error('置けていない');
    const accepted = await call('/api/commands', jwt, {
      as: 'b',
      operationId: 'op-2',
      command: { type: 'accept', taskKey: ASK, shown },
    });
    expect(accepted.body.result).toMatchObject({ status: 'ok' });
    // 健太として引き受けようとすれば、本人でないので断る。
    const kenta = await token({ sub: 'sub-a', email: 'a@example.test' });
    expect((await call('/api/me', kenta)).body).toEqual({ mode: 'family', memberId: 'a' });
    const refused = await call('/api/commands', kenta, {
      as: 'a',
      operationId: 'op-3',
      command: { type: 'accept', taskKey: ASK, shown },
    });
    expect(refused.status).toBe(403);
    // デモだけの命令（時計を進める）は、家族の家庭では使えない。
    const clock = await call('/api/commands', jwt, {
      as: 'b',
      operationId: 'op-4',
      command: { type: 'advanceClock', to: '2026-11-26T09:00+09:00' },
    });
    expect(clock.status).toBe(403);
  });

  it('画面が見ている大人と今の身元が違えば（別の画面でログインが替わった）、見せず、書かない', async () => {
    const { call, count } = await setup();
    const aya = await token({ sub: 'sub-b', email: 'b@example.test' });
    const kenta = await token({ sub: 'sub-a', email: 'a@example.test' });
    expect((await call('/api/me', aya)).body).toEqual({ mode: 'family', memberId: 'b' });
    expect((await call('/api/me', kenta)).body).toEqual({ mode: 'family', memberId: 'a' });
    // 彩の画面のまま、ログインが健太に替わった。
    expect(await call('/api/view?as=b', kenta)).toEqual({
      status: 409,
      body: { error: 'identityChanged' },
    });
    expect((await call('/api/view', kenta)).status).toBe(409);
    const before = await count();
    const done = await call('/api/commands', kenta, {
      as: 'b',
      operationId: 'op-s',
      command: { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'a' },
    });
    expect(done).toEqual({ status: 409, body: { error: 'identityChanged' } });
    expect(await count()).toBe(before);
    // 見ている大人を添えない命令は受けない。
    const bare = await call('/api/commands', kenta, {
      operationId: 'op-t',
      command: { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'a' },
    });
    expect(bare.status).toBe(400);
    expect(await count()).toBe(before);
  });

  it('家族の家庭の無いサーバーは、デモだけ', async () => {
    const app = createApp();
    expect(await (await app.request('/api/me')).json()).toEqual({ mode: 'demo' });
    expect((await app.request('/api/view')).status).toBe(404);
    expect((await app.request('/api/commands', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
