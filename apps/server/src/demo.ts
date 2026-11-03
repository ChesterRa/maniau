// デモ（架空の家族とお知らせ）の事象の列と、デモの時計の段。docs/plan/02-product.md §2・§8。
// 読み取りは、録った Claude の応答（data/demo/recorded/）があればそれを、無ければ手で書いた
// 正しい読み取りの形（data/demo/expected/）を使い、どちらを使ったかを返す（画面に示す）。
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
  splitSentences,
  toExtraction,
  validateHousehold,
} from '@maniau/core';
import { computePlan, keys, requestSnapshot } from '@maniau/core/engine';

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
  cached = { household, sources, extractions, readings, outputs };
  return cached;
}

// viewer：その段で画面を見ている大人（デモで最初に開く人。画面で替えられる）。
export const DEMO_STAGES = [
  { id: 'arrived', now: '2026-11-25T19:31+09:00', viewer: 'b' },
  { id: 'asked', now: '2026-11-26T12:10+09:00', viewer: 'a' },
  { id: 'chase', now: '2026-11-29T21:00+09:00', viewer: 'b' },
  { id: 'backup', now: '2026-11-30T18:10+09:00', viewer: 'b' },
  { id: 'postponed', now: '2026-12-04T18:10+09:00', viewer: 'b' },
] as const satisfies readonly { id: string; now: DateTime; viewer: string }[];
export type DemoStageId = (typeof DEMO_STAGES)[number]['id'];

export function isDemoStage(value: unknown): value is DemoStageId {
  return DEMO_STAGES.some((s) => s.id === value);
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
  return events;
}

export function demoPlan(stage: DemoStageId) {
  const data = loadDemoData();
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now;
  if (!now) throw new Error(`デモの段が無い：${stage}`);
  const plan = computePlan(demoEvents(stage), now);
  return {
    stage,
    stages: DEMO_STAGES.map((s) => ({ id: s.id, now: s.now })),
    household: data.household,
    sources: data.sources,
    readings: data.readings,
    plan,
  };
}
