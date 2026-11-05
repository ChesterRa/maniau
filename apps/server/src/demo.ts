// デモ（架空の家族とお知らせ）の事象の列と、デモの時計の段。docs/plan/02-product.md §2・§8。
// 読み取りは、録った Claude の応答（data/demo/recorded/）があればそれを、無ければ手で書いた
// 正しい読み取りの形（data/demo/expected/）を使い、どちらを使ったかを返す（画面に示す）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  type DateTime,
  DomainEvent,
  type Extraction,
  Household,
  parseStoredExtraction,
  proposalSnapshot,
  type ReadingIssue,
  type Source,
  SurveyRecord,
  splitSentences,
  toExtraction,
  validateHousehold,
} from '@maniau/core';
import { computePlan, foldEvents, keys, needWaysBasis, requestSnapshot } from '@maniau/core/engine';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

export interface DemoReading {
  sourceId: string;
  origin: 'recorded' | 'expected';
  model: string;
  issues: ReadingIssue[];
}

interface DemoData {
  household: Household;
  sources: Source[];
  extractions: Extraction[];
  readings: DemoReading[];
  outputs: { model: string; promptVersion: string; inputHash: string }[];
  /** 前に Claude で調べて記録した、デモの家の周りの資源（あれば。02-foundation §3.5）。 */
  survey?: SurveyRecord;
}

const NOTICES = [
  {
    id: 'n1',
    file: '2026-11-25-happyokai.txt',
    receivedAt: '2026-11-25T19:30+09:00',
    title: '学習発表会のお知らせ',
  },
  {
    id: 'n2',
    file: '2026-12-04-enki.txt',
    receivedAt: '2026-12-04T17:52+09:00',
    title: '学習発表会の延期について',
  },
] as const;

let cached: DemoData | undefined;

export function loadDemoData(): DemoData {
  if (cached) return cached;
  const household = Household.parse(JSON.parse(read('data/demo/household.json')));
  const householdIssues = validateHousehold(household);
  if (householdIssues.length > 0) {
    throw new Error(`デモの家族の情報に誤りがある：${JSON.stringify(householdIssues)}`);
  }
  const sources: Source[] = [];
  const extractions: Extraction[] = [];
  const readings: DemoReading[] = [];
  const outputs: DemoData['outputs'] = [];
  for (const notice of NOTICES) {
    const source: Source = {
      id: notice.id,
      version: 1,
      receivedAt: notice.receivedAt,
      sender: 'school',
      senderPlaceId: 'school',
      language: 'ja',
      medium: 'text',
      title: notice.title,
      sentences: splitSentences(read(`data/demo/notices/${notice.file}`), notice.id),
    };
    const recordedPath = `data/demo/recorded/${notice.id}.extract.json`;
    const recorded = existsSync(new URL(recordedPath, ROOT));
    const raw = JSON.parse(
      read(recorded ? recordedPath : `data/demo/expected/${notice.id}.output.json`),
    );
    const output = parseStoredExtraction(raw.output);
    const { extraction, issues } = toExtraction(output, source, {
      priorItems: extractions.flatMap((e) => e.items),
      priorUnknowns: extractions.flatMap((e) => e.unknowns),
    });
    sources.push(source);
    extractions.push(extraction);
    const model = recorded ? String(raw.model) : 'hand-written';
    readings.push({
      sourceId: source.id,
      origin: recorded ? 'recorded' : 'expected',
      model,
      issues,
    });
    outputs.push({
      model,
      promptVersion: recorded ? String(raw.promptVersion) : 'expected',
      inputHash: recorded ? String(raw.inputHash) : `expected-${notice.id}`,
    });
  }
  const surveyPath = 'data/demo/recorded/survey.json';
  const survey = existsSync(new URL(surveyPath, ROOT))
    ? SurveyRecord.parse(JSON.parse(read(surveyPath)))
    : undefined;
  cached = { household, sources, extractions, readings, outputs, ...(survey ? { survey } : {}) };
  return cached;
}

