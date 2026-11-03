// 架空の家族の事象から、一言の前提を製品と同じように作る開発用場面。
// 正解は読み取りに渡さず、候補・確認前の事象・確認後の状態を別々に見る。
import type { UtteranceContext, UtteranceOutput } from '../packages/core/src';
import { ExtractionOutput } from '../packages/core/src';
import {
  demoSessions,
  type NoticeReader,
  type ShownReply,
  type UtteranceReader,
} from '../apps/server/src/demo-sessions';

type Expected =
  | { type: 'answer'; unknownId: string; what: string; value: 'yes' | 'no' }
  | { type: 'recordReply'; requestId: string; reply: 'yes' | 'no' }
  | { type: 'question'; itemId: string };

export interface BelongingsCase {
  id: string;
  stage: 'arrived' | 'chase';
  text: string;
  setup?: 'yes-first' | 'bought' | 'handkerchief' | 'second-shirt';
  expected: Expected;
}

export const belongingsCases: readonly BelongingsCase[] = [
  {
    id: 'home-yes',
    stage: 'arrived',
    text: '白い長袖シャツは家にあります。',
    expected: { type: 'answer', unknownId: 'u-atHome:n1:i5', what: '白い長袖シャツ', value: 'yes' },
  },
  {
    id: 'home-no',
    stage: 'arrived',
    text: '白い長袖シャツは家にはありません。',
    expected: { type: 'answer', unknownId: 'u-atHome:n1:i5', what: '白い長袖シャツ', value: 'no' },
  },
  {
    id: 'home-correct-no',
    stage: 'arrived',
    setup: 'yes-first',
    text: 'さっきあると言ったけど、白い長袖シャツはやっぱり家になかった。',
    expected: { type: 'answer', unknownId: 'u-atHome:n1:i5', what: '白い長袖シャツ', value: 'no' },
  },
  {
    id: 'bought-found-home',
    stage: 'chase',
    setup: 'bought',
    text: '白い長袖シャツは家にありました。',
    expected: { type: 'answer', unknownId: 'u-atHome:n1:i5', what: '白い長袖シャツ', value: 'yes' },
  },
  {
    id: 'bought-missing',
    stage: 'chase',
    setup: 'bought',
    text: '買った白い長袖シャツが見つからなくなりました。',
    expected: { type: 'answer', unknownId: 'u-atHome:n1:i5', what: '白い長袖シャツ', value: 'no' },
  },
  {
    id: 'helper-reply',
    stage: 'chase',
    text: 'おばあちゃんは12月7日は大丈夫だって。',
    expected: { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' },
  },
  {
    id: 'item-question',
    stage: 'arrived',
    text: '白い長袖シャツについてのお知らせは何？',
    expected: { type: 'question', itemId: 'n1:i5' },
  },
  {
    id: 'unknown-goods-no',
    stage: 'arrived',
    setup: 'handkerchief',
    text: 'ハンカチは家にないよ。',
    expected: { type: 'answer', unknownId: 'u-atHome:u1:i1', what: 'ハンカチ', value: 'no' },
  },
  {
    id: 'same-name-dated',
    stage: 'arrived',
    setup: 'second-shirt',
    text: '12月14日に使う白い長袖シャツは、家にはありません。',
    expected: { type: 'answer', unknownId: 'u-atHome:u1:i1', what: '白い長袖シャツ', value: 'no' },
  },
];

/** 通信せず、追加する架空のお知らせを固定の応答で読む。 */
function fixtureNotice(
  text: string,
  what: string,
  date: string,
  weekday: 'sat' | 'none',
): NoticeReader {
  return async (request) => {
    const sentenceId = request.source.sentences[0]?.id;
    if (!sentenceId) throw new Error('架空のお知らせに文がない');
    return {
      output: ExtractionOutput.parse({
        items: [
          {
            id: 'i1',
            sentenceIds: [sentenceId],
            kind: 'belongings',
            written: text,
            date,
            writtenWeekday: weekday,
            startTime: null,
            endTime: null,
            what,
            dayType: null,
            deadline: null,
            audience: null,
            place: null,
            relativeDay: 'none',
            conditionNodeId: null,
            inferred: false,
            effects: [],
          },
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      }),
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

/** 実際に提示する前提には正解を含めない。fake は入出力の形を確かめる時だけ使う。 */
export function fixtureUtterance(test: BelongingsCase): UtteranceReader {
  return async () => {
    const expected = test.expected;
    const action = {
      type: expected.type === 'question' ? 'answer' : expected.type,
      taskKey: null,
      requestId: expected.type === 'recordReply' ? expected.requestId : null,
      reply: expected.type === 'recordReply' ? expected.reply : null,
      unknownId: expected.type === 'answer' ? expected.unknownId : null,
      value: expected.type === 'answer' ? expected.value : null,
    };
    const output: UtteranceOutput = {
      kind: expected.type === 'question' ? 'question' : 'change',
      actions: expected.type === 'question' ? [] : [action],
      refs: {
        taskKeys: [],
        requestIds: [],
        itemIds: expected.type === 'question' ? [expected.itemId] : [],
      },
      unsupported: null,
    };
    return {
      output,
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

export interface BelongingsObservation {
  caseId: string;
  context?: UtteranceContext;
  output?: UtteranceOutput;
  reply?: ShownReply;
  model?: string;
  promptVersion?: string;
  inputHash?: string;
  usage?: { input_tokens: number; output_tokens: number };
  result: 'observed' | 'incomplete';
  reason?: string;
  targetMatches?: boolean;
  previewNoWrite?: boolean;
  confirmation?: string;
  stateAfter?: 'matches' | 'mismatch' | 'not_checked';
  /** 画面の見え方は、この実行器では採点しない。 */
  screen: 'not_run';
}

/** 見せる前と確認後の状態も、それぞれ別に記録する。 */
export async function runBelongingsCase(
  test: BelongingsCase,
  read: UtteranceReader,
): Promise<BelongingsObservation> {
  const sessions = demoSessions();
  const sid = sessions.create(test.stage);
  if (test.setup === 'bought') {
    const view = await sessions.view(sid, 'b');
    const requirement = view?.plan.requirements.find(
      (entry) => entry.atHomeUnknownId === 'u-atHome:n1:i5',
    );
    // 買った事実と、その前の「無い」という答えが両方ある場面でなければ、買った後の訂正は測れない。
    if (!requirement?.bought || requirement.atHome !== 'no')
      return { caseId: test.id, result: 'incomplete', reason: 'fixture_bought', screen: 'not_run' };
  }
  if (test.setup === 'yes-first') {
    const view = await sessions.view(sid, 'b');
    if (!view)
      return { caseId: test.id, result: 'incomplete', reason: 'fixture_view', screen: 'not_run' };
    const setup = await sessions.command(sid, 'b', 'setup-yes', {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: view.plan.throughSeq },
    });
    if (setup?.result.status !== 'ok')
      return { caseId: test.id, result: 'incomplete', reason: 'fixture_setup', screen: 'not_run' };
  }
  if (test.setup === 'handkerchief' || test.setup === 'second-shirt') {
    const handkerchief = test.setup === 'handkerchief';
    const text = handkerchief
      ? '12月5日(土)は、ハンカチを持ってきてください。'
      : '12月14日は白い長袖シャツを持ってきてください。';
    const what = handkerchief ? 'ハンカチ' : '白い長袖シャツ';
    const date = handkerchief ? '2026-12-05' : '2026-12-14';
    const setup = await sessions.notice(
      sid,
      'b',
      { text, sender: 'school', operationId: 'fixture-notice' },
      fixtureNotice(text, what, date, handkerchief ? 'sat' : 'none'),
    );
    if (setup?.status !== 'ok')
      return { caseId: test.id, result: 'incomplete', reason: 'fixture_notice', screen: 'not_run' };
  }

  const before = await sessions.view(sid, 'b');
  const expected = test.expected;
  let context: UtteranceContext | undefined;
  let reading: Awaited<ReturnType<UtteranceReader>> | undefined;
  const heard = await sessions.utterance(
    sid,
    'b',
    { text: test.text, operationId: `say-${test.id}` },
    async (input) => {
      context = input;
      // 新しい値が本当に製品の計画から入ったかを確かめてから、読み取りを呼ぶ。
      if (!input.unknowns.some((u) => u.id === 'u-atHome:n1:i5')) throw new Error('前提に値がない');
      if (expected.type === 'answer' && !input.unknowns.some((u) => u.id === expected.unknownId))
        throw new Error('対象がない');
      reading = await read(input);
      return reading;
    },
  );
  if (heard?.status !== 'ok' || !context || !reading) {
    return {
      caseId: test.id,
      result: 'incomplete',
      reason: heard?.status === 'failed' ? heard.reason : (heard?.status ?? 'session_gone'),
      screen: 'not_run',
    };
  }

  const reply = heard.reply;
  const proposal =
    reply.kind === 'change' && reply.proposals.length === 1 ? reply.proposals[0] : undefined;
  const targetMatches =
    expected.type === 'question'
      ? reply.kind === 'question' && reply.refs.itemIds.includes(expected.itemId)
      : expected.type === 'recordReply'
        ? proposal?.command.type === 'recordReply' &&
          proposal.command.requestId === expected.requestId &&
          proposal.command.reply === expected.reply
        : proposal?.command.type === 'answer' &&
          proposal.command.unknownId === expected.unknownId &&
          proposal.command.value === expected.value &&
          proposal.command.seen?.what === expected.what;
  let confirmation = 'not_applicable';
  let stateAfter: BelongingsObservation['stateAfter'] = 'not_checked';
  if (targetMatches && proposal) {
    const done = await sessions.confirm(sid, 'b', proposal.id, `confirm-${test.id}`);
    confirmation = done?.status ?? 'session_gone';
    if (done?.status === 'ok') {
      if (expected.type === 'answer') {
        const target = done.view.plan.arrangements.find(
          (a) => a.atHomeUnknownId === expected.unknownId,
        );
        const answer = done.view.plan.requirements.find(
          (requirement) => requirement.atHomeUnknownId === expected.unknownId,
        )?.atHome;
        const question = done.view.plan.questions.some((q) => q.unknownId === expected.unknownId);
        const right =
          answer === expected.value &&
          done.view.plan.throughSeq > heard.view.plan.throughSeq &&
          (expected.value === 'yes' ? !target : Boolean(target && !question));
        const shown =
          test.setup !== 'handkerchief' ||
          done.view.today.main.some(
            (c) => c.kind === 'stuck' && c.arrangement.atHomeUnknownId === expected.unknownId,
          );
        stateAfter = right && shown ? 'matches' : 'mismatch';
      } else if (expected.type === 'recordReply') {
        stateAfter = done.view.plan.requests.some(
          (r) => r.requestId === expected.requestId && r.state === 'confirmed',
        )
          ? 'matches'
          : 'mismatch';
      }
    }
  }
  return {
    caseId: test.id,
    context,
    output: reading.output,
    reply,
    model: reading.model,
    promptVersion: reading.promptVersion,
    inputHash: reading.inputHash,
    usage: reading.usage,
    result: 'observed',
    targetMatches: Boolean(targetMatches),
    previewNoWrite: before?.plan.throughSeq === heard.view.plan.throughSeq,
    confirmation,
    stateAfter,
    screen: 'not_run',
  };
}
