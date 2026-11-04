// 家族の家庭の読み取り・一言。外の API は呼ばず、架空の家庭と録った／手書きの応答で確かめる。
import { readFileSync } from 'node:fs';
import {
  type ExtractionOutput,
  type PreviewCommand,
  parseStoredExtraction,
  type UtteranceContext,
  type UtteranceOutput,
} from '@maniau/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend } from '../src/app';
import { events, households, members, operations } from '../src/db/schema';
import { demoEvents } from '../src/demo';
import type { NoticeReader, UtteranceReader } from '../src/demo-sessions';
import { sha256Of } from '../src/digest';
import { familyInput } from '../src/family-input';
import { invitationsFrom, memberFor } from '../src/members';
import type { ExtractRequest } from '../src/reading/extract';
import type { Store } from '../src/store';
import type { View } from '../src/views';
import { database, H, seeded } from './pg';

const ORIGIN = 'https://maniau.example.test';
const NOW = Date.parse('2026-11-25T19:40+09:00');
const readFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const NOTICE = readFile('data/demo/notices/2026-12-04-enki.txt');
const recorded = JSON.parse(readFile('data/demo/recorded/n2.extract.json')).output;
const extraction = (request: ExtractRequest): ExtractionOutput =>
  parseStoredExtraction(
    JSON.parse(JSON.stringify(recorded).replaceAll('"n2#', `"${request.source.id}#`)),
  );

