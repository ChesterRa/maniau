// Postgres の置き場所（02-foundation §6）を、移行を当てた PGlite の上で確かめる：乾かして戻すと元の
// 事象になる、事象の行に名前・文・値を残さない、命令の結果と事象がメモリの置き場所と同じ、中身が
// 消えていれば計画を作らない。並んだ書き込みは PGlite では試せない（接続が一つ）。本物の Postgres で
// 別に確かめる（§11）。
import { type Command, DomainEvent, type PreviewCommand, proposalSnapshot } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { dehydrate, PayloadCorrupt, PayloadGone, rehydrate } from '../src/db/dry';
import { events as eventRows, households, members, operations, payloads } from '../src/db/schema';
import { postgresStore, setupHousehold } from '../src/db/store';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore, type Store } from '../src/store';
import { bodyOf, database, H, seeded } from './pg';

const NOW = '2026-11-25T19:40+09:00';
const CARE = 'arr:childCare:n1:i6:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const ASK = `task:${GRANDMA}:ask`;
// デモの 12/7 の頼む時間（子の居場所の手配の区間）。送ったの記録には、画面で見せた頼む時間を付ける。
const DEMO_WINDOW = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };

/** 試験の家に無い種類の事象（形だけを確かめる。計画には入れない）。 */
function otherKinds(): DomainEvent[] {
  const at = '2026-11-26T09:00+09:00';
  const rows: [string, Record<string, unknown>][] = [
    ['b', { type: 'optionDropped', arrangementKey: CARE, optionKey: GRANDMA }],
    [
      'b',
      {
        type: 'commitmentChanged',
        taskKey: ASK,
        assigneeId: 'b',
        action: 'accept',
        basisSourceIds: ['n1'],
      },
    ],
    ['b', { type: 'cancellationSent', requestId: 'r-1' }],
    ['b', { type: 'requestRecordCorrected', requestId: 'r-1' }],
    ['b', { type: 'requestCheckResolved', requestId: 'r-1', decision: 'keep' }],
    [
      'system',
      {
        type: 'notified',
        notificationKey: 'k-1',
        toMemberId: 'a',
        channel: 'webPush',
        result: 'accepted',
        kind: 'question',
        content: { titleKey: 'notify.question', params: { name: '架空の名前' } },
        appVersion: '0.0.0',
      },
    ],
    ['b', { type: 'itemConfirmed', itemId: 'i1' }],
    ['b', { type: 'sourceExcluded', sourceId: 'n1', reason: 'misread' }],
    // うちの番かの言明は、言った時の用件と対象を持つ（名前の入りうる文なので、事象の行には置かない）。
    [
      'b',
      {
        type: 'turnStated',
        itemId: 'i1',
        ours: false,
        what: '架空の当番',
        audience: '架空の名前さんのおうち',
      },
    ],
    [
      'b',
      {
        type: 'escortStated',
        itemId: 'i1',
        leg: 'from',
        needed: false,
        childId: 'c',
        what: '架空の練習',
        date: '2026-12-05',
        at: null,
        place: '架空のグラウンド',
      },
    ],
    // 家族の言明の「すること」は、原文と解釈を持つ（行には出典の ID だけ）。
    [
      'b',
      {
        type: 'itemsStated',
        sourceId: 'f-1',
        items: [
          {
            id: 'f-1:i1',
            sourceId: 'f-1',
            sentenceIds: ['f-1#1'],
            kind: 'need',
            written: '架空の子を家で見る人が要る',
            interpretation: { what: '架空の子を家で見る', shape: 'by', deadline: at },
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    ],
    // やり方の選びの、選んだ時の中身の要約（原文の入りうる文）は、行に残さない。
    [
      'b',
      {
        type: 'needWaysSet',
        itemId: 'f-1:i1',
        wayIds: ['way-grandma'],
        about: '{"need":{"what":"架空の子を家で見る"}}',
      },
    ],
    ['b', { type: 'itemCorrected', itemId: 'i1', interpretation: { what: '架空の持ち物' } }],
    ['b', { type: 'itemDismissed', itemId: 'i1', reason: 'misread' }],
    ['b', { type: 'sourceWithdrawn', sourceId: 'n1' }],
    ['system', { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all' }],
    [
      'b',
      {
        type: 'transcriptionCorrected',
        sourceId: 'n1',
        sourceVersion: 2,
        sentences: [{ id: 'n1#1', text: '架空の書き直した文' }],
      },
    ],
    ['b', { type: 'clockAdvanced', to: at }],
    [
      'a',
      {
        type: 'needCandidatesSet',
        itemId: 's1:i1',
        candidates: [
          { id: 'c1', rev: 1, date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
          { id: 'c2', rev: 1, date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
        ],
      },
    ],
    [
      'a',
      {
        type: 'needPeopleSet',
        itemId: 's1:i1',
        people: [
          { id: 'g', kind: 'member' },
          { id: 'g-1a2b3c4d', kind: 'guest', name: '架空の近所の人' },
        ],
        required: [],
        minCount: 1,
      },
    ],
    [
      'link',
      {
        type: 'availabilityRecorded',
        itemId: 's1:i1',
        candidateId: 'c1',
        rev: 1,
        personId: 'g-1a2b3c4d',
        answer: 'maybe',
        note: '架空の条件',
        source: 'link',
        linkId: 'l-1',
      },
    ],
    [
      'a',
      {
        type: 'answerLinkIssued',
        itemId: 's1:i1',
        personId: 'g-1a2b3c4d',
        linkId: 'l-1',
        tokenHash: 'a'.repeat(64),
      },
    ],
    ['a', { type: 'answerLinkRevoked', itemId: 's1:i1', personId: 'g-1a2b3c4d', linkId: 'l-1' }],
    [
      'b',
      {
        type: 'candidateChosen',
        itemId: 's1:i1',
        candidateId: 'c1',
        rev: 1,
        basis: '{"people":["g"]}',
      },
    ],
  ];
  return rows.map(([actorId, fields], i) =>
    DomainEvent.parse({
      id: `x-${i + 1}`,
      householdId: H,
      seq: i + 1,
      version: 1,
      occurredAt: at,
      recordedAt: at,
      actorId,
      ...fields,
    }),
  );
}

const everyKind = () => [...DEMO_STAGES.flatMap((s) => demoEvents(s.id)), ...otherKinds()];

describe('乾かす・戻す（§6.2）', () => {
  it('全ての種類の事象が、乾かして戻すと元と同じになる', () => {
    const all = everyKind();
    const kinds = new Set(all.map((e) => e.type));
    expect(kinds.size).toBe(DomainEvent.options.length);
    for (const event of all) {
      const { row, payload } = dehydrate(event);
      expect(rehydrate(event.householdId, row, payload?.body, payload !== undefined)).toEqual(
        event,
      );
    }
  });

  it('事象の行に、家族の名前・場所・原文・答えの値を残さない', () => {
    const all = everyKind();
    const household = all.find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家族の情報が無い');
    const secrets = [
      ...household.household.members.flatMap((m) => [m.name, m.addressAs ?? '']),
      ...household.household.places.map((p) => p.name),
      ...all.flatMap((e) =>
        e.type === 'noticeReceived' ? e.source.sentences.map((s) => s.text) : [],
      ),
      ...all.flatMap((e) =>
        e.type === 'transcriptionCorrected' ? e.sentences.map((s) => s.text) : [],
      ),
      '架空の名前',
      '架空の持ち物',
      '架空の当番',
      '架空の近所の人',
      '架空の条件',
    ].filter((s) => s.length >= 2);
    expect(secrets.length).toBeGreaterThan(10);
    for (const event of all) {
      const shown = JSON.stringify(dehydrate(event).row);
      for (const secret of secrets) expect(shown).not.toContain(secret);
    }
    // 答えの値も、うちの番かも、事象の行には置かない。
    for (const event of all.filter((e) => e.type === 'answered')) {
      expect(dehydrate(event).row.body).toEqual({ unknownId: event.unknownId });
    }
    for (const event of all.filter((e) => e.type === 'turnStated')) {
      expect(dehydrate(event).row.body).toEqual({ itemId: event.itemId });
    }
    // 引き受けの根拠のお知らせ（出典の ID）は、行に残す（ID だけ）。
    expect(
      all
        .filter((e) => e.type === 'commitmentChanged' && e.basisSourceIds !== undefined)
        .map((e) => dehydrate(e).row.body),
    ).toContainEqual({ taskKey: ASK, assigneeId: 'b', action: 'accept', basisSourceIds: ['n1'] });
    // 送り迎えの要否と、言った時の子・用件・日・時刻・場所は、行に残さない。
    for (const event of all.filter((e) => e.type === 'escortStated')) {
      expect(dehydrate(event).row.body).toEqual({ itemId: event.itemId, leg: event.leg });
    }
    // 家族の言明の原文と解釈、やり方を選んだ時の中身の要約は、行に残さない。
    for (const event of all.filter((e) => e.type === 'itemsStated')) {
      expect(dehydrate(event).row.body).toEqual({ sourceId: event.sourceId });
    }
    for (const event of all.filter((e) => e.type === 'needWaysSet')) {
      expect(dehydrate(event).row.body).toEqual({ itemId: event.itemId, wayIds: event.wayIds });
    }
  });

  it('中身のハッシュは中身にだけ置き、鍵の順によらない', () => {
    const notice = everyKind().find((e) => e.type === 'noticeReceived');
    if (!notice) throw new Error('お知らせが無い');
    const { row, payload } = dehydrate(notice);
    expect(JSON.stringify(row)).not.toContain(payload?.sha256 ?? 'none');
    const reordered = DomainEvent.parse(
      Object.fromEntries(Object.entries(notice).reverse()) as unknown,
    );
    expect(dehydrate(reordered).payload?.sha256).toBe(payload?.sha256);
  });

  it('中身が無ければ戻さずに投げる（壊れた記録で計画を作らない）', () => {
    const notice = everyKind().find((e) => e.type === 'noticeReceived');
    if (!notice) throw new Error('お知らせが無い');
    const { row } = dehydrate(notice);
    expect(() => rehydrate(notice.householdId, row, undefined, true)).toThrow(PayloadGone);
  });
});

describe('Postgres の置き場所', () => {
  it('入れた事象を、同じ順・同じ中身で読み戻す。表の事象には中身の ID だけを置く', async () => {
    const db = await database();
    const source = demoEvents('postponed');
    const store = await seeded(db, H, source);
    const read = await store.withHousehold(H, (log) => [...log.events()]);
    expect(read.map(bodyOf)).toEqual(source.map(bodyOf));
    expect(read.map((e) => e.seq)).toEqual(source.map((_, i) => i + 1));
    const rows = await db.select().from(eventRows).where(eq(eventRows.householdId, H));
    const notice = rows.find((r) => r.type === 'noticeReceived');
    expect(notice?.body).toMatchObject({ payloadId: `${notice?.id}:payload` });
    expect(JSON.stringify(notice?.body)).not.toContain('sentences');
  });

  it('命令の結果と足した事象が、メモリの置き場所と同じ。同じ操作 ID は二度書かない', async () => {
    const db = await database();
    const source = demoEvents('arrived');
    const stores: Store[] = [memoryStore(new Map([[H, source]])), await seeded(db, H, source)];
    const results = await Promise.all(
      stores.map(async (store) => {
        const run = (memberId: string, operationId: string, command: Command) =>
          runCommand(store, H, { memberId, operationId, now: NOW, demo: false }, command);
        const out = [];
        out.push(
          await run('b', 'op-1', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' }),
        );
        const plan = computePlan(await store.withHousehold(H, (log) => [...log.events()]), NOW);
        const task = plan.tasks.find((t) => t.key === ASK);
        const shown = task && proposalSnapshot(task);
        if (!shown) throw new Error('置けていない');
        out.push(await run('b', 'op-2', { type: 'accept', taskKey: ASK, shown }));
        // 同じ操作 ID・同じ中身の送り直しは、何も足さない。中身が違えば衝突。
        out.push(await run('b', 'op-2', { type: 'accept', taskKey: ASK, shown }));
        out.push(await run('b', 'op-2', { type: 'commitment', taskKey: ASK, action: 'decline' }));
        // 本人でない大人の引き受けは断る（事象を足さない）。
        out.push(await run('a', 'op-3', { type: 'accept', taskKey: ASK, shown }));
        out.push(
          await run('b', 'op-4', {
            type: 'recordSent',
            taskKey: ASK,
            requestId: 'r-grandma',
            window: DEMO_WINDOW,
          }),
        );
        const events = await store.withHousehold(H, (log) => [...log.events()]);
        return { out, events: events.map((e) => [e.seq, e.actorId, bodyOf(e)]) };
      }),
    );
    const [memory, postgres] = results;
    expect(postgres?.out).toEqual(memory?.out);
    expect(postgres?.events).toEqual(memory?.events);
    expect(memory?.out.map((r) => r.status)).toEqual([
      'ok',
      'ok',
      'noop',
      'conflict',
      'forbidden',
      'ok',
    ]);
  });

  it('値を持つ命令（答え・事項の直し）でも、事象の行と操作の記録に本文を残さない', async () => {
    const db = await database();
    const source = demoEvents('arrived');
    const store = await seeded(db, H, source);
    const plan = computePlan(source, NOW);
    const question = plan.questions[0];
    if (!question) throw new Error('問いが無い');
    // 家にあるかの問いなら、画面が見せた品物の名前を控えに付ける（答えの中身として payloads に置く）。
    const purchase = plan.arrangements.find((a) => a.atHomeUnknownId === question.unknownId);
    const what = plan.requirements.find((r) => r.key === purchase?.requirementKey)?.what;
    const marker = '架空の秘密の印';
    const run = (operationId: string, command: Command) =>
      runCommand(store, H, { memberId: 'b', operationId, now: NOW, demo: false }, command);
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: 'n1:i5',
      interpretation: { what: marker },
    };
    // 答えを先に（事項を直すと、その事項の問いは要らなくなる）。
    expect(
      (
        await run('op-2', {
          type: 'answer',
          unknownId: question.unknownId,
          value: 'no',
          ...(what ? { seen: { what, throughSeq: plan.throughSeq } } : {}),
        })
      ).status,
    ).toBe('ok');
    const shown = await previewChange(
      await store.withHousehold(H, (log) => [...log.events()]),
      { memberId: 'b', now: NOW },
      correction,
    );
    if ('status' in shown) throw new Error(`直す内容を見られない: ${shown.reason}`);
    const correct: Command = {
      ...correction,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    };
    expect((await run('op-1', correct)).status).toBe('ok');
    // 要約で、同じ中身の送り直しと、違う中身の使い回しを見分ける。
    expect((await run('op-1', correct)).status).toBe('noop');
    expect((await run('op-1', { ...correct, interpretation: { what: 'ほかの印' } })).status).toBe(
      'conflict',
    );
    const ops = await db.select().from(operations).where(eq(operations.householdId, H));
    expect(ops).toHaveLength(2);
    for (const op of ops) expect(op.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ops)).not.toContain(marker);
    const rows = await db.select().from(eventRows).where(eq(eventRows.householdId, H));
    expect(JSON.stringify(rows)).not.toContain(marker);
    const answered = rows.find((r) => r.type === 'answered');
    expect(answered?.body).toEqual({
      unknownId: question.unknownId,
      payloadId: `${answered?.id}:payload`,
    });
    if (what) expect(JSON.stringify(rows)).not.toContain(what);
    // 中身は payloads にだけある（戻せば元の値）。
    const contents = await db.select().from(payloads).where(eq(payloads.householdId, H));
    expect(JSON.stringify(contents)).toContain(marker);
    const read = await store.withHousehold(H, (log) => [...log.events()]);
    const corrected = read.find((e) => e.type === 'itemCorrected');
    expect(corrected?.type === 'itemCorrected' && corrected.interpretation.what).toBe(marker);
  });

  it('処理の途中で投げたら、事象も操作も書かない（メモリの置き場所も同じ）', async () => {
    const db = await database();
    const stores: Store[] = [
      memoryStore(new Map([[H, demoEvents('arrived')]])),
      await seeded(db, H, demoEvents('arrived')),
    ];
    for (const store of stores) {
      const before = await store.withHousehold(H, (log) => log.events().length);
      await expect(
        store.withHousehold(H, (log) => {
          log.append([{ type: 'itemConfirmed', itemId: 'i1' }], 'b', '2026-11-25T19:41+09:00');
          log.recordOperation({ id: 'op-x', actorId: 'b', digest: '{}', throughSeq: before + 1 });
          throw new Error('途中で失敗');
        }),
      ).rejects.toThrow('途中で失敗');
      const after = await store.withHousehold(H, (log) => ({
        count: log.events().length,
        op: log.operation('op-x'),
      }));
      expect(after).toEqual({ count: before, op: undefined });
    }
  });

  it('中身が消えた事象があれば、家庭を読まずに投げる', async () => {
    const db = await database();
    const store = await seeded(db, H, demoEvents('arrived'));
    await db.update(payloads).set({ body: null, deletedAt: new Date(), deletedReason: 'test' });
    await expect(store.withHousehold(H, (log) => log.events().length)).rejects.toThrow(PayloadGone);
  });

  it('中身が書いた時のハッシュと合わなければ、家庭を読まずに投げる（中身だけを書き換えた時）', async () => {
    const db = await database();
    const store = await seeded(db, H, demoEvents('arrived'));
    const [notice] = await db
      .select()
      .from(payloads)
      .where(and(eq(payloads.householdId, H), eq(payloads.kind, 'noticeReceived')));
    if (!notice?.body) throw new Error('お知らせの中身が無い');
    const body = notice.body as { source: { sentences: { id: string; text: string }[] } };
    const changed = {
      ...body,
      source: {
        ...body.source,
        sentences: body.source.sentences.map((s, i) =>
          i === 0 ? { ...s, text: '書き換えた文' } : s,
        ),
      },
    };
    await db
      .update(payloads)
      .set({ body: changed })
      .where(and(eq(payloads.householdId, H), eq(payloads.id, notice.id)));
    await expect(store.withHousehold(H, (log) => log.events().length)).rejects.toThrow(
      PayloadCorrupt,
    );
  });

  it('家庭を作る時は、家族の情報の ID で、家庭の行・成員の行・家族の情報を一度に作る。途中で失敗すれば何も残さない', async () => {
    const db = await database();
    const set = demoEvents('arrived').find((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家族の情報が無い');
    await setupHousehold(db, 'test', set.household, '2026-11-24T21:00+09:00');
    const read = await postgresStore(db).withHousehold(H, (log) => [...log.events()]);
    expect(read.map((e) => [e.type, e.householdId, e.actorId])).toEqual([
      ['householdSet', H, 'system'],
    ]);
    // 型に合わない家族の情報は、成員の行を足した後でも、家庭ごと残さない。
    const broken = {
      ...set.household,
      id: 'broken',
      members: [...set.household.members, { id: 'x', kind: 'adult', name: '' }],
    } as typeof set.household;
    await expect(setupHousehold(db, 'test', broken, '2026-11-24T21:00+09:00')).rejects.toThrow();
    expect(await db.select().from(households).where(eq(households.id, 'broken'))).toEqual([]);
    expect(await db.select().from(members).where(eq(members.householdId, 'broken'))).toEqual([]);
  });

  it('無い家庭は投げる', async () => {
    const db = await database();
    await expect(postgresStore(db).withHousehold('none', () => 1)).rejects.toThrow('家庭が無い');
  });
});
