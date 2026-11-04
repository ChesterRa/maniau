// 例 2：学校の行事でない家庭の用事（区への、来年度の学童クラブの継続の申し込み）を、お知らせから読んだ締切の
// 「すること」として、正式な命令で通す：確かめる → 家族が決める条件に答える → やり方を選ぶ → 本命 → 引き受け →
// 済み。やり方は家の情報のデータ（区のホームページ・地区センターの窓口）で、場面の分岐を足さない
// （02-foundation §3.4）。窓口（決まった場所、平日 9:00〜17:00）は、ふだんの予定にその場所にいる区間が無いので
// 置けない。決め時を出さず、過ぎたとも言わず、勧めない。
// 読み取りは、この試験のために手で書いた v4 の形（モデルの出力ではない）。形は、同じ文を一度実際に読ませた時の
// 応答に合わせた（docs/dev/claude-usage.md）。Claude の API は呼ばない。
import {
  type Arrangement,
  type Command,
  type DomainEvent,
  type ExtractionOutput,
  notificationHistory,
  notificationIntents,
  type PlanResult,
  type PreviewCommand,
  proposalSnapshot,
  type Source,
  splitSentences,
  type Task,
  taskContent,
  todayCards,
  toExtraction,
} from '@maniau/core';
import { computePlan, currentItems, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import type { NoticeReader } from '../src/demo-sessions';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const FIRST =
  '来年度も学童クラブを利用する家庭は、12月4日（金）までに継続の申し込みをしてください。';
const TEXT = `${FIRST}申し込みは、地区センターの窓口（平日 9:00〜17:00）か、区のホームページの申し込みフォームでできます。`;
const ONLINE = 'way-apply-online';
const COUNTER = 'way-apply-counter';

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

/** 締切（事実）と、同じ文の「すること」（締切まで）。どちらも、家族が決める値（来年度も使うか）しだい。 */
const reader: NoticeReader = async (request) => {
  const [s1, s2] = request.source.sentences.map((s) => s.id);
  if (!s1 || !s2) throw new Error(`文が足りない：${request.source.sentences.length}`);
  const common = {
    ...blank,
    written: FIRST,
    deadline: '2026-12-04',
    writtenWeekday: 'fri' as const,
    what: '学童クラブの継続の申し込み',
    audience: '来年度も学童クラブを利用する家庭',
    conditionNodeId: 'c1',
  };
  const output: ExtractionOutput = {
    items: [
      { ...common, id: 'i1', sentenceIds: [s1], kind: 'deadline' },
      {
        ...common,
        id: 'i2',
        sentenceIds: [s1, s2],
        kind: 'need',
        place: '地区センターの窓口（平日 9:00〜17:00）か、区のホームページの申し込みフォーム',
        shape: 'by',
      },
    ],
    unknowns: [
      { id: 'u1', label: '来年度も学童クラブを利用するか', values: ['yes', 'no'], kind: 'family' },
    ],
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
  plan: PlanResult;
  readings: { sourceId: string; check: string[] }[];
  today: { main: { kind: string; requirement?: { what: string }; task?: { key: string } }[] };
}

/** デモの家（11/25 19:31）に、大人 b がお知らせを入れる。 */
async function started() {
  const app = createApp({ reader });
  const made = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'arrived' }),
  });
  const { sessionId } = (await made.json()) as { sessionId: string };
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const posted = await app.request(
    `/api/demo/sessions/${sessionId}/notices`,
    json({ memberId: 'b', operationId: 'op-notice', text: TEXT, sender: 'other' }),
  );
  expect(posted.status).toBe(200);
  const { sourceId } = (await posted.json()) as { sourceId: string };
  const view = async (member = 'b') =>
    (await (
      await app.request(`/api/demo/sessions/${sessionId}/view?member=${member}`)
    ).json()) as ViewBody;
  let op = 0;
  const send = async (command: unknown, member = 'b') =>
    (
      (await (
        await app.request(
          `/api/demo/sessions/${sessionId}/commands`,
          json({ memberId: member, operationId: `op-${++op}`, command }),
        )
      ).json()) as { result: { status: string; reason?: string } }
    ).result;
  /** 画面と同じく、変わることを見てから書く（見た計画の番号と、見た物の要約を付ける）。 */
  const previewed = async (command: { type: string } & Record<string, unknown>, member = 'b') => {
    const shown = (await (
      await app.request(
        `/api/demo/sessions/${sessionId}/change-preview`,
        json({ memberId: member, command }),
      )
    ).json()) as { preview?: { seen: unknown } };
    if (!shown.preview) throw new Error('変わることを見られない');
    const { plan } = await view(member);
    return send({ ...command, seen: { throughSeq: plan.throughSeq, changes: shown.preview.seen } });
  };
  const itemId = `${sourceId}:i2`;
  const need = (plan: PlanResult) => {
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = (wayId: string) => arrangement?.options.find((o) => o.templateId === wayId);
    const task = (wayId: string): Task | undefined =>
      plan.tasks.find((t) => t.live && t.basis.optionKey === option(wayId)?.key);
    return { arrangement, option, task };
  };
  /** 確かめ、来年度も使うと答え、やり方を選ぶ。 */
  const ready = async (wayIds: string[]) => {
    const { plan } = await view();
    expect(
      await send({ type: 'confirmItem', itemId, seen: { throughSeq: plan.throughSeq } }),
    ).toMatchObject({ status: 'ok' });
    const now = (await view()).plan;
    const question = now.questions.find((q) => q.unknownId === `${sourceId}:u1`);
    if (!question) throw new Error('家族の問いが無い');
    expect(
      await send({
        type: 'answer',
        unknownId: question.unknownId,
        value: 'yes',
        seen: {
          throughSeq: now.throughSeq,
          question: {
            key: question.key,
            ...(question.until ? { until: question.until } : {}),
            affects: question.affects,
          },
        },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await previewed({ type: 'setNeedWays', itemId, wayIds })).toMatchObject({
      status: 'ok',
    });
    return need((await view()).plan);
  };
  return { sourceId, itemId, view, send, ready, need };
}

const cards = (view: ViewBody, kind: string) =>
  view.today.main.filter((c) => c.kind === kind).map((c) => c.requirement?.what ?? c.task?.key);

const step = (arrangement: Arrangement | undefined) => arrangement?.status;

describe('例 2：お知らせから読んだ締切の「すること」を、やり方のデータで済みまで通す', () => {
  it('確かめ・答え・やり方・本命・引き受け・済みを通す。窓口は置ける時間が無いと示し、区のホームページを勧める', async () => {
    const { sourceId, view, send, ready, need } = await started();
    // 入れた時：確かめる札と、家族が決める値の問い。日だけの締切と、時刻の書かれた文（窓口の時間）を確かめてもらう。
    const first = await view();
    expect(cards(first, 'needCheck')).toEqual(['学童クラブの継続の申し込み']);
    expect(
      first.plan.questions.some(
        (q) =>
          q.unknownId === `${sourceId}:u1` && q.family?.label === '来年度も学童クラブを利用するか',
      ),
    ).toBe(true);
    expect(first.readings.find((r) => r.sourceId === sourceId)?.check).toEqual([
      `${sourceId}#1`,
      `${sourceId}#2`,
    ]);
    expect(first.plan.arrangements.filter((a) => a.kind === 'need')).toEqual([]);

    const { arrangement, option, task } = await ready([ONLINE, COUNTER]);
    // 締切は日だけ（12/4 の終わりまでを目安にする）。答えた後は、条件しだいではない。
    expect(arrangement?.needShape).toBe('by');
    expect(arrangement?.end).toBe('2026-12-04T23:59+09:00');
    expect(arrangement?.conditional).toBeUndefined();
    expect(step(arrangement)).toBe('decidable');
    // 区のホームページ：家か移動の間に置ける。決め時は締切の日の中（目安）。
    const online = option(ONLINE);
    expect(online?.decisionDeadline?.slice(0, 10)).toBe('2026-12-04');
    expect(online?.deadlineCertainty).toBe('estimate');
    expect(online?.expired).toBe(false);
    // 窓口：ふだんの予定に、地区センターにいる区間が無い。決め時を出さず、過ぎたと言わない。作業に時刻を置かない。
    const counter = option(COUNTER);
    expect(counter?.decisionDeadline).toBeUndefined();
    expect(counter?.deadlineCertainty).toBe('undetermined');
    expect(counter?.noSlot).toBe(true);
    expect(counter?.expired).toBe(false);
    expect(task(COUNTER)?.start).toBeUndefined();
    // 勧めるのは、間に合うと分かっている区のホームページだけ。
    expect(arrangement?.recommendedOptionKey).toBe(online?.key);
    expect(arrangement?.recommendedReason).toBe('onlyOption');

    // 本命にして、b が引き受け、済ませる。
    if (!arrangement || !online) throw new Error('案が無い');
    expect(
      await send({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: online.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const chosen = await view();
    const proposed = need(chosen.plan).task(ONLINE);
    expect(proposed?.assigneeId).toBe('b');
    expect(proposed?.titleParams.what).toBe('区のホームページの申し込みフォームで申し込む');
    expect(proposed?.start && proposed.start <= '2026-12-04T23:59+09:00').toBe(true);
    expect(cards(chosen, 'proposal')).toEqual([proposed?.key]);
    expect(cards(chosen, 'need')).toEqual([]);
    const shown = proposed && proposalSnapshot(proposed);
    if (!proposed || !shown) throw new Error('引き受ける作業が無い');
    expect(await send({ type: 'accept', taskKey: proposed.key, shown })).toMatchObject({
      status: 'ok',
    });
    const accepted = need((await view()).plan).task(ONLINE);
    if (!accepted) throw new Error('引き受けた作業が無い');
    expect(
      await send({
        type: 'commitment',
        taskKey: accepted.key,
        action: 'done',
        seen: taskContent(accepted),
      }),
    ).toMatchObject({ status: 'ok' });
    for (const member of ['a', 'b']) {
      const done = await view(member);
      expect(need(done.plan).task(ONLINE)?.commitment).toBe('done');
      expect(cards(done, 'need')).toEqual([]);
      expect(cards(done, 'needCheck')).toEqual([]);
      expect(cards(done, 'proposal')).toEqual([]);
    }
  });

  it('窓口だけを選ぶと、まだ判断できない（取れない・過ぎたとは言わない。勧めない）。本命に選べば、時刻の無い作業として出す', async () => {
    const { send, view, ready, need } = await started();
    const { arrangement, option } = await ready([COUNTER]);
    const counter = option(COUNTER);
    expect(step(arrangement)).toBe('undetermined');
    expect(arrangement?.reasons).toEqual([{ code: 'noSlot', refs: [counter?.key] }]);
    expect(arrangement?.recommendedOptionKey).toBeUndefined();
    expect(counter?.noSlot).toBe(true);
    expect(counter?.expired).toBe(false);
    expect(cards(await view(), 'need')).toEqual(['学童クラブの継続の申し込み']);
    // 家族が休みを取って行く等で、本命に選べる。作業は時刻を置かず、b に出す（過ぎた・置いたと言わない）。
    if (!arrangement || !counter) throw new Error('案が無い');
    expect(
      await send({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: counter.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const chosen = await view();
    const now = need(chosen.plan);
    expect(step(now.arrangement)).toBe('decidable');
    expect(now.arrangement?.reasons.map((r) => r.code)).not.toContain('missedDeadline');
    const task = now.task(COUNTER);
    expect(task?.assigneeId).toBe('b');
    expect(task?.start).toBeUndefined();
    expect(cards(chosen, 'proposal')).toEqual([task?.key]);
  });

  it('窓口だけを選んでも、本命にしても、計画の検証と知らせの門を通る（家庭のほかの知らせを止めない）', async () => {
    const NOW = '2026-11-25T20:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    let n = 0;
    const run = (command: Command) =>
      runCommand(
        store,
        'demo',
        { memberId: 'b', now: NOW, operationId: `gate-${++n}`, demo: true },
        command,
      );
    /** 画面と同じく、見てから書く。 */
    const write = async (command: PreviewCommand) => {
      const shown = previewChange(await events(), { memberId: 'b', now: NOW }, command);
      if ('reason' in shown) throw new Error(shown.reason);
      expect(
        await run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
      ).toMatchObject({ status: 'ok' });
    };
    // 確かめる時刻：デモの家の手配の決め時（学童 11/30 17:20）が近く、ほかの知らせが出る時。
    const LATER = '2026-11-29T21:00+09:00';
    const checked = async () => {
      const all = await events();
      const plan = computePlan(all, LATER);
      const household = all.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
      if (!household) throw new Error('家庭が無い');
      expect(
        verifyPlan({ household, plan, events: all }).issues.filter((i) => i.kind === 'violation'),
      ).toEqual([]);
      const intents = notificationIntents(plan, household, notificationHistory(all));
      const gate = sendGate({
        household,
        plan,
        events: all,
        intents,
        batchEnds: all.map((e) => e.seq),
      });
      expect(gate.all).toBe(false);
      expect(intents.filter((intent) => gate.blocked.has(intent.key))).toEqual([]);
      return { plan, intents };
    };
    await write({
      type: 'stateNeed',
      text: '12月4日までに、学童クラブの継続を申し込む。',
      interpretation: {
        what: '学童クラブの継続の申し込み',
        shape: 'by',
        date: '2026-12-04',
        deadline: '2026-12-04T00:00+09:00',
        deadlineDayOnly: true,
      },
    });
    const itemId = computePlan(await events(), NOW).requirements.find(
      (r) => r.kind === 'need' && r.live,
    )?.basis.itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    await write({ type: 'setNeedWays', itemId, wayIds: [COUNTER] });
    const { plan, intents } = await checked();
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    expect(arrangement?.status).toBe('undetermined');
    expect(arrangement?.reasons.map((r) => r.code)).toEqual(['noSlot']);
    // デモの家のほかの知らせ（学習発表会の手配など）は出る。この「すること」は札だけ（知らせない）。
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.filter((i) => i.subject.id === arrangement?.key)).toEqual([]);
    // 本命にしても通る。
    const counter = arrangement?.options.find((o) => o.templateId === COUNTER);
    if (!arrangement || !counter) throw new Error('案が無い');
    expect(
      await run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: counter.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await checked();
    expect(after.plan.arrangements.find((a) => a.key === arrangement.key)?.status).toBe(
      'decidable',
    );
    // 二つを選べば、区のホームページを勧める（窓口の印は残る）。
    await write({ type: 'setNeedWays', itemId, wayIds: [ONLINE, COUNTER] });
    const both = (await checked()).plan.arrangements.find((a) => a.key === arrangement.key);
    expect(both?.reasons.map((r) => r.code)).not.toContain('noSlot');
  });
});

/** 正式の命令で家に書き、ある時刻の計画が検証と知らせの門を通るかを見る（デモの家。言った時刻 now）。 */
function formal(now: string) {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let n = 0;
  const run = (command: Command, memberId = 'b') =>
    runCommand(store, 'demo', { memberId, now, operationId: `f-${++n}`, demo: true }, command);
  const write = async (command: PreviewCommand) => {
    const shown = previewChange(await events(), { memberId: 'b', now }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(
      await run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
  };
  /** 言って、やり方を選ぶ。 */
  const need = async (text: string, interpretation: Record<string, unknown>, wayIds: string[]) => {
    await write({ type: 'stateNeed', text, interpretation } as PreviewCommand);
    const itemId = computePlan(await events(), now).requirements.find(
      (r) => r.kind === 'need' && r.live,
    )?.basis.itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    await write({ type: 'setNeedWays', itemId, wayIds });
  };
  /** at の計画：検証の違反が無く、知らせの門が家庭の全部を止めない。 */
  const gate = async (at: string) => {
    const all = await events();
    const plan = computePlan(all, at);
    const household = all.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
    if (!household) throw new Error('家庭が無い');
    expect(
      verifyPlan({ household, plan, events: all })
        .issues.filter((i) => i.kind === 'violation')
        .map((i) => i.code),
    ).toEqual([]);
    const intents = notificationIntents(plan, household, notificationHistory(all));
    const result = sendGate({
      household,
      plan,
      events: all,
      intents,
      batchEnds: all.map((e) => e.seq),
    });
    expect(result.all).toBe(false);
    return plan.arrangements.find((a) => a.kind === 'need' && a.live);
  };
  /** お知らせを入れて読む（手で書いた v4 の形を、製品と同じ変換で読み取りにする。API は呼ばない）。 */
  const notice = async (id: string) => {
    const source: Source = {
      id,
      version: 1,
      receivedAt: now,
      sender: 'other',
      language: 'ja',
      medium: 'text',
      sentences: splitSentences(TEXT, id),
    };
    const result = await reader({ source } as Parameters<NoticeReader>[0]);
    const { extraction } = toExtraction(result.output, source, {
      priorItems: [],
      priorUnknowns: [],
    });
    await store.withHousehold('demo', (log) => {
      log.append([{ type: 'noticeReceived', source }], 'b', now);
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: result.model,
            promptVersion: result.promptVersion,
            inputHash: result.inputHash,
            sourceId: id,
            sourceVersion: 1,
            output: extraction,
          },
        ],
        'system',
        now,
      );
    });
    const throughSeq = (await events()).at(-1)?.seq ?? 0;
    expect(
      await run({ type: 'confirmItem', itemId: `${id}:i2`, seen: { throughSeq } }),
    ).toMatchObject({ status: 'ok' });
    return `${id}:i2`;
  };
  /** 元の「すること」を置き換えるお知らせを、製品と同じ変換で読み取りにして入れる（手で書いた v4 の形。API は呼ばない）。 */
  const replaceNotice = async (itemId: string, text: string) => {
    const source: Source = {
      id: 'next-need',
      version: 1,
      receivedAt: now,
      sender: 'other',
      language: 'ja',
      medium: 'text',
      sentences: [{ id: 'next-need#1', text }],
    };
    const output: ExtractionOutput = {
      items: [
        {
          ...blank,
          id: 'i1',
          sentenceIds: ['next-need#1'],
          kind: 'need',
          written: text,
          date: '2026-12-04',
          startTime: '08:00',
          endTime: '18:00',
          what: '陽菜を見てもらう',
          shape: 'window',
          effects: [{ type: 'replace', itemId, unknownId: null, value: null }],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const prior = currentItems(foldEvents(await events())).map((entry) => entry.item);
    const { extraction } = toExtraction(output, source, { priorItems: prior, priorUnknowns: [] });
    expect(extraction.items[0]?.effects).toContainEqual({ type: 'replace', itemId });
    await store.withHousehold('demo', (log) => {
      log.append([{ type: 'noticeReceived', source }], 'b', now);
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            sourceId: source.id,
            sourceVersion: 1,
            output: extraction,
          },
        ],
        'system',
        now,
      );
    });
  };
  return { need, gate, notice, write, run, events, replaceNotice };
}

/**
 * at の計画を確かめる：検証の違反が無く、知らせの門が家庭の全部を止めず、ほかの手配の本当の知らせ（この
 * 「すること」の手配でない物）があって、止まっていない。
 */
async function checked(events: () => Promise<DomainEvent[]>, at: string, needKey: string) {
  const all = await events();
  const plan = computePlan(all, at);
  const household = all.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
  if (!household) throw new Error('家庭が無い');
  expect(
    verifyPlan({ household, plan, events: all })
      .issues.filter((i) => i.kind === 'violation')
      .map((i) => i.code),
  ).toEqual([]);
  const intents = notificationIntents(plan, household, notificationHistory(all));
  const other = intents.find((i) => i.subject.type === 'arrangement' && i.subject.id !== needKey);
  expect(other).toBeDefined();
  const result = sendGate({
    household,
    plan,
    events: all,
    intents,
    batchEnds: all.map((e) => e.seq),
  });
  expect(result.all).toBe(false);
  if (other) expect(result.blocked.has(other.key)).toBe(false);
  return plan;
}

describe('決め時を出せない時、締切の後も、家庭の知らせを止めない（今日より前の最後の機会・置けない・締切の後）', () => {
  it('子が熱を出した朝に言った「すること」：病児保育も祖母も、前の晩の決め時を過ぎた（証拠のある過ぎた）', async () => {
    const f = formal('2026-11-26T07:00+09:00');
    await f.need(
      '陽菜が熱っぽい。きょう8時から18時まで、だれかが家で見る。',
      {
        what: '陽菜を家で見る',
        shape: 'window',
        date: '2026-11-26',
        startTime: '08:00',
        endTime: '18:00',
        forMemberId: 'c',
      },
      ['way-sick-care', 'way-grandma'],
    );
    const arrangement = await f.gate('2026-11-26T07:00+09:00');
    expect(arrangement?.status).toBe('infeasible');
    expect(arrangement?.reasons.map((r) => r.code)).toEqual(['noOptionLeft']);
    for (const option of arrangement?.options ?? []) {
      expect(option.expired).toBe(true);
      expect(option.decisionDeadline?.slice(0, 10)).toBe('2026-11-25');
    }
  });

  it('朝のふだんの予定より前の締切（6:15 まで）：前の晩が最後の機会。締切の後も、手配の始まりを終わりの後にしない', async () => {
    const f = formal('2026-11-26T06:00+09:00');
    await f.need(
      'きょう6時15分までに、区のホームページで申し込む。',
      { what: '申し込み', shape: 'by', date: '2026-11-26', deadline: '2026-11-26T06:15+09:00' },
      [ONLINE],
    );
    for (const at of ['2026-11-26T06:00+09:00', '2026-11-26T06:20+09:00']) {
      const arrangement = await f.gate(at);
      expect(arrangement?.status).toBe('infeasible');
      expect(arrangement?.options[0]?.decisionDeadline?.slice(0, 10)).toBe('2026-11-25');
      expect(arrangement && arrangement.start <= arrangement.end).toBe(true);
    }
  });

  it('窓口だけ：締切の前はまだ判断できない、締切の後は過ぎた（決まりの締切で確かめる）。どちらも知らせを止めない', async () => {
    const f = formal('2026-11-25T20:00+09:00');
    await f.need(
      '12月4日までに、学童クラブの継続を申し込む。',
      {
        what: '学童クラブの継続の申し込み',
        shape: 'by',
        date: '2026-12-04',
        deadline: '2026-12-04T00:00+09:00',
        deadlineDayOnly: true,
      },
      [COUNTER],
    );
    const before = await f.gate('2026-12-04T09:00+09:00');
    expect(before?.status).toBe('undetermined');
    expect(before?.reasons.map((r) => r.code)).toEqual(['noSlot']);
    const after = await f.gate('2026-12-05T09:00+09:00');
    expect(after?.options[0]?.expired).toBe(true);
    expect(after?.options[0]?.decisionDeadline).toBeUndefined();
    expect(after?.status).toBe('infeasible');
  });

  it('お知らせから読んだ「すること」：確かめて、家族が決める値に答えないまま窓口だけを選び、締切を過ぎても、知らせを止めない', async () => {
    const f = formal('2026-11-25T20:00+09:00');
    const itemId = await f.notice('w2');
    await f.write({ type: 'setNeedWays', itemId, wayIds: [COUNTER] });
    const before = await f.gate('2026-12-04T09:00+09:00');
    expect(before?.conditional).toBe(true);
    expect(before?.status).toBe('undetermined');
    const after = await f.gate('2026-12-05T09:00+09:00');
    expect(after?.conditional).toBe(true);
    expect(after?.status).toBe('infeasible');
  });
});

describe('返事のある依頼の後に、やり方を選び直す・全部外す・中身が替わる（取り消すか、確かめるか）', () => {
  const NOW = '2026-11-29T21:00+09:00';
  /** 12/3 の窓の「すること」に祖母を選び、本命にして頼み、「はい」をもらう。 */
  async function asked() {
    const f = formal(NOW);
    await f.need(
      '12月3日8時から18時に、陽菜を見てもらう。',
      {
        what: '陽菜を見てもらう',
        shape: 'window',
        date: '2026-12-03',
        startTime: '08:00',
        endTime: '18:00',
        forMemberId: 'c',
      },
      ['way-grandma'],
    );
    let plan = computePlan(await f.events(), NOW);
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = arrangement?.options.find((o) => o.templateId === 'way-grandma');
    const itemId = plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis.itemIds[0];
    if (!arrangement || !option || !itemId) throw new Error('祖母の案が無い');
    expect(
      await f.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    plan = computePlan(await f.events(), NOW);
    const task = plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    if (!task) throw new Error('頼む作業が無い');
    expect(
      await f.run({
        type: 'recordSent',
        taskKey: task.key,
        requestId: 'r-need',
        window: { start: arrangement.start, end: arrangement.end },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await f.run({ type: 'recordReply', requestId: 'r-need', reply: 'yes' })).toMatchObject({
      status: 'ok',
    });
    return { f, itemId, key: arrangement.key };
  }

  it.each([
    ['祖母を外して病児保育を選び直す', ['way-sick-care']],
    ['やり方を全部外す', []],
  ])(
    '%s：祖母への依頼は要らない。保存の前に取り消しを見せ、取り消しの札を出す。知らせを止めない',
    async (_, wayIds) => {
      const { f, itemId, key } = await asked();
      const command = { type: 'setNeedWays', itemId, wayIds } as PreviewCommand;
      const shown = previewChange(await f.events(), { memberId: 'b', now: NOW }, command);
      if ('reason' in shown) throw new Error(shown.reason);
      expect(shown.changes.cancels.map((r) => r.requestId)).toEqual(['r-need']);
      await f.write(command);
      const plan = await checked(f.events, NOW, key);
      const request = plan.requests.find((r) => r.requestId === 'r-need');
      expect(request).toMatchObject({ live: false, state: 'confirmed', to: 'g' });
      expect(plan.arrangements.find((a) => a.key === key)?.chosenOptionKey).toBeUndefined();
      const cancel = todayCards(plan, 'b').main.find((c) => c.kind === 'cancel');
      expect(cancel && 'request' in cancel ? cancel.request.requestId : undefined).toBe('r-need');
    },
  );

  it('祖母に頼む作業を健太が引き受けた後に祖母を外す：健太に要らなくなったと出す（保存の前にも見せる）', async () => {
    const f = formal(NOW);
    await f.need(
      '12月3日8時から18時に、陽菜を見てもらう。',
      {
        what: '陽菜を見てもらう',
        shape: 'window',
        date: '2026-12-03',
        startTime: '08:00',
        endTime: '18:00',
        forMemberId: 'c',
      },
      ['way-grandma'],
    );
    let plan = computePlan(await f.events(), NOW);
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = arrangement?.options.find((o) => o.templateId === 'way-grandma');
    const itemId = plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis.itemIds[0];
    if (!arrangement || !option || !itemId) throw new Error('祖母の案が無い');
    expect(
      await f.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    plan = computePlan(await f.events(), NOW);
    const task = plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    const shownTask = task && proposalSnapshot(task);
    if (!task || !shownTask) throw new Error('頼む作業が無い');
    expect(await f.run({ type: 'accept', taskKey: task.key, shown: shownTask }, 'a')).toMatchObject(
      {
        status: 'ok',
      },
    );
    const command = { type: 'setNeedWays', itemId, wayIds: ['way-sick-care'] } as PreviewCommand;
    const shown = previewChange(await f.events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.released.map((r) => [r.taskKey, r.assigneeId])).toEqual([[task.key, 'a']]);
    await f.write(command);
    plan = await checked(f.events, NOW, arrangement.key);
    expect((plan.released ?? []).map((r) => [r.taskKey, r.assigneeId])).toEqual([[task.key, 'a']]);
  });

  it('中身を直した後（日が替わる。API の correctItem）：やり方を選び直すまで、祖母への依頼は確かめる。知らせを止めない', async () => {
    const { f, itemId, key } = await asked();
    // 計画に入っている「すること」の直しは、見た物が要る（見ずに書かない）。
    expect(
      await f.run({ type: 'correctItem', itemId, interpretation: { date: '2026-12-04' } }),
    ).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
    await f.write({ type: 'correctItem', itemId, interpretation: { date: '2026-12-04' } });
    const plan = await checked(f.events, NOW, key);
    expect(plan.arrangements.find((a) => a.key === key)?.reasons).toEqual([
      { code: 'inputMissing', refs: ['waysChanged'] },
    ]);
    expect(plan.requests.find((r) => r.requestId === 'r-need')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(todayCards(plan, 'b').main.some((c) => c.kind === 'check')).toBe(true);
  });

  it('別のお知らせで置き換えて確かめた後、新しい「すること」のやり方をまだ選んでいない：祖母への依頼は確かめる', async () => {
    const { f, itemId, key } = await asked();
    const text = '12月4日8時から18時に、陽菜を見てもらう。';
    await f.replaceNotice(itemId, text);
    const throughSeq = (await f.events()).at(-1)?.seq ?? 0;
    expect(
      await f.run({ type: 'confirmItem', itemId: 'next-need:i1', seen: { throughSeq } }),
    ).toMatchObject({ status: 'ok' });
    const plan = await checked(f.events, NOW, key);
    expect(plan.requests.find((r) => r.requestId === 'r-need')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(todayCards(plan, 'b').main.some((c) => c.kind === 'check')).toBe(true);
  });
});
