// お知らせから読んだ「すること」（extract.v4 の need）は、家族が確かめるまで計画に入れず、二人に確かめる札を出す。
// 確かめると（直すと）、家族の言明と同じ need になり、同じ札と計算に載る。確かめ・直し・外しは、見せた時の番号を
// 付け、見せた後に出典が変わっていれば断る。送り手が家族でも、モデルが読んだ物は同じ。
// 読み取りは偽物（この試験のために手で書いた v4 の形で、モデルの出力ではない）。Claude の API は呼ばない。
// 形の足りない need（終わりの書かれていない窓）は、その文を家族に確かめてもらい、「合っている」では入れない。
// 家族が決める条件（希望する家庭は）の付いた need は、家族の問いになり、答えるまで条件しだいのまま。
import type { ExtractionOutput, Item } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import type { NoticeReader } from '../src/demo-sessions';
import { memoryStore } from '../src/store';

const NOTICE = [
  '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。',
  '会場は地域交流室です。',
  '12月13日（日）09:00から地域の説明会です。各家庭から大人1人の参加をお願いします。終了時刻は後ほどお知らせします。',
].join('\n');

const blank = {
  date: null,
  writtenWeekday: 'none' as const,
  startTime: null,
  endTime: null,
  what: null,
  dayType: null,
  deadline: null,
  audience: null,
  place: null,
  relativeDay: 'none' as const,
  conditionNodeId: null,
  inferred: false,
  familyAction: false,
  shape: 'none' as const,
  effects: [],
};

/** 手で書いた v4 の読み取り（文 ID は入れた出典の物）。 */
const reader: NoticeReader = async (request) => {
  // 入れた文は、行と句点で文に分かれる（6 文）。
  const [s1, s2, s3, s4, s5, s6] = request.source.sentences.map((s) => s.id);
  if (!s1 || !s2 || !s3 || !s4 || !s5 || !s6) {
    throw new Error(`文が足りない：${request.source.sentences.length}`);
  }
  const output: ExtractionOutput = {
    items: [
      {
        ...blank,
        id: 'i1',
        sentenceIds: [s1],
        kind: 'event',
        written: '12月12日（土）13:00〜14:00に地域交流会を行います。',
        date: '2026-12-12',
        writtenWeekday: 'sat',
        startTime: '13:00',
        endTime: '14:00',
        what: '地域交流会',
      },
      {
        ...blank,
        id: 'i2',
        sentenceIds: [s1, s2, s3],
        kind: 'need',
        written: '各家庭から大人1名、ご参加ください。会場は地域交流室です。',
        date: '2026-12-12',
        writtenWeekday: 'sat',
        startTime: '13:00',
        endTime: '14:00',
        what: '地域交流会への参加',
        place: '地域交流室',
        audience: '各家庭から大人1名',
        shape: 'window',
      },
      {
        ...blank,
        id: 'i3',
        sentenceIds: [s4],
        kind: 'event',
        written: '12月13日（日）09:00から地域の説明会です。',
        date: '2026-12-13',
        writtenWeekday: 'sun',
        startTime: '09:00',
        what: '地域の説明会',
      },
      {
        ...blank,
        id: 'i4',
        sentenceIds: [s4, s5],
        kind: 'need',
        written: '各家庭から大人1人の参加をお願いします。',
        date: '2026-12-13',
        writtenWeekday: 'sun',
        startTime: '09:00',
        what: '説明会への参加',
        audience: '各家庭から大人1人',
        shape: 'window',
      },
    ],
    unknowns: [],
    conditions: [],
    // 「後ほどお知らせします」は送り手の側がする事（家族の作業にしない）。
    irrelevantSentenceIds: [s6],
    ambiguities: [{ sentenceId: s5, note: '終わりの時刻が書かれていない' }],
  };
  return {
    output,
    model: 'test-model',
    promptVersion: 'test',
    inputHash: `test-${request.source.id}`,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};

/** 条件付きの締切の need（家族が決める値で要るかが決まる）。手で書いた v4 の形。 */
const CONDITIONAL =
  '設備の利用を希望する家庭は、12月4日（金）17:00までに地区センターの窓口で申し込んでください。';
const conditionalReader =
  (deadline: string): NoticeReader =>
  async (request) => {
    const [s1] = request.source.sentences.map((s) => s.id);
    if (!s1) throw new Error('文が無い');
    const output: ExtractionOutput = {
      items: [
        {
          ...blank,
          id: 'i1',
          sentenceIds: [s1],
          kind: 'deadline',
          written: CONDITIONAL,
          deadline,
          what: '設備の利用の申し込み',
          conditionNodeId: 'c1',
        },
        {
          ...blank,
          id: 'i2',
          sentenceIds: [s1],
          kind: 'need',
          written: CONDITIONAL,
          deadline,
          what: '設備の利用の申し込み',
          place: '地区センターの窓口',
          conditionNodeId: 'c1',
          shape: 'by',
        },
      ],
      unknowns: [{ id: 'u1', label: '設備を利用するか', values: ['yes', 'no'], kind: 'family' }],
      conditions: [{ id: 'c1', kind: 'eq', unknownId: 'u1', value: 'yes', childIds: [] }],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    return {
      output,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: `test-${request.source.id}`,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };

interface ViewBody {
  readings: { sourceId: string; check: string[]; checkAll: boolean }[];
  items: { item: { id: string }; condition?: unknown; answers?: unknown; unshown?: true }[];
  plan: {
    throughSeq: number;
    questions: { unknownId: string; family?: unknown }[];
    requirements: {
      key: string;
      kind: string;
      what: string;
      live: boolean;
      conditional?: boolean;
      unconfirmed?: true;
      basis: { itemIds: string[] };
    }[];
    arrangements: { key: string; kind: string; requirementKey: string; status: string }[];
    tasks: { basis: { arrangementKey?: string } }[];
  };
  today: { main: { kind: string; requirement?: { what: string } }[] };
}

type App = ReturnType<typeof createApp>;

async function sessionWith(app: App, text: string, sender = 'other') {
  const made = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'arrived' }),
  });
  const { sessionId } = (await made.json()) as { sessionId: string };
  const posted = await app.request(`/api/demo/sessions/${sessionId}/notices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'b', operationId: 'op-1', text, sender }),
  });
  expect(posted.status).toBe(200);
  const { sourceId } = (await posted.json()) as { sourceId: string };
  return { sessionId, sourceId };
}

const viewOf = async (app: App, sessionId: string, member: string) =>
  (await (
    await app.request(`/api/demo/sessions/${sessionId}/view?member=${member}`)
  ).json()) as ViewBody;

async function send(
  app: App,
  sessionId: string,
  member: string,
  operationId: string,
  command: unknown,
) {
  const response = await app.request(`/api/demo/sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: member, operationId, command }),
  });
  const body = (await response.json()) as { result: { status: string; reason?: string } };
  return body.result;
}