// viewer：その段で画面を見ている大人（デモで最初に開く人。画面で替えられる）。
export const DEMO_STAGES = [
  { id: 'arrived', now: '2026-11-25T19:31+09:00', viewer: 'b' },
  { id: 'asked', now: '2026-11-26T12:10+09:00', viewer: 'a' },
  { id: 'chase', now: '2026-11-29T21:00+09:00', viewer: 'b' },
  { id: 'backup', now: '2026-11-30T18:10+09:00', viewer: 'b' },
  { id: 'postponed', now: '2026-12-04T18:10+09:00', viewer: 'b' },
  // いつにするかの候補（02-foundation §3.4）：前の五つの段の事象は変えず、その後ろに足す。
  { id: 'when', now: '2026-12-05T21:00+09:00', viewer: 'b' },
  { id: 'club', now: '2026-12-06T10:00+09:00', viewer: 'a' },
  // 手が離せない時間（02-foundation §3.6）：前の七つの段の事象は変えず、その後ろに足す。
  { id: 'busy', now: '2026-12-06T10:30+09:00', viewer: 'a' },
] as const satisfies readonly { id: string; now: DateTime; viewer: string }[];
export type DemoStageId = (typeof DEMO_STAGES)[number]['id'];

export function isDemoStage(value: unknown): value is DemoStageId {
  return DEMO_STAGES.some((s) => s.id === value);
}

/**
 * 空から始める試用：前からのお知らせ・出来事の無い家庭。時計はデモの初めの日（段 arrived と同じ 11/25 19:31）で、
 * 例のお知らせの日付と合う。見本の家族を使うか、名前だけの家族を作る。お知らせは家族が入れる。
 */
export const TRIAL_NOW: DateTime = '2026-11-25T19:31+09:00';
const TRIAL_SET_AT: DateTime = '2026-11-24T21:00+09:00';
export type TrialStart = 'sample' | 'own';

/** 名前だけの家族を作る時の入力（大人は一人か二人、子は一人）。 */
export interface TrialNames {
  adults: string[];
  child: string;
}

/**
 * 名前だけの家族。場所・ふだんの週・手配の手は持たない（分からない事を、勝手に埋めない。要る時に聞く）。
 * 見本の家族の成員・場所は混ぜない。
 */
export function ownHousehold(names: TrialNames): Household {
  return Household.parse({
    id: 'trial-own',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      ...names.adults.map((name, i) => ({ id: `a${i + 1}`, kind: 'adult', name })),
      { id: 'c1', kind: 'child', name: names.child },
    ],
    places: [],
    routines: [],
    careOptions: [],
    // 日の記録を足す時は、家族が一日の全部を確かめて記録した物だけ（分からない時間を、家にいると見なさない）。
    confirmDays: true,
  });
}

/** 試用の始まりの事象：家族の情報だけ（お知らせ・答え・引き受けは無い）。 */
export function trialEvents(household: Household): DomainEvent[] {
  const actorId = household.members.find((m) => m.kind === 'adult' && m.active)?.id ?? 'system';
  return [
    DomainEvent.parse({
      id: 'trial-1',
      householdId: household.id,
      seq: 1,
      version: 1,
      occurredAt: TRIAL_SET_AT,
      recordedAt: TRIAL_SET_AT,
      actorId,
      type: 'householdSet',
      household,
    }),
  ];
}

/**
 * 例のお知らせ（架空の学習発表会）の出典と、前に録った読み取り。例だけに使い、家族が書いた文の読み取りには
 * 使わない。録った物か手で書いた形かは reading.origin で画面に出す。
 */
export function exampleNotice() {
  const data = loadDemoData();
  const source = data.sources[0];
  const output = data.outputs[0];
  const extraction = data.extractions[0];
  const reading = data.readings[0];
  if (!source || !output || !extraction || !reading) throw new Error('例のお知らせが無い');
  return { source, output, extraction, reading };
}

