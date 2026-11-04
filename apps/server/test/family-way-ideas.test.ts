// 家族の家庭のやり方候補。架空の家庭と手書きの応答だけを使い、外の API は呼ばない。
import type { PreviewCommand, WayIdeasContext, WayIdeasOutput } from '@maniau/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend } from '../src/app';
import { households, members, operations } from '../src/db/schema';
import { demoEvents } from '../src/demo';
import type { WayIdeasReader } from '../src/demo-sessions';
import { familyInput } from '../src/family-input';
import { invitationsFrom, memberFor } from '../src/members';
import type { Store } from '../src/store';
import type { View } from '../src/views';
import { database, H, seeded } from './pg';

const ORIGIN = 'https://maniau.example.test';
const AT = Date.parse('2026-11-25T19:40:30+09:00');
const OUTPUT: WayIdeasOutput = {
  drafts: [],
  reuse: [
    { wayId: 'way-grandma', why: '登録したやり方を確かめる' },
    { wayId: 'not-registered', why: '無い案' },
  ],
  missing: ['相手が引き受けられるか'],
};

function reader(calls: WayIdeasContext[], wait?: Promise<void>): WayIdeasReader {
  return async (context) => {
    calls.push(context);
    await wait;
    return {
      output: OUTPUT,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

/** 候補の操作記録を含む取引を戻すか、コミット後の返事を一度失う。 */
function failedWriteOnce(store: Store, where: 'rollback' | 'committed'): Store {
  let armed = true;
  return {
    async withHousehold(householdId, fn) {
      let finishing = false;
      const result = await store.withHousehold(householdId, async (log) => {
        const value = await fn({
          ...log,
          recordOperation(operation) {
            if (operation.id.startsWith('family-input:end:') && operation.digest.startsWith('ok:'))
              finishing = true;
            log.recordOperation(operation);
          },
        });
        if (finishing && armed && where === 'rollback') {
          armed = false;
          throw new Error('fictional-rollback');
        }
        return value;
      });
      if (finishing && armed && where === 'committed') {
        armed = false;
        throw new Error('fictional-commit-ack-lost');
      }
      return result;
    },
  };
}

async function setup(read: WayIdeasReader, clock: () => number = () => AT) {
  const db = await database();
  const store = await seeded(db, H, demoEvents('arrived'));
  const invitations = new Map(
    invitationsFrom(
      H,
      JSON.stringify({ 'a@example.test': 'a', 'b@example.test': 'b', 'g@example.test': 'g' }),
    ),
  );
  const family: FamilyBackend = {
    db,
    store,
    origin: ORIGIN,
    clock,
    invitations,
    verify: async (token) =>
      token === 'a' || token === 'b' || token === 'g'
        ? { issuer: 'test-issuer', subject: token, email: `${token}@example.test` }
        : undefined,
  };
  const makeApp = () => createApp({ family, ideaReader: read });
  const app = makeApp();
  const call = async (
    path: string,
    token: string | undefined,
    body?: unknown,
    extra: Record<string, string> = {},
    target = app,
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...extra,
    };
    if (token) headers['cf-access-jwt-assertion'] = token;
    const response = await target.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return {
      status: response.status,
      body: (await response.json()) as {
        error?: string;
        reason?: string;
        view: View;
        preview: { seen: string; throughSeq: number };
        sent: WayIdeasContext;
        ideas: { reuse: { wayId: string }[]; notes: { code: string }[] };
      },
    };
  };
  const all = () => store.withHousehold(H, (log) => [...log.events()]);
  const createNeed = async () => {
    const command: PreviewCommand = {
      type: 'stateNeed',
      text: '12月12日の13時から14時に地域交流会に出る。',
      interpretation: {
        what: '地域交流会に出る',
        shape: 'window',
        date: '2026-12-12',
        startTime: '13:00',
        endTime: '14:00',
      },
    };
    const preview = await call('/api/change-preview?as=b', 'b', { command });
    expect(preview.status).toBe(200);
    const written = await call('/api/commands', 'b', {
      as: 'b',
      operationId: 'fixture-need',
      command: {
        ...command,
        seen: { throughSeq: preview.body.preview.throughSeq, changes: preview.body.preview.seen },
      },
    });
    expect(written.status).toBe(200);
    const requirement = written.body.view.plan.requirements.find(
      (r) => r.kind === 'need' && r.what === '地域交流会に出る',
    );
    const arrangement = written.body.view.plan.arrangements.find(
      (a) => a.requirementKey === requirement?.key,
    );
    if (!requirement || !arrangement) throw new Error('架空の手配が無い');
    return { key: arrangement.key, itemId: requirement.basis.itemIds[0] };
  };
  await call('/api/me', 'b');
  return { db, store, family, makeApp, app, call, all, createNeed };
}

const idea = (key: string, operationId = 'idea-1', text = '祖母に頼めるかも。') => ({
  as: 'b',
  operationId,
  arrangementKey: key,
  text,
  language: 'ja',
});

describe('家族の家庭でやり方の案を出す', () => {
  it.each(['committed', 'rollback'] as const)(
    '操作記録の返事が失われた時（%s）、同じ ID で確かめて二度出案しない',
    async (where) => {
      const calls: WayIdeasContext[] = [];
      const read = reader(calls);
      const t = await setup(read);
      const { key } = await t.createNeed();
      const before = await t.all();
      const app = createApp({
        family: { ...t.family, store: failedWriteOnce(t.store, where) },
        ideaReader: read,
      });
      const input = idea(key);
      const first = await t.call('/api/way-ideas', 'b', input, {}, app);
      expect(first.body).toMatchObject({ error: 'readingFailed', reason: 'store' });
      const retry = await t.call('/api/way-ideas', 'b', input, {}, app);
      if (where === 'committed') {
        expect(retry.status).toBe(200);
        expect(retry.body.sent.need.what).toBe('地域交流会に出る');
      } else {
        expect(retry.body.error).toBe('readingUncertain');
      }
      expect(calls).toHaveLength(1);
      expect(await t.all()).toEqual(before);
    },
  );

  it('現行の確認済み事項と最小限の家の名前だけ送り、事象を変えずに検査済みの案を返す', async () => {
    const calls: WayIdeasContext[] = [];
    const t = await setup(reader(calls));
    const need = await t.createNeed();
    const before = await t.all();
    // 本文に他の人の ID を添えても、認証された大人が「家族の言葉」の話し手になる。
    const result = await t.call('/api/way-ideas', 'b', { ...idea(need.key), askedBy: 'a' });
    expect(result.status).toBe(200);
    expect(result.body.sent).toEqual(calls[0]);
    expect(result.body.sent.need).toMatchObject({ what: '地域交流会に出る', shape: 'window' });
    expect(result.body.sent.familyWords).toBe('祖母に頼めるかも。');
    expect(result.body.sent.familyWordsBy).toEqual({ id: 'b', name: '彩' });
    expect(Object.keys(result.body.sent.household).sort()).toEqual([
      'adults',
      'helpers',
      'places',
      'ways',
    ]);
    expect(JSON.stringify(result.body.sent.household)).not.toContain('陽菜');
    expect(JSON.stringify(result.body.sent.household)).not.toContain('routine');
    expect(result.body.ideas.reuse).toEqual([
      { wayId: 'way-grandma', why: '登録したやり方を確かめる' },
    ]);
    expect(result.body.ideas.notes).toContainEqual({ code: 'unknownWay', value: 'not-registered' });
    expect(await t.all()).toEqual(before);
    const rows = await t.db.select().from(operations);
    expect(JSON.stringify(rows)).not.toContain('祖母に頼めるかも');
    expect(JSON.stringify(rows)).not.toContain('地域交流会');
  });

  it('型にない価格・外の相手の待ち・締切を、案として返さない', async () => {
    const output = {
      drafts: [
        {
          name: '架空の案',
          why: '家族が確かめる',
          steps: [
            {
              name: '手順',
              quote: null,
              assignee: { kind: 'unknown', id: null },
              counterpart: { kind: 'unknown', id: null, name: null, quote: null },
              place: { kind: 'unknown', id: null, name: null, quote: null },
              minutes: null,
              segments: null,
              cover: null,
              replyWaitMinutes: 1440,
              deadline: { kind: 'daysBefore', days: 2, at: '21:00' },
            },
          ],
          covers: 'unknown',
          cost: { leaveMinutes: null, extraTasks: null, yen: 1500 },
          unclear: [],
        },
      ],
      reuse: [],
      missing: [],
    };
    const read: WayIdeasReader = async () => ({
      output: output as unknown as WayIdeasOutput,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const t = await setup(read);
    const { key } = await t.createNeed();
    const result = await t.call('/api/way-ideas', 'b', idea(key));
    expect(result.status).toBe(200);
    const checked = JSON.stringify(result.body.ideas);
    expect(checked).not.toMatch(/yen|1500|replyWait|1440|deadline/);
  });

  it('身元・Origin・画面の as・test 家庭・対象を確かめ、断った時はモデルを呼ばない', async () => {
    const calls: WayIdeasContext[] = [];
    const t = await setup(reader(calls));
    const need = await t.createNeed();
    expect((await t.call('/api/way-ideas', undefined, idea(need.key))).status).toBe(401);
    expect((await t.call('/api/way-ideas', 'g', idea(need.key))).status).toBe(403);
    expect((await t.call('/api/way-ideas', 'a', idea(need.key))).body.error).toBe(
      'identityChanged',
    );
    expect(
      (
        await t.call('/api/way-ideas', 'b', idea(need.key), {
          origin: 'https://other.example.test',
        })
      ).body.error,
    ).toBe('badOrigin');
    expect((await t.call('/api/way-ideas', 'b', idea('missing', 'missing'))).body.error).toBe(
      'needGone',
    );
    expect(calls).toHaveLength(0);
    await t.db.update(households).set({ kind: 'real' }).where(eq(households.id, H));
    expect((await t.call('/api/way-ideas', 'b', idea(need.key))).body.error).toBe(
      'testHouseholdOnly',
    );
    expect(calls).toHaveLength(0);
  });

  it('同じ操作は同じ案を返し、文・言葉・手配を変えて同じ ID を使えば断る', async () => {
    const calls: WayIdeasContext[] = [];
    const t = await setup(reader(calls));
    const { key } = await t.createNeed();
    const first = await t.call('/api/way-ideas', 'b', idea(key));
    const again = await t.call('/api/way-ideas', 'b', idea(key));
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(calls).toHaveLength(1);
    expect((await t.call('/api/way-ideas', 'b', idea(key, 'idea-1', '別の考え'))).body.error).toBe(
      'operationReused',
    );
    expect((await t.call('/api/way-ideas', 'b', { ...idea(key), language: 'en' })).body.error).toBe(
      'operationReused',
    );
    expect((await t.call('/api/way-ideas', 'b', idea('other', 'idea-1'))).body.error).toBe(
      'operationReused',
    );
    expect(calls).toHaveLength(1);
  });

  it('別の家庭の同じ大人 ID と操作 ID では、前の家庭の案を返さない', async () => {
    const calls: WayIdeasContext[] = [];
    const read = reader(calls);
    const t = await setup(read);
    const { key } = await t.createNeed();
    const other = 'other-household';
    const events = demoEvents('arrived').map((event) =>
      event.type === 'householdSet'
        ? { ...event, householdId: other, household: { ...event.household, id: other } }
        : { ...event, householdId: other },
    );
    await seeded(t.db, other, events);
    const invitations = new Map(t.family.invitations);
    invitations.set('c@example.test', { householdId: other, memberId: 'b' });
    const verify = async (token: string | undefined) =>
      token === 'c'
        ? { issuer: 'test-issuer', subject: 'c', email: 'c@example.test' }
        : t.family.verify(token);
    const app = createApp({ family: { ...t.family, invitations, verify }, ideaReader: read });
    expect((await t.call('/api/me', 'c', undefined, {}, app)).status).toBe(200);
    expect((await t.call('/api/way-ideas', 'b', idea(key), {}, app)).status).toBe(200);
    const otherResult = await t.call('/api/way-ideas', 'c', idea(key), {}, app);
    expect(otherResult.body.error).toBe('needGone');
    expect(calls).toHaveLength(1);
  });

  it('案を作る間に事象が変われば捨て、並行する別操作を呼ばない', async () => {
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: WayIdeasContext[] = [];
    const base = reader(calls, gate);
    const t = await setup(async (ctx) => {
      entered();
      return base(ctx);
    });
    const { key } = await t.createNeed();
    const inFlight = t.call('/api/way-ideas', 'b', idea(key));
    await started;
    expect((await t.call('/api/way-ideas', 'b', idea(key, 'another'))).body.error).toBe(
      'readingBusy',
    );
    let heard = 0;
    // 別のプロセスに相当するアプリでも、一言は同じ家庭の読み取り枠を使う。
    const otherApp = createApp({
      family: t.family,
      listener: async () => {
        heard += 1;
        throw new Error('呼んではいけない');
      },
    });
    const other = await t.call(
      '/api/utterances',
      'b',
      { as: 'b', operationId: 'other-kind', text: '返事がありました。' },
      {},
      otherApp,
    );
    expect(other.body.error).toBe('readingBusy');
    expect(heard).toBe(0);
    const before = await t.all();
    await t.store.withHousehold(H, (log) => {
      log.append(
        [{ type: 'clockAdvanced', to: '2026-11-25T19:40+09:00' }],
        'b',
        '2026-11-25T19:40+09:00',
      );
    });
    expect((await t.all()).length).toBe(before.length + 1);
    release();
    expect((await inFlight).body.error).toBe('readingStale');
    expect(calls).toHaveLength(1);
  });

  it('読む間に分だけ進んでも、同じ事象と生きている手配なら古いと言わない', async () => {
    let now = AT;
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: WayIdeasContext[] = [];
    const base = reader(calls, gate);
    const t = await setup(
      async (ctx) => {
        entered();
        return base(ctx);
      },
      () => now,
    );
    const { key } = await t.createNeed();
    const pending = t.call('/api/way-ideas', 'b', idea(key));
    await started;
    now += 40_000;
    release();
    expect((await pending).status).toBe(200);
    expect((await t.call('/api/way-ideas', 'b', idea(key))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('最後の身元確認の間に事象が変わっても、古い案を返さない', async () => {
    const calls: WayIdeasContext[] = [];
    const read = reader(calls);
    const t = await setup(read);
    const { key } = await t.createNeed();
    let checks = 0;
    const verify = async (token: string | undefined) => {
      checks += 1;
      if (checks === 4) {
        await t.store.withHousehold(H, (log) => {
          log.append(
            [{ type: 'clockAdvanced', to: '2026-11-25T19:40+09:00' }],
            'b',
            '2026-11-25T19:40+09:00',
          );
        });
      }
      return t.family.verify(token);
    };
    const app = createApp({ family: { ...t.family, verify }, ideaReader: read });
    const response = await t.call('/api/way-ideas', 'b', idea(key), {}, app);
    expect(response.body.error).toBe('readingStale');
    expect(calls).toHaveLength(1);
  });

  it('読む間に家族の資格または test の印が外れたら案を返さない', async () => {
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: WayIdeasContext[] = [];
    const base = reader(calls, gate);
    const t = await setup(async (ctx) => {
      entered();
      return base(ctx);
    });
    const { key } = await t.createNeed();
    const pending = t.call('/api/way-ideas', 'b', idea(key));
    await started;
    await t.db.update(members).set({ active: false }).where(eq(members.id, 'b'));
    release();
    expect((await pending).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('前の操作が途中で止まり結果不明なら、再起動後も外へ送り直さない', async () => {
    const calls: WayIdeasContext[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await setup(reader(calls));
    const { key } = await t.createNeed();
    const member = await memberFor(
      t.db,
      { issuer: 'test-issuer', subject: 'b' },
      t.family.invitations,
    );
    if (!member) throw new Error('大人が無い');
    const service = familyInput({ store: t.store, clock: () => AT, timeoutMs: 10 });
    const input = { operationId: 'timeout', arrangementKey: key, language: 'ja' as const };
    expect(
      (await service.wayIdeas(member, input, reader(calls, gate), async () => true)).status,
    ).toBe('uncertain');
    const restarted = familyInput({ store: t.store, clock: () => AT });
    expect((await restarted.wayIdeas(member, input, reader(calls), async () => true)).status).toBe(
      'uncertain',
    );
    release();
    expect(calls).toHaveLength(1);
  });

  it('無い手配は呼ばず数えず、案も同じ家庭の一日の上限に入る', async () => {
    const calls: WayIdeasContext[] = [];
    const t = await setup(reader(calls));
    const { key } = await t.createNeed();
    const member = await memberFor(
      t.db,
      { issuer: 'test-issuer', subject: 'b' },
      t.family.invitations,
    );
    if (!member) throw new Error('大人が無い');
    const service = familyInput({ store: t.store, clock: () => AT, dailyLimit: 1 });
    const input = { operationId: 'missing', arrangementKey: 'none', language: 'ja' as const };
    expect((await service.wayIdeas(member, input, reader(calls), async () => true)).status).toBe(
      'needGone',
    );
    expect(
      (
        await service.wayIdeas(
          member,
          { ...input, operationId: 'one', arrangementKey: key },
          reader(calls),
          async () => true,
        )
      ).status,
    ).toBe('ok');
    let called = 0;
    const collision = await service.notice(
      member,
      { operationId: 'one', text: '架空のお知らせ。', sender: 'school' },
      async () => {
        called += 1;
        throw new Error('呼んではいけない');
      },
      async () => true,
    );
    expect(collision.status).toBe('conflict');
    expect(called).toBe(0);
    expect(
      (
        await service.wayIdeas(
          member,
          { ...input, operationId: 'two', arrangementKey: key },
          reader(calls),
          async () => true,
        )
      ).status,
    ).toBe('limit');
    expect(calls).toHaveLength(1);
  });
});

describe('デモの HTTP 入口', () => {
  it('正式な言明の手配へ案を返し、同じ操作では二度呼ばず事象を足さない', async () => {
    const calls: WayIdeasContext[] = [];
    const app = createApp({ ideaReader: reader(calls) });
    const post = async (url: string, body: unknown) => {
      const result = await app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: result.status,
        body: (await result.json()) as {
          sessionId: string;
          preview: { throughSeq: number; seen: string };
          view: View;
          sent: WayIdeasContext;
          ideas: unknown;
          error?: string;
        },
      };
    };
    const created = await post('/api/demo/sessions', { stage: 'arrived' });
    const prefix = `/api/demo/sessions/${created.body.sessionId}`;
    const command: PreviewCommand = {
      type: 'stateNeed',
      text: '12月12日に手続きをする。',
      interpretation: { what: '手続き', shape: 'by', deadline: '2026-12-12T17:00+09:00' },
    };
    const preview = await post(`${prefix}/change-preview`, { memberId: 'b', command });
    expect(preview.status).toBe(200);
    const written = await post(`${prefix}/commands`, {
      memberId: 'b',
      operationId: 'demo-need',
      command: {
        ...command,
        seen: { throughSeq: preview.body.preview.throughSeq, changes: preview.body.preview.seen },
      },
    });
    expect(written.status).toBe(200);
    const requirement = written.body.view.plan.requirements.find(
      (r) => r.kind === 'need' && r.what === '手続き',
    );
    const arrangement = written.body.view.plan.arrangements.find(
      (a) => a.requirementKey === requirement?.key,
    );
    if (!arrangement) throw new Error('デモの手配が無い');
    const input = {
      memberId: 'b',
      operationId: 'demo-idea',
      arrangementKey: arrangement.key,
      language: 'ja',
    };
    const first = await post(`${prefix}/way-ideas`, input);
    const again = await post(`${prefix}/way-ideas`, input);
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(calls).toHaveLength(1);
    expect(first.body.sent.need.what).toBe('手続き');
    expect(first.body.sent.familyWordsBy).toBeNull();
    const after = await app.request(`${prefix}/view?member=b`);
    expect(((await after.json()) as View).throughSeq).toBe(written.body.view.throughSeq);
    expect((await post('/api/demo/sessions/unknown/way-ideas', input)).status).toBe(404);
  });
});
