// いつにするかの候補のある「すること」（02-foundation §3.4）：サーバーの命令（候補・名簿・答え・リンク・決める）と、
// 相手の頁の口（一人ずつのリンク）。架空の家。
import {
  type Command,
  DomainEvent,
  Household,
  type PlanResult,
  proposalSnapshot,
  type SaveablePreview,
  taskContent,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { answerView, type LinkEntry, submitAnswer } from '../src/answer-link';
import { answerTokenHash, runCommand } from '../src/commands';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const COST = { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 };

function initialHousehold() {
  return Household.parse({
    id: 'when-home',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a', kind: 'adult', name: 'アキ' },
      { id: 'b', kind: 'adult', name: 'ボウ' },
      { id: 'k', kind: 'child', name: 'コウ' },
      { id: 'g', kind: 'helper', name: 'おばあちゃん' },
    ],
    places: [{ id: 'home', kind: 'home', name: '家' }],
    routines: ['a', 'b'].flatMap((memberId) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        memberId,
        weekday,
        segments: [{ start: '00:00', end: '23:59', kind: 'home', placeId: 'home' }],
      })),
    ),
    careOptions: [],
    ways: [
      {
        id: 'ask-g',
        name: 'おばあちゃんに頼む',
        deadline: { type: 'daysBefore', days: 1, at: '21:00' },
        steps: [
          {
            id: 'ask',
            name: 'おばあちゃんに、子を見てもらうよう頼む',
            durationMin: 5,
            segments: ['home'],
            waitAfterMin: 0,
            external: { to: 'g', kind: 'reply' },
            assigneeId: 'a',
            cover: true,
          },
        ],
        cost: COST,
      },
    ],
  });
}

const START = '2026-12-01T09:00+09:00';

function setup() {
  const household = initialHousehold();
  const householdSet = DomainEvent.parse({
    type: 'householdSet',
    household,
    id: 'initial',
    householdId: household.id,
    seq: 1,
    version: 1,
    occurredAt: START,
    recordedAt: START,
    actorId: 'a',
  });
  const store = memoryStore(new Map([[household.id, [householdSet]]]));
  const events = () => store.withHousehold(household.id, (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Command, memberId = 'a', demo = true, operationId?: string) =>
    runCommand(
      store,
      household.id,
      { memberId, now: START, operationId: operationId ?? `when-${++sequence}`, demo },
      command,
    );
  const save = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'a', now: START }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const plan = async () => computePlan(await events(), START);
  const link = (entry: Omit<LinkEntry, 'householdId'>, hash: string) => ({
    view: () =>
      store.withHousehold(household.id, (log) =>
        answerView(log, { householdId: household.id, ...entry }, hash),
      ),
    submit: (body: Parameters<typeof submitAnswer>[3]) =>
      store.withHousehold(household.id, (log) =>
        submitAnswer(log, { householdId: household.id, ...entry }, hash, body, START),
      ),
  });
  return { events, run, save, plan, link };
}

type Harness = ReturnType<typeof setup>;

const requirementOf = (plan: PlanResult) => {
  const found = plan.requirements.find((r) => r.kind === 'need' && r.live);
  if (!found) throw new Error('「すること」の要件が無い');
  return found;
};
const whenOf = (plan: PlanResult) => {
  const when = requirementOf(plan).when;
  if (!when) throw new Error('いつの段が無い');
  return when;
};