/** デモの段までの事象の列。段は前の段の事象をすべて含む。 */
export function demoEvents(stage: DemoStageId): DomainEvent[] {
  const data = loadDemoData();
  const upTo = DEMO_STAGES.findIndex((s) => s.id === stage);
  const events: DomainEvent[] = [];
  const add = (at: string, actorId: string, body: Record<string, unknown>) => {
    const seq = events.length + 1;
    events.push(
      DomainEvent.parse({
        id: `demo-${seq}`,
        householdId: data.household.id,
        seq,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  };
  // 依頼を送ったと記録する。送った時の控え（相手・種類・根拠）は、その時の計画の作業から取る
  // （02-foundation §5.6。依頼は後の作業の一覧から逆算しない）。
  const sent = (at: string, actorId: string, taskKey: string, requestId: string) => {
    add(at, actorId, {
      type: 'externalRequestSent',
      taskKey,
      requestId,
      snapshot: requestSnapshot(events, at, taskKey),
    });
  };
  // 本人が引き受ける。見せた提案の控えは、その時の計画の作業から取る（02-foundation §5.5）。
  const accept = (at: string, assigneeId: string, taskKey: string) => {
    const task = computePlan(events, at).tasks.find((t) => t.key === taskKey);
    if (!task) throw new Error(`デモの作業が無い：${taskKey}`);
    const shown = proposalSnapshot(task);
    if (!shown) throw new Error(`デモの作業が置けていない：${taskKey}`);
    add(at, assigneeId, {
      type: 'commitmentChanged',
      taskKey,
      assigneeId,
      action: 'accept',
      shown,
    });
  };
  const notice = (index: number, at: string) => {
    const source = data.sources[index];
    const output = data.outputs[index];
    const extraction = data.extractions[index];
    if (!source || !output || !extraction) throw new Error('デモのお知らせが無い');
    add(at, 'b', { type: 'noticeReceived', source });
    add(at, 'system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: source.id,
      ...output,
      output: extraction,
    });
  };

  // 子の居場所の手配と、白い長袖シャツの安定したキー（読み取りの事項の ID から）。
  const dayOff = data.extractions[0]?.items.find((i) => i.interpretation.dayType === 'noSchool');
  const shirt = data.extractions[0]?.items.find((i) => i.kind === 'belongings');
  const care = keys.childCareArrangement(dayOff?.id ?? 'missing', 'c');
  const buy = keys.task(
    keys.option(keys.purchaseArrangement(shirt?.id ?? 'missing'), 'buy'),
    'buy',
  );
  const grandma = keys.option(care, 'opt-grandma');
  const gakudo = keys.option(care, 'opt-gakudo');

  add('2026-11-24T21:00+09:00', 'a', { type: 'householdSet', household: data.household });
  notice(0, '2026-11-25T19:30+09:00');
  if (upTo >= 1) {
    add('2026-11-25T19:35+09:00', 'b', {
      type: 'answered',
      unknownId: keys.atHomeUnknown(shirt?.id ?? 'missing'),
      value: 'no',
    });
    add('2026-11-25T19:36+09:00', 'b', {
      type: 'optionChosen',
      arrangementKey: care,
      optionKey: grandma,
      role: 'primary',
    });
    add('2026-11-25T19:36+09:00', 'b', {
      type: 'assignmentProposed',
      taskKey: keys.task(grandma, 'ask'),
      assigneeId: 'b',
    });
    accept('2026-11-25T19:37+09:00', 'b', keys.task(grandma, 'ask'));
    sent('2026-11-25T19:40+09:00', 'b', keys.task(grandma, 'ask'), 'r-grandma');
  }
  if (upTo >= 2) {
    // 健太が、帰りの買い物（11/26 18:55–19:10、家に着くのは 19:25）を見て引き受け、買う。
    accept('2026-11-26T12:12+09:00', 'a', buy);
    add('2026-11-26T19:12+09:00', 'a', {
      type: 'commitmentChanged',
      taskKey: buy,
      assigneeId: 'a',
      action: 'done',
    });
  }
  if (upTo >= 3) {
    // 彩が、おばあちゃんの返事を待つ間に、学童を予備に押さえ、健太に頼む。健太が引き受け、書いて出す。
    add('2026-11-29T21:00+09:00', 'b', {
      type: 'optionChosen',
      arrangementKey: care,
      optionKey: gakudo,
      role: 'backup',
    });
    add('2026-11-29T21:01+09:00', 'b', {
      type: 'assignmentProposed',
      taskKey: keys.task(gakudo, 'write'),
      assigneeId: 'a',
    });
    add('2026-11-29T21:01+09:00', 'b', {
      type: 'assignmentProposed',
      taskKey: keys.task(gakudo, 'submit'),
      assigneeId: 'a',
    });
    accept('2026-11-29T21:02+09:00', 'a', keys.task(gakudo, 'write'));
    accept('2026-11-29T21:02+09:00', 'a', keys.task(gakudo, 'submit'));
    add('2026-11-30T17:30+09:00', 'a', {
      type: 'commitmentChanged',
      taskKey: keys.task(gakudo, 'write'),
      assigneeId: 'a',
      action: 'done',
    });
    sent('2026-11-30T18:00+09:00', 'a', keys.task(gakudo, 'submit'), 'r-gakudo');
    add('2026-11-30T18:01+09:00', 'a', {
      type: 'externalReplyRecorded',
      requestId: 'r-gakudo',
      reply: 'yes',
    });
  }
  if (upTo >= 4) notice(1, '2026-12-04T17:52+09:00');
  if (upTo >= 5) whenStage(add, () => events);
  if (upTo >= 6) clubStage(add, () => events, data.household);
  if (upTo >= 7) busyStage(add, () => events);
  return events;
}

type Add = (at: string, actorId: string, body: Record<string, unknown>) => void;

/**
 * 家族の言明の「すること」を、いつにするかの候補つきで足す（サーバーの stateNeed と同じ形の事象）。デモの出典の ID は
 * 読める名前にする（言明の出典は、ID の作り方に依らない）。
 */
function statedWithCandidates(
  add: Add,
  at: string,
  actorId: string,
  sourceId: string,
  text: string,
  interpretation: Record<string, unknown>,
  candidates: { date: string; startTime: string; endTime: string }[],
): string {
  const itemId = `${sourceId}:i1`;
  add(at, actorId, {
    type: 'noticeReceived',
    source: {
      id: sourceId,
      version: 1,
      receivedAt: at,
      sender: 'family',
      language: 'ja',
      medium: 'text',
      sentences: [{ id: `${sourceId}#1`, text }],
    },
  });
  add(at, actorId, {
    type: 'itemsStated',
    sourceId,
    items: [
      {
        id: itemId,
        sourceId,
        sentenceIds: [`${sourceId}#1`],
        kind: 'need',
        written: text,
        interpretation,
        evidence: 'stated',
        effects: [],
      },
    ],
  });
  add(at, actorId, {
    type: 'needCandidatesSet',
    itemId,
    candidates: candidates.map((c, i) => ({ id: `c${i + 1}`, rev: 1, ...c })),
  });
  return itemId;
}

/** やり方を選ぶ（選んだ時の中身とやり方の控えは、その時の事象から作る。サーバーの setNeedWays と同じ）。 */
function chooseWays(
  add: Add,
  events: () => DomainEvent[],
  at: string,
  actorId: string,
  itemId: string,
  wayIds: string[],
) {
  const about = needWaysBasis(foldEvents(events()), itemId, wayIds);
  if (about === undefined) throw new Error(`デモの「すること」が無い：${itemId}`);
  add(at, actorId, { type: 'needWaysSet', itemId, wayIds, about });
}

/**
 * デモに焼いたリンク（その鍵はだれも持たない。デモで答えるには、画面で出し直す）。ハッシュは、鍵の形（43 字）に
 * ならない文から作るので、どの鍵とも合わない。
 */
const bakedLink = (name: string) =>
  createHash('sha256').update(`demo-baked-link:${name}`).digest('hex');

/**
 * 段「when」（12/5 の夜）：二人とも出る用事のある午後に、陽菜を見てもらう日を、12/12（土）か 12/13（日）から決める。
 * おばあちゃん（頼める人）と、近所のサトウさん（名前だけの相手。リンクで答える）に聞いた。少なくとも一人。
 */
function whenStage(add: Add, events: () => DomainEvent[]) {
  const itemId = statedWithCandidates(
    add,
    '2026-12-05T20:30+09:00',
    'b',
    'f-demo-sitter',
    '12/12 か 12/13 の午後1時から3時は、二人とも出る用事がある。どちらかの日に、陽菜を見てもらえる人を探す。おばあちゃんと、近所のサトウさんに聞いてみる。',
    { what: '陽菜を見てもらう', shape: 'window', forMemberId: 'c' },
    [
      { date: '2026-12-12', startTime: '13:00', endTime: '15:00' },
      { date: '2026-12-13', startTime: '13:00', endTime: '15:00' },
    ],
  );
  chooseWays(add, events, '2026-12-05T20:31+09:00', 'b', itemId, ['way-grandma']);
  add('2026-12-05T20:32+09:00', 'b', {
    type: 'needPeopleSet',
    itemId,
    people: [
      { id: 'g', kind: 'member' },
      { id: 'g-sato', kind: 'guest', name: '近所のサトウさん' },
    ],
    required: [],
    minCount: 1,
  });
  add('2026-12-05T20:33+09:00', 'b', {
    type: 'answerLinkIssued',
    itemId,
    personId: 'g-sato',
    linkId: 'l-demo-sato',
    tokenHash: bakedLink('sato'),
  });
  // おばあちゃんには電話で聞き、彩が記録した（家族の記録）。サトウさんはリンクから答えた。
  const answer = (at: string, actorId: string, body: Record<string, unknown>) =>
    add(at, actorId, { type: 'availabilityRecorded', itemId, rev: 1, ...body });
  answer('2026-12-05T20:40+09:00', 'b', {
    candidateId: 'c1',
    personId: 'g',
    answer: 'no',
    source: 'family',
  });
  answer('2026-12-05T20:40+09:00', 'b', {
    candidateId: 'c2',
    personId: 'g',
    answer: 'yes',
    source: 'family',
  });
  answer('2026-12-05T20:52+09:00', 'link', {
    candidateId: 'c1',
    personId: 'g-sato',
    answer: 'maybe',
    note: '2時までなら',
    source: 'link',
    linkId: 'l-demo-sato',
  });
}

/** 体育室の予約（架空。地区センターの営業時間の中に電話する）。 */
const BOOK_HALL = {
  id: 'way-book-hall',
  name: '地区センターの体育室を予約する',
  steps: [
    {
      id: 'book',
      name: '地区センターに電話して、体育室を予約する',
      durationMin: 10,
      segments: ['home', 'commute', 'work'],
      external: { to: 'ward-center', kind: 'reply' },
    },
  ],
  deadline: { type: 'daysBefore', days: 3, at: '17:00' },
  cost: { yen: 1500 },
  cancellable: true,
};

/**
 * 段「club」（12/6 の朝）：陽菜のクラブの練習日を、12/12（土）か 12/19（土）の 9〜12 時から決める。コーチは要る、
 * 6 人以上。窓の間ずっと家族が受け持つ用事ではない（holdNeeded: false）。会場は体育室の予約（家族が足したやり方）。
 */
function clubStage(add: Add, events: () => DomainEvent[], household: Household) {
  add('2026-12-06T09:00+09:00', 'a', {
    type: 'householdSet',
    household: { ...household, ways: [...household.ways, BOOK_HALL] },
  });
  const itemId = statedWithCandidates(
    add,
    '2026-12-06T09:05+09:00',
    'a',
    'f-demo-club',
    'クラブの練習日を、12/12 か 12/19 の 9 時から 12 時で決める。コーチは必ず。6 人以上そろえば、地区センターの体育室でやる。',
    {
      what: 'クラブの練習',
      shape: 'window',
      forMemberId: 'c',
      place: 'みらい橋地区センター（架空）の体育室',
      holdNeeded: false,
    },
    [
      { date: '2026-12-12', startTime: '09:00', endTime: '12:00' },
      { date: '2026-12-19', startTime: '09:00', endTime: '12:00' },
    ],
  );
  chooseWays(add, events, '2026-12-06T09:06+09:00', 'a', itemId, ['way-book-hall']);
  const guests = [
    ['g-coach', 'コーチ'],
    ['g-aoki', 'アオキさん'],
    ['g-ishida', 'イシダさん'],
    ['g-ueno', 'ウエノさん'],
    ['g-endo', 'エンドウさん'],
    ['g-okada', 'オカダさん'],
    ['g-kato', 'カトウさん'],
    ['g-kimura', 'キムラさん'],
  ] as const;
  add('2026-12-06T09:07+09:00', 'a', {
    type: 'needPeopleSet',
    itemId,
    people: [
      { id: 'a', kind: 'member' },
      ...guests.map(([id, name]) => ({ id, kind: 'guest', name })),
    ],
    required: ['g-coach'],
    minCount: 6,
  });
  // コーチと三人にはリンクを送り、ほかの人の返事はグループの連絡を見て健太が記録した。
  for (const id of ['g-coach', 'g-aoki', 'g-ishida', 'g-ueno']) {
    add('2026-12-06T09:08+09:00', 'a', {
      type: 'answerLinkIssued',
      itemId,
      personId: id,
      linkId: `l-demo-${id}`,
      tokenHash: bakedLink(id),
    });
  }
  const link = (at: string, personId: string, candidateId: string, answer: string, note?: string) =>
    add(at, 'link', {
      type: 'availabilityRecorded',
      itemId,
      candidateId,
      rev: 1,
      personId,
      answer,
      ...(note ? { note } : {}),
      source: 'link',
      linkId: `l-demo-${personId}`,
    });
  const family = (personId: string, candidateId: string, answer: string, note?: string) =>
    add('2026-12-06T09:50+09:00', 'a', {
      type: 'availabilityRecorded',
      itemId,
      candidateId,
      rev: 1,
      personId,
      answer,
      ...(note ? { note } : {}),
      source: personId === 'a' ? 'self' : 'family',
    });
  // 12/12：コーチは来られる。はいは 5 人で、あと 1 人。オカダさん・キムラさんがまだ、エンドウさんは「たぶん」。
  // 12/19：はいは 6 人いるが、コーチが「たぶん」（午後に別の試合）。答えは、届いた順に記録する。
  link('2026-12-06T09:20+09:00', 'g-coach', 'c1', 'yes');
  link('2026-12-06T09:20+09:00', 'g-coach', 'c2', 'maybe', '午後に別の試合がある');
  link('2026-12-06T09:25+09:00', 'g-aoki', 'c1', 'yes');
  link('2026-12-06T09:25+09:00', 'g-aoki', 'c2', 'yes');
  link('2026-12-06T09:31+09:00', 'g-ishida', 'c1', 'yes');
  link('2026-12-06T09:31+09:00', 'g-ishida', 'c2', 'yes');
  link('2026-12-06T09:40+09:00', 'g-ueno', 'c1', 'no');
  link('2026-12-06T09:40+09:00', 'g-ueno', 'c2', 'yes');
  family('a', 'c1', 'yes');
  family('a', 'c2', 'yes');
  family('g-kato', 'c1', 'yes');
  family('g-kato', 'c2', 'yes');
  family('g-endo', 'c1', 'maybe', '午前だけなら');
  family('g-okada', 'c2', 'yes');
}

/**
 * 段「busy」（12/6 の朝、club の後）：健太が、12/19 の 9:30〜10:30 に手が離せない時間（家でのオンライン会議）を記録
 * した。練習日の候補 12/19（9〜12 時）と重なるので、計画にその事実が出る（この段では、答え・数え・勧めは変わらない）。記録は家の
 * 情報の直し（画面の「見る → 記録する」と同じ householdSet）。
 */
function busyStage(add: Add, events: () => DomainEvent[]) {
  const household = foldEvents(events()).household;
  if (!household) throw new Error('デモの家の情報が無い');
  add('2026-12-06T10:20+09:00', 'a', {
    type: 'householdSet',
    household: {
      ...household,
      unavailable: [
        { id: 'u-demo-meeting', memberId: 'a', date: '2026-12-19', start: '09:30', end: '10:30' },
      ],
    },
  });
}

export function demoPlan(stage: DemoStageId) {
  const data = loadDemoData();
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now;
  if (!now) throw new Error(`デモの段が無い：${stage}`);
  const events = demoEvents(stage);
  const plan = computePlan(events, now);
  return {
    stage,
    stages: DEMO_STAGES.map((s) => ({ id: s.id, now: s.now })),
    // その段の家の情報（後の段で家族が足したやり方も含む）。
    household: foldEvents(events).household ?? data.household,
    sources: data.sources,
    readings: data.readings,
    plan,
  };
}