const needCards = (view: ViewBody, kind: 'need' | 'needCheck') =>
  view.today.main
    .filter((c) => c.kind === kind)
    .map((c) => c.requirement?.what)
    .sort();

describe('お知らせから読んだ「すること」', () => {
  it('確かめるまで計画に入れず、二人に確かめる札を出す。確かめると言明と同じ need の札になる。形の足りない物は「合っている」で入れず、直すと入る', async () => {
    const app = createApp({ reader });
    const { sessionId, sourceId } = await sessionWith(app, NOTICE);
    const exchange = `${sourceId}:i2`;
    const briefing = `${sourceId}:i4`;
    for (const member of ['a', 'b']) {
      const view = await viewOf(app, sessionId, member);
      const needs = view.plan.requirements.filter((r) => r.kind === 'need' && r.live);
      expect(needs.map((r) => [r.what, r.unconfirmed]).sort()).toEqual([
        ['地域交流会への参加', true],
        ['説明会への参加', true],
      ]);
      // 確かめるまでは、手配も作業も作らない（モデルが読んだ時間で、家族の予定を組まない）。
      expect(view.plan.arrangements.filter((a) => a.kind === 'need')).toEqual([]);
      expect(needCards(view, 'needCheck')).toEqual(['地域交流会への参加', '説明会への参加']);
      expect(needCards(view, 'need')).toEqual([]);
      // 足りない形と、書かれていない終わりは、その文を家族に確かめてもらう。
      const reading = view.readings.find((r) => r.sourceId === sourceId);
      expect(reading?.check).toEqual([`${sourceId}#4`, `${sourceId}#5`]);
    }
    const seen = { throughSeq: (await viewOf(app, sessionId, 'b')).plan.throughSeq };
    // 「合っている」：形のそろった物は、言明と同じ need の札（二人に）になり、やり方を選ぶまで作業を作らない。
    expect(
      await send(app, sessionId, 'b', 'ok-1', { type: 'confirmItem', itemId: exchange, seen }),
    ).toMatchObject({ status: 'ok' });
    for (const member of ['a', 'b']) {
      const view = await viewOf(app, sessionId, member);
      const arrangements = view.plan.arrangements.filter((a) => a.kind === 'need');
      expect(arrangements).toHaveLength(1);
      expect(arrangements[0]?.status).toBe('undetermined');
      expect(
        view.plan.tasks.filter((t) => t.basis.arrangementKey === arrangements[0]?.key),
      ).toEqual([]);
      expect(needCards(view, 'need')).toEqual(['地域交流会への参加']);
      expect(needCards(view, 'needCheck')).toEqual(['説明会への参加']);
    }
    // 終わりの無い窓は、「合っている」では入れない（書かれていない時刻を、確かめで埋めたことにしない）。
    const now = { throughSeq: (await viewOf(app, sessionId, 'b')).plan.throughSeq };
    expect(
      await send(app, sessionId, 'b', 'ok-2', { type: 'confirmItem', itemId: briefing, seen: now }),
    ).toMatchObject({ status: 'invalid', reason: 'needWindowMissing' });
    // 直す：家族が終わりを入れると、確かめた物として入る。
    expect(
      await send(app, sessionId, 'b', 'fix-1', {
        type: 'correctItem',
        itemId: briefing,
        interpretation: { endTime: '10:00' },
        seen: now,
      }),
    ).toMatchObject({ status: 'ok' });
    const fixed = await viewOf(app, sessionId, 'a');
    expect(needCards(fixed, 'need')).toEqual(['地域交流会への参加', '説明会への参加']);
    expect(needCards(fixed, 'needCheck')).toEqual([]);
  });

  it('確かめ・直し・外しは、見せた番号が無い・先の番号・見せた後に出典が変わった時に断る（送り手が家族でも確かめる）', async () => {
    const app = createApp({ reader });
    const { sessionId, sourceId } = await sessionWith(app, NOTICE, 'family');
    const exchange = `${sourceId}:i2`;
    const briefing = `${sourceId}:i4`;
    const shown = await viewOf(app, sessionId, 'a');
    // 家族が送ったお知らせでも、モデルが読んだ物は、確かめるまで計画に入れない。
    expect(
      shown.plan.requirements.filter((r) => r.kind === 'need').map((r) => r.unconfirmed),
    ).toEqual([true, true]);
    const seen = { throughSeq: shown.plan.throughSeq };
    expect(
      await send(app, sessionId, 'a', 'no-seen', { type: 'confirmItem', itemId: exchange }),
    ).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
    expect(
      await send(app, sessionId, 'a', 'ahead', {
        type: 'confirmItem',
        itemId: exchange,
        seen: { throughSeq: seen.throughSeq + 5 },
      }),
    ).toMatchObject({ status: 'invalid', reason: 'seenAhead' });
    // もう一人が同じお知らせの別の事項を直した後は、前に見せた画面からは決めさせない。
    expect(
      await send(app, sessionId, 'b', 'fix-b', {
        type: 'correctItem',
        itemId: briefing,
        interpretation: { endTime: '10:00' },
        seen,
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await send(app, sessionId, 'a', 'stale', {
        type: 'dismissItem',
        itemId: exchange,
        reason: 'misread',
        seen,
      }),
    ).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    // 見直した番号なら受ける。外した物は要件にもしない。
    const again = { throughSeq: (await viewOf(app, sessionId, 'a')).plan.throughSeq };
    expect(
      await send(app, sessionId, 'a', 'fresh', {
        type: 'dismissItem',
        itemId: exchange,
        reason: 'misread',
        seen: again,
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await viewOf(app, sessionId, 'a');
    expect(
      after.plan.requirements
        .filter((r) => r.kind === 'need' && r.live)
        .map((r) => [r.what, r.unconfirmed ?? false]),
    ).toEqual([['説明会への参加', false]]);
  });

  it('家族が決める条件の付いた締切の need は、家族の問いになり、答えるまで条件しだいのまま（推して決めない）', async () => {
    const app = createApp({ reader: conditionalReader('2026-12-04T17:00+09:00') });
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'arrived' }),
    });
    const { sessionId } = (await made.json()) as { sessionId: string };
    const posted = await app.request(`/api/demo/sessions/${sessionId}/notices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: 'b',
        operationId: 'op-1',
        text: CONDITIONAL,
        sender: 'other',
      }),
    });
    expect(posted.status).toBe(200);
    const { sourceId } = (await posted.json()) as { sourceId: string };
    const view = (await (
      await app.request(`/api/demo/sessions/${sessionId}/view?member=b`)
    ).json()) as ViewBody;
    const question = view.plan.questions.find((q) => q.unknownId === `${sourceId}:u1`);
    expect(question?.family).toBeDefined();
    const need = view.plan.requirements.find((r) => r.kind === 'need' && r.live);
    expect(need?.what).toBe('設備の利用の申し込み');
    expect(need?.conditional).toBe(true);
    expect(need?.unconfirmed).toBe(true);
    // 書かれた時刻の締切で、日だけの印は無い。確かめを求める文も無い。
    const reading = view.readings.find((r) => r.sourceId === sourceId);
    expect(reading?.check).toEqual([]);
  });

  it('文に書かれた締切の時刻を読み落として日だけで返した need は、その文を家族に確かめてもらう（日の終わりまでと黙って緩めない）', async () => {
    const app = createApp({ reader: conditionalReader('2026-12-04') });
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'arrived' }),
    });
    const { sessionId } = (await made.json()) as { sessionId: string };
    const posted = await app.request(`/api/demo/sessions/${sessionId}/notices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: 'b',
        operationId: 'op-1',
        text: CONDITIONAL,
        sender: 'other',
      }),
    });
    expect(posted.status).toBe(200);
    const { sourceId } = (await posted.json()) as { sourceId: string };
    const view = (await (
      await app.request(`/api/demo/sessions/${sessionId}/view?member=b`)
    ).json()) as ViewBody;
    const reading = view.readings.find((r) => r.sourceId === sourceId);
    expect(reading?.check).toEqual([`${sourceId}#1`]);
    // 日だけの締切として黙って計画に入れない：事項は残すが、家族が確かめるまで手配（締切まで）を作らない。
    expect(
      view.plan.requirements.some((r) => r.kind === 'need' && r.what === '設備の利用の申し込み'),
    ).toBe(true);
    expect(view.plan.arrangements.filter((a) => a.kind === 'need')).toEqual([]);
  });

  it('「あしたまでに」の締切を別の日に読んだ need は、計画に入れず、その文を確かめてもらう（日付はコードが決める）', async () => {
    const TEXT = 'あしたまでに地区センターの窓口で申し込んでください。';
    const relativeReader: NoticeReader = async (request) => {
      const [s1] = request.source.sentences.map((s) => s.id);
      if (!s1) throw new Error('文が無い');
      return {
        output: {
          items: [
            {
              ...blank,
              id: 'i1',
              sentenceIds: [s1],
              kind: 'need',
              written: TEXT,
              relativeDay: 'tomorrow',
              // 届いた日（11/25）の次の日は 11/26。モデルが別の日を返した。
              deadline: '2026-11-28',
              what: '窓口での申し込み',
              place: '地区センターの窓口',
              shape: 'by',
            },
          ],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
        model: 'test-model',
        promptVersion: 'test',
        inputHash: `test-${request.source.id}`,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    };
    const app = createApp({ reader: relativeReader });
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'arrived' }),
    });
    const { sessionId } = (await made.json()) as { sessionId: string };
    const posted = await app.request(`/api/demo/sessions/${sessionId}/notices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'b', operationId: 'op-1', text: TEXT, sender: 'other' }),
    });
    expect(posted.status).toBe(200);
    const { sourceId } = (await posted.json()) as { sourceId: string };
    const view = (await (
      await app.request(`/api/demo/sessions/${sessionId}/view?member=b`)
    ).json()) as ViewBody;
    expect(view.readings.find((r) => r.sourceId === sourceId)?.check).toEqual([`${sourceId}#1`]);
    expect(view.plan.arrangements.filter((a) => a.kind === 'need')).toEqual([]);
    // 食い違う読み取りも、確かめる札に出し、家族が締切を直せば計画に入る（黙って捨てない）。
    expect(needCards(view, 'needCheck')).toEqual(['窓口での申し込み']);
    expect(
      await send(app, sessionId, 'b', 'fix-1', {
        type: 'correctItem',
        itemId: `${sourceId}:i1`,
        interpretation: { deadline: '2026-11-26T00:00+09:00', deadlineDayOnly: true },
        seen: { throughSeq: view.plan.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const fixed = await viewOf(app, sessionId, 'b');
    expect(fixed.plan.arrangements.filter((a) => a.kind === 'need')).toHaveLength(1);
    expect(needCards(fixed, 'need')).toEqual(['窓口での申し込み']);
  });

  it('読み取りの日時が過ぎていても、条件の答えで今は要らなくても、確かめる札は消さない（確かめていない日時・条件で隠さない）', async () => {
    const TEXT = '12月4日（金）までに地区センターへ申し込んでください。';
    const misread =
      (over: Partial<ExtractionOutput['items'][number]>, family: boolean): NoticeReader =>
      async (request) => {
        const [s1] = request.source.sentences.map((s) => s.id);
        if (!s1) throw new Error('文が無い');
        return {
          output: {
            items: [
              {
                ...blank,
                id: 'i1',
                sentenceIds: [s1],
                kind: 'need',
                written: TEXT,
                deadline: '2026-12-04',
                what: '地区センターへの申し込み',
                shape: 'by',
                ...over,
              },
            ],
            // 原文に無い条件を読んだ（家族が決める値）。
            unknowns: family
              ? [{ id: 'u1', label: '参加するか', values: ['yes', 'no'], kind: 'family' }]
              : [],
            conditions: family
              ? [{ id: 'c1', kind: 'eq', unknownId: 'u1', value: 'yes', childIds: [] }]
              : [],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
          model: 'test-model',
          promptVersion: 'test',
          inputHash: `test-${request.source.id}`,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      };
    // 締切を、届いた日（11/25）より前の日に読み違えた（食い違いの印は付くが、まだ要る物かもしれない）。
    const past = createApp({ reader: misread({ deadline: '2026-11-24' }, false) });
    const first = await sessionWith(past, TEXT, 'school');
    const pastView = await viewOf(past, first.sessionId, 'b');
    expect(pastView.readings.find((r) => r.sourceId === first.sourceId)?.check).toEqual([
      `${first.sourceId}#1`,
    ]);
    expect(needCards(pastView, 'needCheck')).toEqual(['地区センターへの申し込み']);
    // 原文に無い条件を読み、家族がその問いに「いいえ」と答えた：今は要らないが、札は残す。
    const conditional = createApp({ reader: misread({ conditionNodeId: 'c1' }, true) });
    const second = await sessionWith(conditional, TEXT, 'school');
    const before = await viewOf(conditional, second.sessionId, 'b');
    expect(
      await send(conditional, second.sessionId, 'b', 'answer-no', {
        type: 'answer',
        unknownId: `${second.sourceId}:u1`,
        value: 'no',
        seen: { throughSeq: before.plan.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await viewOf(conditional, second.sessionId, 'b');
    const need = after.plan.requirements.find((r) => r.what === '地区センターへの申し込み');
    expect(need).toMatchObject({ live: false, unconfirmed: true });
    expect(needCards(after, 'needCheck')).toEqual(['地区センターへの申し込み']);
  });

  it('文を直して読み直す前は、前の読み取りを確かめ・直し・外しさせない（読み直した後は、新しい読み取りを確かめる）', async () => {
    const NOW = '2026-11-25T20:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
    const need = (text: string, deadline: string): Item => ({
      id: 'f9:i1',
      sourceId: 'f9',
      sentenceIds: ['f9#1'],
      kind: 'need',
      written: text,
      interpretation: { what: '申し込み', shape: 'by', deadline, deadlineDayOnly: true },
      evidence: 'stated',
      effects: [],
    });
    const reading = (version: number, item: Item) => ({
      type: 'modelOutputRecorded' as const,
      call: 'extract' as const,
      sourceId: 'f9',
      sourceVersion: version,
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: `f9-${version}`,
      output: {
        sourceId: 'f9',
        items: [item],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    });
    const before = '12月5日までに申し込んでください。';
    const after = '12月3日までに申し込んでください。';
    await store.withHousehold('demo', (log) => {
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              id: 'f9',
              version: 1,
              receivedAt: NOW,
              sender: 'school',
              language: 'ja',
              medium: 'text',
              sentences: [{ id: 'f9#1', text: before }],
            },
          },
          reading(1, need(before, '2026-12-05T08:00+09:00')),
          // 文を直した（読み直しはまだ）。
          {
            type: 'transcriptionCorrected',
            sourceId: 'f9',
            sourceVersion: 2,
            sentences: [{ id: 'f9#1', text: after }],
          },
        ],
        'b',
        NOW,
      );
    });
    const latest = async () =>
      (await store.withHousehold('demo', (log) => computePlan(log.events(), NOW))).throughSeq;
    let n = 0;
    const run = async (command: Record<string, unknown>) =>
      runCommand(
        store,
        'demo',
        { memberId: 'b', now: NOW, operationId: `reread-${++n}`, demo: true },
        { ...command, itemId: 'f9:i1', seen: { throughSeq: await latest() } } as never,
      );
    for (const command of [
      { type: 'confirmItem' },
      { type: 'correctItem', interpretation: { deadline: '2026-12-03T00:00+09:00' } },
      { type: 'dismissItem', reason: 'misread' },
    ]) {
      expect(await run(command)).toMatchObject({ status: 'conflict', reason: 'rereadPending' });
    }
    // 読み直した後は、新しい読み取り（12/3）を確かめて計画に入れる。
    await store.withHousehold('demo', (log) => {
      log.append([reading(2, need(after, '2026-12-03T08:00+09:00'))], 'system', NOW);
    });
    expect(await run({ type: 'confirmItem' })).toMatchObject({ status: 'ok' });
    const plan = await store.withHousehold('demo', (log) => computePlan(log.events(), NOW));
    const requirement = plan.requirements.find((r) => r.basis.itemIds.includes('f9:i1'));
    expect(requirement).not.toHaveProperty('unconfirmed');
    expect(requirement?.by?.startsWith('2026-12-03')).toBe(true);
  });

  it('確かめる札には、読み取りの条件の式を連結のまま渡す（「かつ」を「または」と読み違えても、家族が見て分かる）', async () => {
    const TEXT = '行事が開催され、かつ参加を希望する場合だけ、12月4日までに申し込んでください。';
    const misread: NoticeReader = async (request) => {
      const [s1] = request.source.sentences.map((s) => s.id);
      if (!s1) throw new Error('文が無い');
      return {
        output: {
          items: [
            {
              ...blank,
              id: 'i1',
              sentenceIds: [s1],
              kind: 'need',
              written: TEXT,
              deadline: '2026-12-04',
              what: '行事の申し込み',
              conditionNodeId: 'c1',
              shape: 'by',
            },
          ],
          unknowns: [
            { id: 'u1', label: '行事が開催されるか', values: ['yes', 'no'], kind: 'schedule' },
            { id: 'u2', label: '参加を希望するか', values: ['yes', 'no'], kind: 'family' },
          ],
          // 「かつ」を「または」と読み違えた。
          conditions: [
            { id: 'c1', kind: 'or', unknownId: null, value: null, childIds: ['c2', 'c3'] },
            { id: 'c2', kind: 'eq', unknownId: 'u1', value: 'yes', childIds: [] },
            { id: 'c3', kind: 'eq', unknownId: 'u2', value: 'yes', childIds: [] },
          ],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
        model: 'test-model',
        promptVersion: 'test',
        inputHash: `test-${request.source.id}`,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    };
    const app = createApp({ reader: misread });
    const { sessionId, sourceId } = await sessionWith(app, TEXT, 'school');
    const view = await viewOf(app, sessionId, 'b');
    expect(view.items.find((i) => i.item.id === `${sourceId}:i1`)?.condition).toEqual({
      kind: 'or',
      children: [
        { kind: 'eq', label: '行事が開催されるか', value: 'yes' },
        { kind: 'eq', label: '参加を希望するか', value: 'yes' },
      ],
    });
    expect(needCards(view, 'needCheck')).toEqual(['行事の申し込み']);
  });

  it('条件の式か答える値を見せられない読み取りは、確かめ・直しを断る（外すことはできる）', async () => {
    const NOW = '2026-11-25T20:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
    const text = '希望する場合は、12月4日までに申し込んでください。';
    await store.withHousehold('demo', (log) => {
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              id: 'f8',
              version: 1,
              receivedAt: NOW,
              sender: 'school',
              language: 'ja',
              medium: 'text',
              sentences: [{ id: 'f8#1', text }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'f8',
            sourceVersion: 1,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'f8',
            output: {
              sourceId: 'f8',
              items: [
                {
                  id: 'f8:i1',
                  sourceId: 'f8',
                  sentenceIds: ['f8#1'],
                  kind: 'need',
                  written: text,
                  interpretation: {
                    what: '申し込み',
                    shape: 'by',
                    deadline: '2026-12-04T08:00+09:00',
                    deadlineDayOnly: true,
                  },
                  // 宣言の無い値を条件に使った（名前を見せられない）。
                  conditionNodeId: 'f8:c1',
                  evidence: 'stated',
                  effects: [],
                },
              ],
              unknowns: [],
              conditions: [{ id: 'f8:c1', kind: 'eq', unknownId: 'f8:u9', value: 'yes' }],
              irrelevantSentenceIds: [],
              ambiguities: [],
            },
          },
        ],
        'b',
        NOW,
      );
    });
    const seen = {
      throughSeq: (await store.withHousehold('demo', (log) => computePlan(log.events(), NOW)))
        .throughSeq,
    };
    let n = 0;
    const run = (command: Record<string, unknown>) =>
      runCommand(
        store,
        'demo',
        { memberId: 'b', now: NOW, operationId: `unshown-${++n}`, demo: true },
        { ...command, itemId: 'f8:i1', seen } as never,
      );
    expect(await run({ type: 'confirmItem' })).toMatchObject({
      status: 'invalid',
      reason: 'readingUnshown',
    });
    expect(
      await run({ type: 'correctItem', interpretation: { deadline: '2026-12-04T17:00+09:00' } }),
    ).toMatchObject({ status: 'invalid', reason: 'readingUnshown' });
    expect(await run({ type: 'dismissItem', reason: 'misread' })).toMatchObject({ status: 'ok' });
  });

  it('見せた後に、ほかの出典の読み直しで条件の値の名前が替わったら、古い画面からの確かめを断る（見せた計画の番号が今と同じ時だけ受ける）', async () => {
    const NOW = '2026-11-25T20:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
    const source = (id: string, text: string) => ({
      id,
      version: 1,
      receivedAt: NOW,
      sender: 'school' as const,
      language: 'ja' as const,
      medium: 'text' as const,
      sentences: [{ id: `${id}#1`, text }],
    });
    // 値（g7:u1）は別のお知らせ g7 が宣言し、「すること」の条件はそれを使う。
    const declare = (label: string) => ({
      type: 'modelOutputRecorded' as const,
      call: 'extract' as const,
      sourceId: 'g7',
      sourceVersion: 1,
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: `g7-${label}`,
      output: {
        sourceId: 'g7',
        items: [],
        unknowns: [{ id: 'g7:u1', label, values: ['yes', 'no'], kind: 'schedule' as const }],
        conditions: [],
        irrelevantSentenceIds: ['g7#1'],
        ambiguities: [],
      },
    });
    const text = '開催される場合は、12月4日までに申し込んでください。';
    await store.withHousehold('demo', (log) => {
      log.append(
        [
          { type: 'noticeReceived', source: source('g7', '行事の予定です。') },
          declare('行事が開催されるか'),
          { type: 'noticeReceived', source: source('f7', text) },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'f7',
            sourceVersion: 1,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'f7',
            output: {
              sourceId: 'f7',
              items: [
                {
                  id: 'f7:i1',
                  sourceId: 'f7',
                  sentenceIds: ['f7#1'],
                  kind: 'need',
                  written: text,
                  interpretation: {
                    what: '申し込み',
                    shape: 'by',
                    deadline: '2026-12-04T08:00+09:00',
                    deadlineDayOnly: true,
                  },
                  conditionNodeId: 'f7:c1',
                  evidence: 'stated',
                  effects: [],
                },
              ],
              unknowns: [],
              conditions: [{ id: 'f7:c1', kind: 'eq', unknownId: 'g7:u1', value: 'yes' }],
              irrelevantSentenceIds: [],
              ambiguities: [],
            },
          },
        ] as never,
        'b',
        NOW,
      );
    });
    const throughSeq = async () =>
      (await store.withHousehold('demo', (log) => computePlan(log.events(), NOW))).throughSeq;
    const shown = await throughSeq();
    // 見せた後に、g7 を読み直して、同じ値の名前が替わった（「すること」の出典は替わっていない）。
    await store.withHousehold('demo', (log) => {
      log.append([declare('参加を希望するか')] as never, 'system', NOW);
    });
    let n = 0;
    const confirm = (seen: number) =>
      runCommand(
        store,
        'demo',
        { memberId: 'b', now: NOW, operationId: `cross-${++n}`, demo: true },
        { type: 'confirmItem', itemId: 'f7:i1', seen: { throughSeq: seen } },
      );
    expect(await confirm(shown)).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect(await confirm(await throughSeq())).toMatchObject({ status: 'ok' });
    const requirement = async () =>
      (
        await store.withHousehold('demo', (log) => computePlan(log.events(), NOW))
      ).requirements.find((r) => r.basis.itemIds.includes('f7:i1'));
    expect((await requirement())?.unconfirmed).toBeUndefined();
    // 確かめた後に、条件の値を宣言する g7 を（同じ中身で）読み直すと、確かめはやり直し（札が戻る）。
    await store.withHousehold('demo', (log) => {
      log.append(
        [{ ...declare('参加を希望するか'), inputHash: 'g7-again' }] as never,
        'system',
        NOW,
      );
    });
    expect(await requirement()).toMatchObject({ unconfirmed: true });
  });

  it('同じ名前の別々の問いへの答えは、お知らせで見分けられる時だけ確かめられる（見分けられなければ断る）', async () => {
    const NOW = '2026-11-25T20:00+09:00';
    const source = (id: string, text: string, title?: string) => ({
      id,
      version: 1,
      receivedAt: NOW,
      sender: 'school' as const,
      language: 'ja' as const,
      medium: 'text' as const,
      sentences: [{ id: `${id}#1`, text }],
      ...(title ? { title } : {}),
    });
    const declare = (sourceId: string) => ({
      type: 'modelOutputRecorded' as const,
      call: 'extract' as const,
      sourceId,
      sourceVersion: 1,
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: sourceId,
      output: {
        sourceId,
        items: [],
        unknowns: [
          {
            id: `${sourceId}:u1`,
            label: '参加するか',
            values: ['yes', 'no'],
            kind: 'family' as const,
          },
        ],
        conditions: [],
        irrelevantSentenceIds: [`${sourceId}#1`],
        ambiguities: [],
      },
    });
    const text = '運動会に参加する場合は、12月4日までに申し込んでください。';
    const run = async (title?: string) => {
      const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
      await store.withHousehold('demo', (log) => {
        log.append(
          [
            { type: 'noticeReceived', source: source('g5', '交流会のお知らせです。') },
            declare('g5'),
            { type: 'noticeReceived', source: source('g6', '運動会のお知らせです。', title) },
            declare('g6'),
            { type: 'noticeReceived', source: source('f6', text) },
            {
              type: 'modelOutputRecorded',
              call: 'extract',
              sourceId: 'f6',
              sourceVersion: 1,
              model: 'fixture',
              promptVersion: 'fixture',
              inputHash: 'f6',
              output: {
                sourceId: 'f6',
                items: [
                  {
                    id: 'f6:i1',
                    sourceId: 'f6',
                    sentenceIds: ['f6#1'],
                    kind: 'need',
                    written: text,
                    interpretation: {
                      what: '申し込み',
                      shape: 'by',
                      deadline: '2026-12-04T08:00+09:00',
                      deadlineDayOnly: true,
                    },
                    evidence: 'stated',
                    effects: [{ type: 'resolveUnknown', unknownId: 'g6:u1', value: 'yes' }],
                  },
                ],
                unknowns: [],
                conditions: [],
                irrelevantSentenceIds: [],
                ambiguities: [],
              },
            },
          ] as never,
          'b',
          NOW,
        );
      });
      const throughSeq = (
        await store.withHousehold('demo', (log) => computePlan(log.events(), NOW))
      ).throughSeq;
      return runCommand(
        store,
        'demo',
        { memberId: 'b', now: NOW, operationId: 'same-label', demo: true },
        { type: 'confirmItem', itemId: 'f6:i1', seen: { throughSeq } },
      );
    };
    // 同じ日に届いた、題の無いお知らせ二つに「参加するか」：どちらへの答えか見分けられない。
    expect(await run()).toMatchObject({ status: 'invalid', reason: 'readingUnshown' });
    // 題があれば見分けられる。
    expect(await run('運動会だより')).toMatchObject({ status: 'ok' });
  });
});