/** 候補つきの「すること」（12/9 と 12/11 の 13〜15 時）を言い、やり方を選び、事項の ID を返す。 */
async function stateCandidates(h: Harness) {
  expect(
    await h.save({
      type: 'stateNeed',
      text: '12/9 か 12/11 の 13 時から 15 時、子を見てもらう。',
      interpretation: { what: '子を見てもらう', shape: 'window', forMemberId: 'k' },
      candidates: [
        { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
        { date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
      ],
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = requirementOf(await h.plan()).basis.itemIds[0];
  if (!itemId) throw new Error('事項が無い');
  expect(await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-g'] })).toMatchObject({
    status: 'ok',
  });
  return itemId;
}

async function people(h: Harness, itemId: string, minCount = 1) {
  const result = await h.run({
    type: 'setNeedPeople',
    itemId,
    members: ['g'],
    guests: [{ name: '近所のサトウさん' }],
    required: [],
    minCount,
  });
  expect(result).toMatchObject({ status: 'ok' });
  const when = whenOf(await h.plan());
  const guest = when.people.find((p) => p.kind === 'guest');
  if (!guest) throw new Error('名前だけの相手が無い');
  return guest.id;
}

describe('いつにするかの候補（サーバーの命令）', () => {
  it('候補つきの言明：候補に c1・c2 と代 1 を付け、日を決めるまで手配を作らない', async () => {
    const h = setup();
    await stateCandidates(h);
    const plan = await h.plan();
    const when = whenOf(plan);
    expect(when.candidates.map((c) => [c.id, c.rev, c.date])).toEqual([
      ['c1', 1, '2026-12-09'],
      ['c2', 1, '2026-12-11'],
    ]);
    expect(plan.arrangements.filter((a) => a.kind === 'need' && a.live)).toEqual([]);
    // 名簿が無いうちは、だれの答えで決めるか分からない（数えず、勧めない）。
    expect(when.candidates.every((c) => c.condition === 'open')).toBe(true);
    expect(when.recommended).toBeUndefined();
  });

  it('候補つきは窓の形だけ。言明の日と時刻は落とし、候補が持つ', async () => {
    const h = setup();
    const shown = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      {
        type: 'stateNeed',
        text: '締切までに出す',
        interpretation: { what: '出す', shape: 'by', deadline: '2026-12-10T12:00+09:00' },
        candidates: [
          { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
          { date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
        ],
      },
    );
    expect(shown).toMatchObject({ status: 'invalid', reason: 'candidatesNeedWindow' });
    const same = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      {
        type: 'stateNeed',
        text: '同じ時の候補',
        interpretation: { what: '見てもらう', shape: 'window' },
        candidates: [
          { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
          { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
        ],
      },
    );
    expect(same).toMatchObject({ status: 'invalid', reason: 'candidateDuplicate' });
  });

  it('候補を置き直す：時刻を変えた候補だけ代を進め、消した候補の ID を使い回さない', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    expect(
      await h.save({
        type: 'setNeedCandidates',
        itemId,
        candidates: [
          { id: 'c1', date: '2026-12-09', startTime: '14:00', endTime: '16:00' },
          { date: '2026-12-12', startTime: '10:00', endTime: '12:00' },
        ],
      }),
    ).toMatchObject({ status: 'ok' });
    expect(whenOf(await h.plan()).candidates.map((c) => [c.id, c.rev, c.start])).toEqual([
      ['c1', 2, '2026-12-09T14:00+09:00'],
      ['c3', 1, '2026-12-12T10:00+09:00'],
    ]);
    // 消した c2 を id で戻すことはできない（知らない候補）。
    const back = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      {
        type: 'setNeedCandidates',
        itemId,
        candidates: [
          { id: 'c2', date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
          { id: 'c3', date: '2026-12-12', startTime: '10:00', endTime: '12:00' },
        ],
      },
    );
    expect(back).toMatchObject({ status: 'invalid', reason: 'candidateUnknown' });
  });

  it('名簿：家の大人・頼める人・名前だけの相手。知らない人・子・要る人の外・人数の超えを断る', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    const base = { type: 'setNeedPeople' as const, itemId, guests: [], required: [], minCount: 1 };
    expect(await h.run({ ...base, members: ['k'] })).toMatchObject({
      status: 'invalid',
      reason: 'personUnknown',
    });
    expect(await h.run({ ...base, members: ['zz'] })).toMatchObject({
      status: 'invalid',
      reason: 'personUnknown',
    });
    expect(await h.run({ ...base, members: ['g'], required: ['b'] })).toMatchObject({
      status: 'invalid',
      reason: 'requiredNotInPeople',
    });
    expect(await h.run({ ...base, members: ['g'], minCount: 2 })).toMatchObject({
      status: 'invalid',
      reason: 'minCountTooLarge',
    });
    expect(
      await h.run({ ...base, members: ['g'], guests: [{ id: 'g-unknown', name: 'だれか' }] }),
    ).toMatchObject({ status: 'invalid', reason: 'personUnknown' });
    const guest = await people(h, itemId);
    expect(guest).toMatch(/^g-[0-9a-f]{8}$/);
    // 同じ名簿をもう一度送っても、何も足さない（名前だけの相手は id で送る）。
    expect(
      await h.run({
        ...base,
        members: ['g'],
        guests: [{ id: guest, name: '近所のサトウさん' }],
      }),
    ).toMatchObject({ status: 'noop' });
  });

  it('答え：自分は self、ほかの人は family。古い代・名簿の外・取り下げの一言を断る', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    await h.run({
      type: 'setNeedPeople',
      itemId,
      members: ['a', 'g'],
      guests: [],
      required: [],
      minCount: 1,
    });
    const answer = { type: 'recordAvailability' as const, itemId, candidateId: 'c1', rev: 1 };
    expect(await h.run({ ...answer, personId: 'a', answer: 'yes' })).toMatchObject({
      status: 'ok',
    });
    expect(
      await h.run({ ...answer, personId: 'g', answer: 'maybe', note: '午後なら' }, 'b'),
    ).toMatchObject({ status: 'ok' });
    const when = whenOf(await h.plan());
    expect(when.answers.map((x) => [x.personId, x.value, x.sources[0]?.source])).toEqual([
      ['a', 'yes', 'self'],
      ['g', 'maybe', 'family'],
    ]);
    expect(when.candidates[0]?.condition).toBe('meets');
    expect(await h.run({ ...answer, rev: 2, personId: 'a', answer: 'no' })).toMatchObject({
      status: 'conflict',
      reason: 'candidateChanged',
    });
    expect(await h.run({ ...answer, personId: 'b', answer: 'no' })).toMatchObject({
      status: 'invalid',
      reason: 'personUnknown',
    });
    expect(
      await h.run({ ...answer, personId: 'a', answer: 'withdrawn', note: '取り消し' }),
    ).toMatchObject({ status: 'invalid', reason: 'noteWithoutAnswer' });
  });

  it('リンク：家族の家庭では出さない。デモでは鍵を一度だけ返し、送り直しには付けない', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    const guest = await people(h, itemId);
    const issue = { type: 'issueAnswerLink' as const, itemId, personId: guest };
    expect(await h.run(issue, 'a', false)).toMatchObject({
      status: 'forbidden',
      reason: 'linksDemoOnly',
    });
    const first = await h.run(issue, 'a', true, 'link-op');
    if (first.status !== 'ok' || !first.answerLink) throw new Error('鍵が無い');
    expect(first.answerLink.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await h.run(issue, 'a', true, 'link-op');
    expect(again).toMatchObject({ status: 'noop' });
    expect('answerLink' in again).toBe(false);
    // 事象と計画には鍵を置かない（sha256 だけ。計画はリンクがあるかだけ）。
    const recorded = JSON.stringify(await h.events());
    expect(recorded).not.toContain(first.answerLink.token);
    expect(recorded).toContain(answerTokenHash(first.answerLink.token));
    const plan = JSON.stringify(await h.plan());
    expect(plan).not.toContain(answerTokenHash(first.answerLink.token));
    expect(whenOf(await h.plan()).links).toContainEqual({ personId: guest, active: true });
  });

  it('リンクの頁：その人の物だけを見せ、答えを書く。見た後の別の答え・古い代・操作 ID の使い回しを断る', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    const guest = await people(h, itemId);
    await h.run({
      type: 'recordAvailability',
      itemId,
      candidateId: 'c1',
      rev: 1,
      personId: 'g',
      answer: 'no',
    });
    const issued = await h.run({ type: 'issueAnswerLink', itemId, personId: guest });
    if (issued.status !== 'ok' || !issued.answerLink) throw new Error('鍵が無い');
    const hash = answerTokenHash(issued.answerLink.token);
    const page = h.link({ itemId, personId: guest }, hash);
    const view = await page.view();
    expect(view).toEqual({
      what: '子を見てもらう',
      name: '近所のサトウさん',
      candidates: [
        {
          id: 'c1',
          rev: 1,
          date: '2026-12-09',
          startTime: '13:00',
          endTime: '15:00',
          seenSeq: 0,
        },
        {
          id: 'c2',
          rev: 1,
          date: '2026-12-11',
          startTime: '13:00',
          endTime: '15:00',
          seenSeq: 0,
        },
      ],
    });
    // ほかの人（おばあちゃん）の答えと名前は出さない。
    expect(JSON.stringify(view)).not.toContain('おばあちゃん');
    const answered = await page.submit({
      operationId: 'tab-1',
      candidateId: 'c1',
      rev: 1,
      seenSeq: 0,
      answer: 'maybe',
      note: '午後なら',
    });
    expect(answered).toMatchObject({ status: 'ok' });
    if (answered.status !== 'ok') throw new Error('書けない');
    const seen = answered.view.candidates[0]?.seenSeq ?? 0;
    expect(answered.view.candidates[0]).toMatchObject({ answer: 'maybe', note: '午後なら' });
    expect(seen).toBeGreaterThan(0);
    // 送り直しは同じ結果。同じ操作 ID で中身が違えば断る。
    expect(
      await page.submit({
        operationId: 'tab-1',
        candidateId: 'c1',
        rev: 1,
        seenSeq: 0,
        answer: 'maybe',
        note: '午後なら',
      }),
    ).toMatchObject({ status: 'noop' });
    expect(
      await page.submit({
        operationId: 'tab-1',
        candidateId: 'c1',
        rev: 1,
        seenSeq: 0,
        answer: 'no',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'operationIdReused' });
    // 別のタブ（前に見た番号のまま）は、黙って上書きしない。
    expect(
      await page.submit({
        operationId: 'tab-2',
        candidateId: 'c1',
        rev: 1,
        seenSeq: 0,
        answer: 'no',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'answerChanged' });
    expect(
      await page.submit({
        operationId: 'tab-3',
        candidateId: 'c1',
        rev: 2,
        seenSeq: seen,
        answer: 'no',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'candidateChanged' });
    // 計画では「リンクから」の答えとして数える（本人の確かめとは言わない）。
    const when = whenOf(await h.plan());
    expect(when.answers.find((x) => x.personId === guest)?.sources).toMatchObject([
      { source: 'link', answer: 'maybe', note: '午後なら', by: 'link' },
    ]);
    // 取り下げは、未回答に戻す。
    const withdrawn = await page.submit({
      operationId: 'tab-4',
      candidateId: 'c1',
      rev: 1,
      seenSeq: seen,
      answer: 'withdrawn',
    });
    expect(withdrawn).toMatchObject({ status: 'ok' });
    expect(whenOf(await h.plan()).answers.some((x) => x.personId === guest)).toBe(false);
  });

  it('リンクの頁：止める・出し直す・名簿から外すと、古い鍵は効かない', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    const guest = await people(h, itemId);
    const issue = async () => {
      const issued = await h.run({ type: 'issueAnswerLink', itemId, personId: guest });
      if (issued.status !== 'ok' || !issued.answerLink) throw new Error('鍵が無い');
      return h.link({ itemId, personId: guest }, answerTokenHash(issued.answerLink.token));
    };
    const first = await issue();
    expect(await first.view()).toBeDefined();
    const second = await issue();
    expect(await first.view()).toBeUndefined();
    expect(await second.view()).toBeDefined();
    expect(await h.run({ type: 'revokeAnswerLink', itemId, personId: guest })).toMatchObject({
      status: 'ok',
    });
    expect(await second.view()).toBeUndefined();
    expect(
      await second.submit({
        operationId: 'x',
        candidateId: 'c1',
        rev: 1,
        seenSeq: 0,
        answer: 'yes',
      }),
    ).toEqual({ status: 'unauthorized' });
    const third = await issue();
    expect(await third.view()).toBeDefined();
    // 名簿から外すと、同じ命令の中でリンクを止める。
    await h.run({
      type: 'setNeedPeople',
      itemId,
      members: ['g'],
      guests: [],
      required: [],
      minCount: 1,
    });
    expect(await third.view()).toBeUndefined();
    expect(whenOf(await h.plan()).links).toEqual([{ personId: 'g', active: false }]);
  });

  it('決める：根拠を控え、決めた日が窓になる。後で答えが変われば確かめ待ち', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    await people(h, itemId);
    await h.run({
      type: 'recordAvailability',
      itemId,
      candidateId: 'c2',
      rev: 1,
      personId: 'g',
      answer: 'yes',
    });
    expect(
      await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 }),
    ).toMatchObject({ status: 'ok' });
    let plan = await h.plan();
    expect(whenOf(plan).chosen).toEqual({ candidateId: 'c2', rev: 1, stale: false, changes: [] });
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    expect(arrangement?.start).toBe('2026-12-11T13:00+09:00');
    expect(requirementOf(plan).date).toBe('2026-12-11');
    // 同じ決めをもう一度：何も足さない。
    expect(
      await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 }),
    ).toMatchObject({ status: 'noop' });
    await h.run({
      type: 'recordAvailability',
      itemId,
      candidateId: 'c2',
      rev: 1,
      personId: 'g',
      answer: 'no',
    });
    plan = await h.plan();
    expect(whenOf(plan).chosen).toMatchObject({ stale: true, changes: ['answers'] });
    // 決め直すと、今の根拠を控える。
    expect(
      await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 }),
    ).toMatchObject({ status: 'ok' });
    expect(whenOf(await h.plan()).chosen).toMatchObject({ stale: false });
    // 決めた候補の時刻を直すと、決めた事は今の代に当たらない（窓が無くなる）。
    expect(
      await h.save({
        type: 'setNeedCandidates',
        itemId,
        candidates: [
          { id: 'c1', date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
          { id: 'c2', date: '2026-12-11', startTime: '14:00', endTime: '16:00' },
        ],
      }),
    ).toMatchObject({ status: 'ok' });
    plan = await h.plan();
    expect(whenOf(plan).chosen).toBeUndefined();
    expect(plan.arrangements.filter((a) => a.kind === 'need' && a.live)).toEqual([]);
  });

  it('使った後（引き受けた）は、決めた日を替えない：決め直し・時刻の直し・中身の直し', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    await people(h, itemId);
    await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c1', rev: 1 });
    let plan = await h.plan();
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const optionKey = arrangement?.options.find((o) => o.templateId === 'ask-g')?.key;
    if (!arrangement || !optionKey) throw new Error('案が無い');
    expect(
      await h.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    plan = await h.plan();
    const task = plan.tasks.find((t) => t.basis.optionKey === optionKey && t.live && t.external);
    const shown = task ? proposalSnapshot(task) : undefined;
    if (!task || !shown) throw new Error('頼む作業が無い');
    expect(await h.run({ type: 'accept', taskKey: task.key, shown })).toMatchObject({
      status: 'ok',
    });
    expect(whenOf(await h.plan()).inUse).toBe(true);
    const other = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      { type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 },
    );
    expect(other).toMatchObject({ status: 'conflict', reason: 'decisionInUse' });
    const moved = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      {
        type: 'setNeedCandidates',
        itemId,
        candidates: [
          { id: 'c1', date: '2026-12-09', startTime: '14:00', endTime: '16:00' },
          { id: 'c2', date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
        ],
      },
    );
    expect(moved).toMatchObject({ status: 'conflict', reason: 'decisionInUse' });
    const what = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      { type: 'correctItem', itemId, interpretation: { what: '子を見てもらう（午後）' } },
    );
    expect(what).toMatchObject({ status: 'conflict', reason: 'decisionInUse' });
    // 形・日・時刻は、使う前でも直せない（時刻は候補が持つ）。
    const date = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      { type: 'correctItem', itemId, interpretation: { date: '2026-12-10' } },
    );
    expect(date).toMatchObject({ status: 'invalid', reason: 'candidateNeedTimeLocked' });
    // 決めていない候補を足す・消すのは、決めた候補をそのままにすれば受ける。
    expect(
      await h.save({
        type: 'setNeedCandidates',
        itemId,
        candidates: [
          { id: 'c1', date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
          { date: '2026-12-13', startTime: '13:00', endTime: '15:00' },
        ],
      }),
    ).toMatchObject({ status: 'ok' });
  });

  it('選ぶと同時に引き受けた（chooseOption の shown）時も、使ったとして日を替えない', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    await people(h, itemId);
    await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c1', rev: 1 });
    const plan = await h.plan();
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = arrangement?.options.find((o) => o.templateId === 'ask-g');
    const task = plan.tasks.find((t) => t.basis.optionKey === option?.key && t.external);
    const snapshot = task ? proposalSnapshot(task) : undefined;
    if (!arrangement || !option || !task || !snapshot) throw new Error('案が無い');
    expect(
      await h.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'a',
        shown: [{ taskKey: task.key, snapshot }],
      }),
    ).toMatchObject({ status: 'ok' });
    const accepted = (await h.events()).filter(
      (e) => e.type === 'commitmentChanged' && e.action === 'accept',
    );
    expect(accepted).toHaveLength(1);
    expect(whenOf(await h.plan()).inUse).toBe(true);
    const other = previewChange(
      await h.events(),
      { memberId: 'a', now: START },
      { type: 'chooseCandidate', itemId, candidateId: 'c2', rev: 1 },
    );
    expect(other).toMatchObject({ status: 'conflict', reason: 'decisionInUse' });
  });

  it('候補の無い前からの「すること」でも、使った後（引き受け・送った・済み）は、候補を足して日を替えさせない', async () => {
    const used = async (how: 'accepted' | 'sent' | 'done') => {
      const h = setup();
      expect(
        await h.save({
          type: 'stateNeed',
          text: '12/10 の 13 時から 15 時、子を見てもらう。',
          interpretation: {
            what: '子を見てもらう',
            shape: 'window',
            date: '2026-12-10',
            startTime: '13:00',
            endTime: '15:00',
          },
        }),
      ).toMatchObject({ status: 'ok' });
      const itemId = requirementOf(await h.plan()).basis.itemIds[0] as string;
      await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-g'] });
      let plan = await h.plan();
      const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
      const option = arrangement?.options.find((o) => o.templateId === 'ask-g');
      const task = plan.tasks.find((t) => t.basis.optionKey === option?.key && t.external);
      const snapshot = task ? proposalSnapshot(task) : undefined;
      if (!arrangement || !option || !task || !snapshot) throw new Error('案が無い');
      expect(
        await h.run({
          type: 'chooseOption',
          arrangementKey: arrangement.key,
          optionKey: option.key,
          role: 'primary',
          assigneeId: 'a',
          ...(how === 'sent' ? {} : { shown: [{ taskKey: task.key, snapshot }] }),
        }),
      ).toMatchObject({ status: 'ok' });
      if (how === 'sent') {
        plan = await h.plan();
        expect(
          await h.run({
            type: 'recordSent',
            taskKey: task.key,
            requestId: 'r-1',
            window: { start: arrangement.start, end: arrangement.end },
          }),
        ).toMatchObject({ status: 'ok' });
      }
      if (how === 'done') {
        const current = (await h.plan()).tasks.find((t) => t.key === task.key);
        if (!current) throw new Error('作業が無い');
        expect(
          await h.run({
            type: 'commitment',
            taskKey: task.key,
            action: 'done',
            seen: taskContent(current),
          }),
        ).toMatchObject({ status: 'ok' });
      }
      return { h, itemId };
    };
    for (const how of ['accepted', 'sent', 'done'] as const) {
      const { h, itemId } = await used(how);
      const added = previewChange(
        await h.events(),
        { memberId: 'a', now: START },
        {
          type: 'setNeedCandidates',
          itemId,
          candidates: [
            { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
            { date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
          ],
        },
      );
      expect(added, how).toMatchObject({ status: 'conflict', reason: 'decisionInUse' });
    }
  });

  it('使う前の中身の直しは、全部の候補の代を進める（前の答えと決めを古い中身に当てない）', async () => {
    const h = setup();
    const itemId = await stateCandidates(h);
    await people(h, itemId);
    await h.run({
      type: 'recordAvailability',
      itemId,
      candidateId: 'c1',
      rev: 1,
      personId: 'g',
      answer: 'yes',
    });
    await h.save({ type: 'chooseCandidate', itemId, candidateId: 'c1', rev: 1 });
    expect(
      await h.save({
        type: 'correctItem',
        itemId,
        interpretation: { what: '子を見てもらう（宿題も）' },
      }),
    ).toMatchObject({ status: 'ok' });
    const when = whenOf(await h.plan());
    expect(when.candidates.map((c) => [c.id, c.rev])).toEqual([
      ['c1', 2],
      ['c2', 2],
    ]);
    expect(when.answers).toEqual([]);
    expect(when.chosen).toBeUndefined();
  });
});