function makeReader(calls: ExtractRequest[] = []): NoticeReader {
  return async (request) => {
    calls.push(request);
    return {
      output: extraction(request),
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

const replyYes: UtteranceOutput = {
  kind: 'change',
  actions: [
    {
      type: 'recordReply',
      taskKey: null,
      requestId: 'r-grandma',
      reply: 'yes',
      unknownId: null,
      value: null,
    },
  ],
  refs: { taskKeys: [], requestIds: [], itemIds: [] },
  unsupported: null,
};

function makeListener(calls: string[] = []): UtteranceReader {
  return async (context) => {
    calls.push(context.speaker.id);
    return {
      output: replyYes,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

function gated<T, R>(inner: (input: T) => Promise<R>) {
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    started,
    release,
    read: async (input: T) => {
      entered();
      await gate;
      return inner(input);
    },
  };
}

/** 完了記録を含むトランザクションの直前、またはコミット応答を一度だけ失う。 */
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

async function setup(
  options: {
    reader?: NoticeReader;
    listener?: UtteranceReader;
    otherHousehold?: boolean;
    clock?: () => number;
  } = {},
) {
  const db = await database();
  const store = await seeded(db, H, demoEvents('chase'));
  if (options.otherHousehold) {
    const other = demoEvents('chase').map((event) =>
      event.type === 'householdSet'
        ? {
            ...event,
            householdId: 'other-household',
            household: { ...event.household, id: 'other-household' },
          }
        : { ...event, householdId: 'other-household' },
    );
    await seeded(db, 'other-household', other);
  }
  const invitations = new Map(
    invitationsFrom(
      H,
      JSON.stringify({
        'a@example.test': 'a',
        'b@example.test': 'b',
        'g@example.test': 'g',
      }),
    ),
  );
  if (options.otherHousehold) {
    invitations.set('c@example.test', { householdId: 'other-household', memberId: 'b' });
  }
  const family: FamilyBackend = {
    db,
    store,
    origin: ORIGIN,
    clock: options.clock ?? (() => NOW),
    verify: async (token) =>
      token === 'a' || token === 'b' || token === 'c' || token === 'g'
        ? { issuer: 'test-issuer', subject: token, email: `${token}@example.test` }
        : undefined,
    invitations,
  };
  const makeApp = () =>
    createApp({
      family,
      ...(options.reader ? { reader: options.reader } : {}),
      ...(options.listener ? { listener: options.listener } : {}),
    });
  const app = makeApp();
  const call = async (
    path: string,
    token?: string,
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
    const payload = (await response.json()) as {
      error?: string;
      reason?: string;
      sessionId: string;
      canRead: boolean;
      sourceId: string;
      sources: { id: string }[];
      throughSeq: number;
      today: View['today'];
      preview: { seen: string };
      view: View;
      reply: { kind: string; proposals: { id: string }[] };
    };
    return { status: response.status, body: payload };
  };
  const all = () => store.withHousehold(H, (log) => [...log.events()]);
  return { db, store, family, app, makeApp, call, all };
}

const notice = (operationId: string, text = NOTICE) => ({
  as: 'b',
  operationId,
  text,
  sender: 'school',
});
const say = (operationId: string) => ({ as: 'b', operationId, text: '返事が来ました' });

describe('家族の家庭の文字の読み取り', () => {
  it('real の家庭では読み取りと一言の入口を出さず、直接の要求も外へ送らない', async () => {
    const calls: ExtractRequest[] = [];
    const heard: string[] = [];
    const t = await setup({ reader: makeReader(calls), listener: makeListener(heard) });
    await t.call('/api/me', 'b');
    await t.db.update(households).set({ kind: 'real' }).where(eq(households.id, H));
    const me = await t.call('/api/me', 'b');
    expect(me.status).toBe(200);
    expect(me.body.canRead).toBeUndefined();
    expect((await t.call('/api/notices', 'b', notice('real'))).body.error).toBe(
      'testHouseholdOnly',
    );
    expect((await t.call('/api/utterances', 'b', say('real'))).body.error).toBe(
      'testHouseholdOnly',
    );
    expect(calls).toHaveLength(0);
    expect(heard).toHaveLength(0);
  });

  it('お知らせのすることは二人に確かめを出し、確かめる前は手配しない', async () => {
    const text = '12月12日（土）13:00から14:00まで、家の人は説明会に参加してください。';
    const reader: NoticeReader = async (request) => ({
      output: {
        items: [
          {
            id: 'i1',
            sentenceIds: [request.source.sentences[0]?.id ?? ''],
            kind: 'need',
            written: text,
            date: '2026-12-12',
            writtenWeekday: 'sat',
            startTime: '13:00',
            endTime: '14:00',
            what: '説明会への参加',
            dayType: null,
            deadline: null,
            audience: null,
            place: null,
            relativeDay: 'none',
            conditionNodeId: null,
            inferred: false,
            familyAction: false,
            shape: 'window',
            effects: [],
          },
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const t = await setup({ reader });
    await t.call('/api/me', 'a');
    const read = await t.call('/api/notices', 'b', notice('read-need', text));
    expect(read.status).toBe(200);
    const itemId = `${read.body.sourceId}:i1`;
    const requirement = read.body.view.plan.requirements.find((entry) =>
      entry.basis.itemIds.includes(itemId),
    );
    expect(requirement).toMatchObject({ kind: 'need', unconfirmed: true });
    expect(requirement?.date).toBeUndefined();
    expect(requirement?.by).toBeUndefined();
    expect(
      read.body.view.plan.arrangements.some((entry) => entry.requirementKey === requirement?.key),
    ).toBe(false);
    const other = await t.call('/api/view?as=a', 'a');
    expect(other.body.today.main.some((card) => card.kind === 'needCheck')).toBe(true);
    const confirmed = await t.call('/api/commands', 'a', {
      as: 'a',
      operationId: 'confirm-need',
      command: { type: 'confirmItem', itemId, seen: { throughSeq: other.body.throughSeq } },
    });
    expect(confirmed.status).toBe(200);
    expect(
      confirmed.body.view.plan.arrangements.some(
        (entry) => entry.requirementKey === requirement?.key,
      ),
    ).toBe(true);
  });

  it('身元・家庭・画面の Origin を通った大人だけがモデルを呼べる', async () => {
    const calls: ExtractRequest[] = [];
    const t = await setup({ reader: makeReader(calls) });
    expect((await t.call('/api/me', 'b')).body).toMatchObject({
      mode: 'family',
      memberId: 'b',
      canRead: true,
    });
    expect((await t.call('/api/notices', undefined, notice('missing'))).status).toBe(401);
    expect((await t.call('/api/notices', 'g', notice('helper'))).status).toBe(403);
    expect((await t.call('/api/notices', 'a', notice('switched'))).status).toBe(409);
    expect((await t.call('/api/notices', 'b', notice('empty-sentences', '。'))).status).toBe(400);
    expect(
      (await t.call('/api/notices', 'b', notice('origin'), { origin: 'https://elsewhere.test' }))
        .status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
    // 家族モードでも、認証の無いデモの入口は開かない。
    const session = await t.call('/api/demo/sessions', undefined, { stage: 'chase' });
    expect(session.body.canRead).toBe(false);
    expect(
      (
        await t.call(`/api/demo/sessions/${session.body.sessionId}/notices`, undefined, {
          memberId: 'b',
          ...notice('demo'),
        })
      ).status,
    ).toBe(503);
  });

  it('出典と読み取りを一度に保存し、再送・再起動後も二度読まず同じ出典を返す', async () => {
    const calls: ExtractRequest[] = [];
    const t = await setup({ reader: makeReader(calls) });
    const before = await t.all();
    const first = await t.call('/api/notices', 'b', notice('read-once'));
    expect(first.status).toBe(200);
    expect(first.body.sourceId).toMatch(/^u-[a-f0-9]{32}$/);
    expect(first.body.sourceId).not.toContain('延期');
    expect(
      first.body.view.sources.some((source: { id: string }) => source.id === first.body.sourceId),
    ).toBe(true);
    const added = (await t.all()).slice(before.length);
    expect(added[0]).toMatchObject({
      type: 'noticeReceived',
      actorId: 'b',
      source: { id: first.body.sourceId },
    });
    expect(added[1]).toMatchObject({
      type: 'modelOutputRecorded',
      actorId: 'system',
      sourceId: first.body.sourceId,
    });
    const again = await t.call('/api/notices', 'b', notice('read-once'));
    const restarted = await t.call('/api/notices', 'b', notice('read-once'), {}, t.makeApp());
    expect(again.body.sourceId).toBe(first.body.sourceId);
    expect(restarted.body.sourceId).toBe(first.body.sourceId);
    expect(calls).toHaveLength(1);
    expect(await t.all()).toHaveLength(before.length + added.length);
    expect((await t.call('/api/notices', 'b', notice('read-once', '別の文です。'))).status).toBe(
      409,
    );
    const storedEvents = await t.db.select().from(events);
    const storedOps = await t.db.select().from(operations);
    expect(JSON.stringify(storedEvents)).not.toContain(NOTICE);
    expect(JSON.stringify(storedOps)).not.toContain(NOTICE);
    expect(
      (
        await t.call('/api/commands', 'b', {
          as: 'b',
          operationId: 'withdraw-source',
          command: { type: 'withdrawSource', sourceId: first.body.sourceId },
        })
      ).status,
    ).toBe(200);
    expect((await t.call('/api/notices', 'b', notice('read-once'))).body.error).toBe(
      'readingStale',
    );
    expect(calls).toHaveLength(1);
  });

  it('読み取り中の別の変更はロックせず受け、古い前提の結果は足さない', async () => {
    const pending = gated(makeReader());
    const t = await setup({ reader: pending.read });
    await t.call('/api/me', 'a');
    const before = await t.all();
    const inFlight = t.call('/api/notices', 'b', notice('slow'));
    await pending.started;
    expect((await t.call('/api/notices', 'b', notice('second'))).status).toBe(429);
    const changed = await t.call('/api/commands', 'a', {
      as: 'a',
      operationId: 'other-change',
      command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    });
    expect(changed.status).toBe(200);
    pending.release();
    expect((await inFlight).body.error).toBe('readingStale');
    expect(
      (await t.all()).slice(before.length).some((event) => event.type === 'noticeReceived'),
    ).toBe(false);
    expect((await t.call('/api/notices', 'b', notice('slow'))).body.error).toBe('readingStale');
  });

  it('外部の読み取り中に権限が外れたら、結果も家庭の情報も返さない', async () => {
    const pending = gated(makeReader());
    const t = await setup({ reader: pending.read });
    const before = await t.all();
    const inFlight = t.call('/api/notices', 'b', notice('revoke'));
    await pending.started;
    await t.db
      .update(members)
      .set({ active: false })
      .where(and(eq(members.householdId, H), eq(members.id, 'b')));
    pending.release();
    const response = await inFlight;
    expect(response.status).toBe(403);
    expect(response.body.view).toBeUndefined();
    expect(await t.all()).toHaveLength(before.length);
  });

  it('読み取り中に家庭が test でなくなれば、戻った結果を保存しない', async () => {
    const pending = gated(makeReader());
    const t = await setup({ reader: pending.read });
    const before = await t.all();
    const inFlight = t.call('/api/notices', 'b', notice('kind-change'));
    await pending.started;
    await t.db.update(households).set({ kind: 'real' }).where(eq(households.id, H));
    pending.release();
    const response = await inFlight;
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('testHouseholdOnly');
    expect(await t.all()).toHaveLength(before.length);
  });

  it('呼び出し中に再起動した同じ操作は再送せず、結果不明とする', async () => {
    const calls: ExtractRequest[] = [];
    const pending = gated(makeReader(calls));
    const t = await setup({ reader: pending.read });
    const inFlight = t.call('/api/notices', 'b', notice('incomplete'));
    await pending.started;
    const afterRestart = await t.call('/api/notices', 'b', notice('incomplete'), {}, t.makeApp());
    expect(afterRestart.body.error).toBe('readingUncertain');
    const parallel = await t.call('/api/notices', 'b', notice('different'), {}, t.makeApp());
    expect(parallel.body.error).toBe('readingBusy');
    pending.release();
    expect((await inFlight).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('読み取りが失敗した時は半分の出典を残さず、同じ操作で外へ再送しない', async () => {
    let calls = 0;
    const t = await setup({
      reader: async () => {
        calls += 1;
        throw new Error('fictional-private-error');
      },
    });
    const before = await t.all();
    const failed = await t.call('/api/notices', 'b', notice('failed'));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain('fictional-private-error');
    const retry = await t.call('/api/notices', 'b', notice('failed'), {}, t.makeApp());
    expect(retry.status).toBe(502);
    expect(await t.all()).toHaveLength(before.length);
    expect(calls).toBe(1);
  });

  it.each(['committed', 'rollback'] as const)(
    '書き込みの返事が失われた時（%s）は、同じ操作で確かめ、二度読まない',
    async (where) => {
      const calls: ExtractRequest[] = [];
      const reader = makeReader(calls);
      const t = await setup({ reader });
      await t.call('/api/me', 'b');
      const store = failedWriteOnce(t.store, where);
      const app = createApp({ family: { ...t.family, store }, reader });
      const before = (await t.all()).filter((event) => event.type === 'noticeReceived').length;
      const input = notice(`write-${where}`);

      const first = await t.call('/api/notices', 'b', input, {}, app);
      expect(first.status).toBe(502);
      expect(first.body).toMatchObject({ error: 'readingFailed', reason: 'store' });
      const retry = await t.call('/api/notices', 'b', input, {}, app);
      if (where === 'committed') {
        expect(retry.status).toBe(200);
        expect(retry.body.sourceId).toBeTruthy();
      } else {
        expect(retry.status).toBe(409);
        expect(retry.body.error).toBe('readingUncertain');
      }
      const after = (await t.all()).filter((event) => event.type === 'noticeReceived');
      expect(after).toHaveLength(before + (where === 'committed' ? 1 : 0));
      expect(calls).toHaveLength(1);
    },
  );

  it('書く前のモデル失敗は、家族が新しい操作を選んだ時だけ読み直す', async () => {
    const calls: ExtractRequest[] = [];
    const success = makeReader(calls);
    let failed = false;
    const reader: NoticeReader = async (request) => {
      if (!failed) {
        failed = true;
        calls.push(request);
        throw new Error('fictional-model-failure');
      }
      return success(request);
    };
    const t = await setup({ reader });
    const original = notice('known-model-failure');
    const first = await t.call('/api/notices', 'b', original);
    expect(first.status).toBe(502);
    expect(first.body.error).toBe('readingFailed');
    expect((await t.call('/api/notices', 'b', original)).status).toBe(502);
    expect(calls).toHaveLength(1);
    expect((await t.call('/api/notices', 'b', notice('explicit-retry'))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('読み取りの途中で型の違う結果が来ても、出典だけを残さない', async () => {
    const base = makeReader();
    const reader: NoticeReader = async (request) => ({ ...(await base(request)), model: '' });
    const t = await setup({ reader });
    const before = await t.all();
    expect((await t.call('/api/notices', 'b', notice('bad-output'))).status).toBe(502);
    expect(await t.all()).toHaveLength(before.length);
  });

  it('時間切れで返事が不明な操作を、再起動後に自動で読み直さない', async () => {
    const t = await setup();
    await t.call('/api/me', 'b');
    const member = await memberFor(
      t.db,
      { issuer: 'test-issuer', subject: 'b' },
      t.family.invitations,
    );
    if (!member) throw new Error('大人が無い');
    const calls: ExtractRequest[] = [];
    const pending = gated(makeReader(calls));
    const service = familyInput({ store: t.store, timeoutMs: 10, clock: () => NOW });
    const input = { operationId: 'timeout', text: NOTICE, sender: 'school' as const };
    const before = await t.all();
    const first = service.notice(member, input, pending.read, async () => true);
    await pending.started;
    expect((await first).status).toBe('uncertain');
    const restarted = familyInput({ store: t.store, clock: () => NOW });
    expect(
      (await restarted.notice(member, input, makeReader(calls), async () => true)).status,
    ).toBe('uncertain');
    pending.release();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(await t.all()).toHaveLength(before.length);
  });

  it('別の test 家庭は、同じ成員 ID と操作 ID でも他の家庭の読み取りを見ない', async () => {
    const calls: ExtractRequest[] = [];
    const t = await setup({ reader: makeReader(calls), otherHousehold: true });
    const first = await t.call('/api/notices', 'b', notice('same-operation'));
    expect(first.status).toBe(200);
    const otherView = await t.call('/api/view?as=b', 'c');
    expect(otherView.status).toBe(200);
    expect(
      otherView.body.sources.some((source: { id: string }) => source.id === first.body.sourceId),
    ).toBe(false);
    const second = await t.call('/api/notices', 'c', notice('same-operation'));
    expect(second.status).toBe(200);
    expect(second.body.sourceId).not.toBe(first.body.sourceId);
    expect(calls).toHaveLength(2);
  });

  it('一日の上限は家庭の操作記録から数え、再起動でも増えない', async () => {
    const t = await setup();
    await t.call('/api/me', 'b');
    const member = await memberFor(
      t.db,
      { issuer: 'test-issuer', subject: 'b' },
      t.family.invitations,
    );
    if (!member) throw new Error('大人が無い');
    const calls: ExtractRequest[] = [];
    const first = familyInput({ store: t.store, dailyLimit: 1, clock: () => NOW });
    const sent = await first.notice(
      member,
      { operationId: 'one', text: NOTICE, sender: 'school' },
      makeReader(calls),
      async () => true,
    );
    expect(sent.status).toBe('ok');
    const restarted = familyInput({ store: t.store, dailyLimit: 1, clock: () => NOW });
    expect(
      (
        await restarted.notice(
          member,
          { operationId: 'two', text: NOTICE, sender: 'school' },
          makeReader(calls),
          async () => true,
        )
      ).status,
    ).toBe('limit');
    expect(calls).toHaveLength(1);
  });
});

describe('家族の家庭の一言', () => {
  it.each(['committed', 'rollback'] as const)(
    '候補の記録の返事が失われた時（%s）は、同じ操作で確かめ、二度聞かない',
    async (where) => {
      const calls: string[] = [];
      const listener = makeListener(calls);
      const t = await setup({ listener });
      await t.call('/api/me', 'b');
      const store = failedWriteOnce(t.store, where);
      const app = createApp({ family: { ...t.family, store }, listener });
      const before = await t.all();
      const input = say(`say-write-${where}`);

      const first = await t.call('/api/utterances', 'b', input, {}, app);
      expect(first.status).toBe(502);
      expect(first.body).toMatchObject({ error: 'readingFailed', reason: 'store' });
      const retry = await t.call('/api/utterances', 'b', input, {}, app);
      if (where === 'committed') {
        expect(retry.status).toBe(200);
        expect(retry.body.reply.kind).toBe('change');
        expect(retry.body.reply.proposals).toHaveLength(1);
      } else {
        expect(retry.status).toBe(409);
        expect(retry.body.error).toBe('readingUncertain');
      }
      expect(await t.all()).toHaveLength(before.length);
      expect(calls).toEqual(['b']);
    },
  );

  it.each([10, 40])(
    '読み取り中に %i 秒進んでも、事象が変わらなければ候補を返す',
    async (seconds) => {
      const calls: string[] = [];
      const pending = gated(makeListener(calls));
      let now = Date.parse('2026-11-25T19:40:30+09:00');
      const t = await setup({ listener: pending.read, clock: () => now });
      const operationId = `minute-${seconds}`;
      const inFlight = t.call('/api/utterances', 'b', say(operationId));
      await pending.started;
      now += seconds * 1000;
      pending.release();
      const result = await inFlight;
      expect(result.status).toBe(200);
      expect(result.body.reply.kind).toBe('change');
      // 同じ操作の返事が届かず、分が替わってから送り直しても再度モデルを呼ばない。
      now += 60_000;
      expect((await t.call('/api/utterances', 'b', say(operationId))).status).toBe(200);
      expect(calls).toEqual(['b']);
      const candidate = result.body.reply.proposals[0];
      if (!candidate) throw new Error('候補が無い');
      expect(
        (await t.call(`/api/proposals/${candidate.id}`, 'b', { as: 'b', operationId: 'confirm' }))
          .status,
      ).toBe(200);
    },
  );
  it('時間の過ぎた候補は確認できず、同じ読み取りを勝手に外へ送り直さない', async () => {
    const calls: string[] = [];
    const t = await setup();
    await t.call('/api/me', 'b');
    const member = await memberFor(
      t.db,
      { issuer: 'test-issuer', subject: 'b' },
      t.family.invitations,
    );
    if (!member) throw new Error('大人が無い');
    const service = familyInput({ store: t.store, clock: () => NOW, proposalTtlMs: 20 });
    const input = { operationId: 'short-lived', text: '返事が来ました' };
    const result = await service.utterance(member, input, makeListener(calls), async () => true);
    if (result.status !== 'ok' || result.reply.kind !== 'change') throw new Error('候補が無い');
    const id = result.reply.proposals[0]?.id;
    if (!id) throw new Error('候補が無い');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await service.confirm(member, id, 'late')).status).toBe('gone');
    expect(
      (await service.utterance(member, input, makeListener(calls), async () => true)).status,
    ).toBe('uncertain');
    expect(calls).toHaveLength(1);
  });

  it('中身が直された need の依頼は、送った時の控えを一言の前提にする', async () => {
    const contexts: UtteranceContext[] = [];
    let cancellation = false;
    const listener: UtteranceReader = async (context) => {
      contexts.push(context);
      const action = replyYes.actions[0];
      if (!action) throw new Error('返事の型が無い');
      return {
        output: {
          ...replyYes,
          actions: [
            {
              ...action,
              type: cancellation ? 'recordCancellationSent' : 'recordReply',
              requestId: 'r-new-need',
              reply: cancellation ? null : 'yes',
            },
          ],
        },
        model: 'test-model',
        promptVersion: 'test',
        inputHash: 'test',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    };
    const t = await setup({ listener });
    let serial = 0;
    const send = async (command: unknown) => {
      const result = await t.call('/api/commands', 'b', {
        as: 'b',
        operationId: `command-${serial++}`,
        command,
      });
      expect(result.status).toBe(200);
      return result.body.view;
    };
    const write = async (command: PreviewCommand) => {
      const preview = await t.call('/api/change-preview?as=b', 'b', { command });
      if (preview.status !== 200) throw new Error(`予覧できない：${JSON.stringify(preview.body)}`);
      expect(preview.status).toBe(200);
      const current = await t.call('/api/view?as=b', 'b');
      return send({
        ...command,
        seen: { throughSeq: current.body.throughSeq, changes: preview.body.preview.seen },
      });
    };
    let view = await write({
      type: 'stateNeed',
      text: '12月3日に元の用事をお願いします。',
      interpretation: {
        what: '元の用事',
        shape: 'window',
        date: '2026-12-03',
        startTime: '08:00',
        endTime: '18:00',
      },
    });
    const itemId = view.plan.requirements.find((entry) => entry.what === '元の用事')?.basis
      .itemIds[0];
    if (!itemId) throw new Error('することが無い');
    view = await write({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] });
    const arrangement = view.plan.arrangements.find((entry) => entry.kind === 'need');
    const option = arrangement?.options.find((entry) => entry.templateId === 'way-grandma');
    if (!arrangement || !option) throw new Error('案が無い');
    view = await send({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: 'b',
    });
    const task = view.plan.tasks.find(
      (entry) => entry.live && entry.basis.optionKey === option.key,
    );
    if (!task) throw new Error('頼む作業が無い');
    await send({
      type: 'recordSent',
      taskKey: task.key,
      requestId: 'r-new-need',
      window: { start: arrangement.start, end: arrangement.end },
    });
    view = await write({ type: 'correctItem', itemId, interpretation: { what: '新しい用事' } });
    const request = view.plan.requests.find((entry) => entry.requestId === 'r-new-need');
    expect(request).toMatchObject({
      live: true,
      needsCheck: true,
      askedNeed: { what: '元の用事' },
    });
    const heard = await t.call('/api/utterances', 'b', say('old-request'));
    expect(heard.status).toBe(200);
    const sent = contexts[0]?.requests.find((entry) => entry.id === 'r-new-need');
    expect(sent?.what).toContain('元の用事');
    expect(sent?.what).toContain(arrangement.start);
    expect(sent?.what).not.toContain('新しい用事');
    const candidate = heard.body.reply.proposals[0];
    if (!candidate) throw new Error('候補が無い');
    const beforeConfirmation = await t.all();
    const confirmed = await t.call(`/api/proposals/${candidate.id}`, 'b', {
      as: 'b',
      operationId: 'confirm-old',
    });
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error).toBe('proposalChanged');
    expect(await t.all()).toHaveLength(beforeConfirmation.length);
    // 頼み事の札の命令は、これまでどおり記録できる。
    const fromCard = await send({ type: 'recordReply', requestId: 'r-new-need', reply: 'yes' });
    expect(fromCard.plan.requests.find((entry) => entry.requestId === 'r-new-need')).toMatchObject({
      state: 'confirmed',
      needsCheck: true,
      askedNeed: { what: '元の用事' },
    });
    await write({ type: 'dismissItem', itemId, reason: 'other' });
    cancellation = true;
    const heardCancel = await t.call('/api/utterances', 'b', say('cancel-request'));
    expect(heardCancel.status).toBe(200);
    const candidateCancel = heardCancel.body.reply.proposals[0];
    if (!candidateCancel) throw new Error('取消の候補が無い');
    const beforeCancel = await t.all();
    const cancel = await t.call(`/api/proposals/${candidateCancel.id}`, 'b', {
      as: 'b',
      operationId: 'confirm-cancel',
    });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe('proposalChanged');
    expect(await t.all()).toHaveLength(beforeCancel.length);
    const cardCancel = await send({ type: 'recordCancellationSent', requestId: 'r-new-need' });
    expect(
      cardCancel.plan.requests.find((entry) => entry.requestId === 'r-new-need'),
    ).toMatchObject({
      state: 'cancelled',
    });
  }, 30_000);

  it('本人が候補を確かめた時だけ記録し、送り直しは再起動後も二重にならない', async () => {
    const calls: string[] = [];
    const t = await setup({ listener: makeListener(calls) });
    await t.call('/api/me', 'a');
    const before = await t.all();
    const heard = await t.call('/api/utterances', 'b', say('say'));
    expect(heard.status).toBe(200);
    expect(heard.body.reply.kind).toBe('change');
    expect(await t.all()).toHaveLength(before.length);
    const id = heard.body.reply.proposals[0]?.id;
    if (!id) throw new Error('候補が無い');
    expect(
      (await t.call(`/api/proposals/${id}`, 'a', { as: 'a', operationId: 'wrong' })).status,
    ).toBe(403);
    const confirmed = await t.call(`/api/proposals/${id}`, 'b', {
      as: 'b',
      operationId: 'confirm',
    });
    expect(confirmed.status).toBe(200);
    expect(
      confirmed.body.view.plan.requests.find(
        (entry: { requestId: string }) => entry.requestId === 'r-grandma',
      )?.state,
    ).toBe('confirmed');
    const count = (await t.all()).length;
    const again = await t.call(
      `/api/proposals/${id}`,
      'b',
      { as: 'b', operationId: 'confirm' },
      {},
      t.makeApp(),
    );
    expect(again.status).toBe(200);
    expect(await t.all()).toHaveLength(count);
    expect(
      (await t.call(`/api/proposals/${id}`, 'b', { as: 'b', operationId: 'new' }, {}, t.makeApp()))
        .status,
    ).toBe(404);
    expect(calls).toEqual(['b']);
  });

  it('家庭の一言は、異なる種類を含め未定の値が複数ある時に記録しない', async () => {
    let target = 'n1:u1';
    let now = NOW;
    const listener: UtteranceReader = async (context) => {
      const unknown = context.unknowns.find((entry) => entry.id === target);
      if (!unknown?.values[0]) throw new Error('架空の値が無い');
      return {
        output: {
          kind: 'change',
          actions: [
            {
              type: 'answer',
              taskKey: null,
              requestId: null,
              reply: null,
              unknownId: target,
              value: unknown.values[0],
            },
          ],
          refs: { taskKeys: [], requestIds: [], itemIds: [] },
          unsupported: null,
        },
        model: 'test-model',
        promptVersion: 'test',
        inputHash: 'test',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    };
    const reader: NoticeReader = async (request) => ({
      output: {
        items: [],
        unknowns: [
          {
            id: 'u2',
            label: '別の予定の日',
            values: ['2026-12-09', '2026-12-10'],
            kind: 'schedule',
          },
        ],
        conditions: [],
        irrelevantSentenceIds: request.source.sentences.map((sentence) => sentence.id),
        ambiguities: [],
      },
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const t = await setup({ listener, reader, clock: () => now });
    const first = await t.call('/api/utterances', 'b', say('unknown-one'));
    expect(first.status).toBe(200);
    expect(first.body.reply.proposals[0]).toMatchObject({ blocked: 'otherUnknowns' });
    target = 'u-atHome:n1:i5';
    const second = await t.call('/api/utterances', 'b', say('unknown-home'));
    expect(second.status).toBe(200);
    expect(second.body.reply.proposals[0]).toMatchObject({ blocked: 'otherUnknowns' });
    // 持ち物の期限が過ぎて一つになっても、最初に止めた候補は後から使わない。
    now = Date.parse('2026-12-06T09:00+09:00');
    const blocked = first.body.reply.proposals[0];
    if (!blocked) throw new Error('先の候補が無い');
    const denied = await t.call(`/api/proposals/${blocked.id}`, 'b', {
      as: 'b',
      operationId: 'confirm-blocked-unknown',
    });
    expect(denied.status).toBe(409);
    target = 'n1:u1';
    const only = await t.call('/api/utterances', 'b', say('unknown-only'));
    expect(only.status).toBe(200);
    expect(only.body.reply.proposals[0]).not.toHaveProperty('blocked');
    const read = await t.call(
      '/api/notices',
      'b',
      notice('another-unknown', '別の予定の日は未定です。'),
    );
    expect(read.status).toBe(200);
    target = 'n1:u1';
    const third = await t.call('/api/utterances', 'b', say('unknown-two'));
    expect(third.status).toBe(200);
    expect(third.body.reply.proposals[0]).toMatchObject({ blocked: 'otherUnknowns' });
    const old = only.body.reply.proposals[0];
    if (!old) throw new Error('先の候補が無い');
    const eventsBefore = await t.all();
    const outdated = await t.call(`/api/proposals/${old.id}`, 'b', {
      as: 'b',
      operationId: 'confirm-outdated-unknown',
    });
    expect(outdated.status).toBe(409);
    expect(outdated.body.error).toBe('proposalChanged');
    expect(await t.all()).toHaveLength(eventsBefore.length);
  }, 30_000);

  it('分をまたいでも、対象と見分けの条件が同じなら確認できる', async () => {
    let now = Date.parse('2026-11-25T19:40:30+09:00');
    const t = await setup({ listener: makeListener(), clock: () => now });
    const heard = await t.call('/api/utterances', 'b', say('clock-answer'));
    expect(heard.status).toBe(200);
    const candidate = heard.body.reply.proposals[0];
    if (!candidate) throw new Error('候補が無い');
    now += 40_000;
    const confirmed = await t.call(`/api/proposals/${candidate.id}`, 'b', {
      as: 'b',
      operationId: 'clock-confirm',
    });
    expect(confirmed.status).toBe(200);
  }, 30_000);

  it('見せた後に別の大人が返事を変えたら、古い候補を記録しない', async () => {
    const t = await setup({ listener: makeListener() });
    await t.call('/api/me', 'a');
    const heard = await t.call('/api/utterances', 'b', say('say'));
    const id = heard.body.reply.proposals[0]?.id;
    if (!id) throw new Error('候補が無い');
    expect(
      (
        await t.call('/api/commands', 'a', {
          as: 'a',
          operationId: 'other',
          command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
        })
      ).status,
    ).toBe(200);
    const confirmed = await t.call(`/api/proposals/${id}`, 'b', {
      as: 'b',
      operationId: 'confirm',
    });
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error).toBe('proposalChanged');
  });

  it('候補の確認記録に見せかけた別の命令では、候補が済んだと返さない', async () => {
    const t = await setup({ listener: makeListener() });
    const operationId = 'collision';
    const reserved = `family-input:confirm:${sha256Of([H, 'b', operationId])}`;
    expect(
      (
        await t.call('/api/commands', 'b', {
          as: 'b',
          operationId: reserved,
          command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
        })
      ).status,
    ).toBe(200);
    const result = await t.call('/api/proposals/unknown', 'b', { as: 'b', operationId });
    expect(result.status).toBe(409);
  });

  it('確認の前提だけ残った後、同じ操作 ID の別の命令を候補の完了と見なさない', async () => {
    const t = await setup({ listener: makeListener() });
    await t.call('/api/me', 'a');
    const heard = await t.call('/api/utterances', 'b', say('say'));
    const id = heard.body.reply.proposals[0]?.id;
    if (!id) throw new Error('候補が無い');
    const operationId = 'partial-confirm';
    await t.call('/api/commands', 'a', {
      as: 'a',
      operationId: 'other',
      command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    });
    const stale = await t.call(`/api/proposals/${id}`, 'b', { as: 'b', operationId });
    expect(stale.status).toBe(409);
    const reserved = `family-input:confirm:${sha256Of([H, 'b', operationId])}`;
    expect(
      (
        await t.call('/api/commands', 'b', {
          as: 'b',
          operationId: reserved,
          command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
        })
      ).status,
    ).toBe(200);
    const again = await t.call(
      `/api/proposals/${id}`,
      'b',
      { as: 'b', operationId },
      {},
      t.makeApp(),
    );
    expect(again.status).toBe(409);
  });

  it('同じ成員 ID を持つ別家庭は、他の家庭の一言の候補を確定できない', async () => {
    const t = await setup({ listener: makeListener(), otherHousehold: true });
    const heard = await t.call('/api/utterances', 'b', say('say'));
    const id = heard.body.reply.proposals[0]?.id;
    if (!id) throw new Error('候補が無い');
    const attempted = await t.call(`/api/proposals/${id}`, 'c', {
      as: 'b',
      operationId: 'other-home',
    });
    expect(attempted.status).toBe(403);
  });
});