describe('受け持ちが要らない「すること」', () => {
  it('holdNeeded が false なら、進める案の窓の受け持ちを確かめない（書かれていなければ要る）', async () => {
    const reasons = async (holdNeeded?: boolean) => {
      const h = setup();
      expect(
        await h.save({
          type: 'stateNeed',
          text: '12/12 の 9 時から 12 時、練習に行く。',
          interpretation: {
            what: '練習に行く',
            shape: 'window',
            date: '2026-12-12',
            startTime: '09:00',
            endTime: '12:00',
            ...(holdNeeded === undefined ? {} : { holdNeeded }),
          },
        }),
      ).toMatchObject({ status: 'ok' });
      const itemId = requirementOf(await h.plan()).basis.itemIds[0] as string;
      await h.save({ type: 'setNeedWays', itemId, wayIds: ['ask-g'] });
      const plan = await h.plan();
      const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
      const optionKey = arrangement?.options[0]?.key;
      if (!arrangement || !optionKey) throw new Error('案が無い');
      expect(
        await h.run({
          type: 'chooseOption',
          arrangementKey: arrangement.key,
          optionKey,
          role: 'primary',
          assigneeId: 'a',
        }),
      ).toMatchObject({ status: 'ok' });
      const after = await h.plan();
      return (
        after.arrangements.find((a) => a.kind === 'need' && a.live)?.reasons.map((r) => r.code) ??
        []
      );
    };
    expect(await reasons()).toContain('notCovered');
    expect(await reasons(true)).toContain('notCovered');
    expect(await reasons(false)).not.toContain('notCovered');
  });
});
