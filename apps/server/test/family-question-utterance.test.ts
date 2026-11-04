// 家族が決める値（参加するか等）への、デモの「ひとこと」の答え：候補には見せた時の位置が付く。デモの家庭には
// ほかにも答えられる問いがあるので、一言では記録せず（取り違えないため）、同じ答えを札で記録する。札でも、見せた
// 後にもう一人の操作が入れば、記録せず見せ直す。お知らせの読み取りも一言の読み取りも偽物で、Claude の API は
// 呼ばない。
import type { ExtractionOutput, UtteranceContext, UtteranceOutput } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { demoSessions, type NoticeReader, type UtteranceReader } from '../src/demo-sessions';

const TEXT = '参加される方は、11月30日(月)17:00までに申込書を提出してください。';

/** 参加するか（家族の値）で申込書が要るお知らせの、決まった読み取り。 */
const noticeReader: NoticeReader = async (request) => {
  const sentenceId = request.source.sentences[0]?.id;
  if (!sentenceId) throw new Error('文が無い');
  const output: ExtractionOutput = {
    unknowns: [
      { id: 'u-join', label: '親子清掃に参加するか', values: ['yes', 'no'], kind: 'family' },
    ],
    conditions: [{ id: 'c-join', kind: 'eq', unknownId: 'u-join', value: 'yes', childIds: [] }],
    irrelevantSentenceIds: [],
    ambiguities: [],
    items: [
      {
        id: 's1',
        sentenceIds: [sentenceId],
        kind: 'submission',
        written: TEXT,
        date: null,
        writtenWeekday: 'none',
        startTime: null,
        endTime: null,
        what: '申込書',
        dayType: null,
        deadline: '2026-11-30T17:00+09:00',
        audience: null,
        place: null,
        relativeDay: 'none',
        conditionNodeId: 'c-join',
        inferred: false,
        familyAction: false,
        shape: 'none' as const,
        effects: [],
      },
    ],
  };
  return {
    output,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};

/** 一言を「参加する」の答えとして読む（前提の中の家族の値の ID を使う）。 */
const saysJoin =
  (calls: UtteranceContext[] = []): UtteranceReader =>
  async (context) => {
    calls.push(context);
    const unknown = context.unknowns.find((u) => u.label === '親子清掃に参加するか');
    const output: UtteranceOutput = {
      kind: 'change',
      actions: [
        {
          type: 'answer',
          taskKey: null,
          requestId: null,
          reply: null,
          unknownId: unknown?.id ?? null,
          value: 'yes',
        },
      ],
      refs: { taskKeys: [], requestIds: [], itemIds: [] },
      unsupported: null,
    };
    return {
      output,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };

async function proposed() {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const read = await sessions.notice(
    id,
    'b',
    { text: TEXT, sender: 'school', operationId: 'notice-join' },
    noticeReader,
  );
  if (read?.status !== 'ok') throw new Error(`お知らせを読めない：${read?.status}`);
  const before = await sessions.view(id, 'b');
  const question = before?.plan.questions.find((q) => q.family?.label === '親子清掃に参加するか');
  if (!question) throw new Error('問いが無い');
  const heard = await sessions.utterance(
    id,
    'b',
    { text: '親子清掃は参加します', operationId: 'say-join' },
    saysJoin(),
  );
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補が無い');
  const [proposal] = heard.reply.proposals;
  if (!proposal) throw new Error('候補が無い');
  return { sessions, id, question, proposal, throughSeq: before?.throughSeq };
}

describe('家族が決める値に「ひとこと」で答える', () => {
  it('候補に見せた時の位置が付き、ほかにも問いがあれば一言では記録せず、札の答えで問いが消える', async () => {
    const { sessions, id, question, proposal, throughSeq } = await proposed();
    expect(proposal.command).toEqual({
      type: 'answer',
      unknownId: question.unknownId,
      value: 'yes',
      seen: { throughSeq },
    });
    expect(proposal.blocked).toBe('otherUnknowns');
    expect((await sessions.confirm(id, 'b', proposal.id, 'confirm-join'))?.status).toBe('changed');
    const card = await sessions.command(id, 'b', 'card-join', proposal.command);
    expect(card?.result.status).toBe('ok');
    expect(card?.view.plan.questions.some((q) => q.unknownId === question.unknownId)).toBe(false);
  });

  it('押すまでにもう一人の操作が入れば、見せた位置の答えは札からも記録せず見せ直す', async () => {
    const { sessions, id, question, proposal } = await proposed();
    const other = await sessions.command(id, 'a', 'other-answer', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-05',
    });
    expect(other?.result.status).toBe('ok');
    const confirmed = await sessions.confirm(id, 'b', proposal.id, 'confirm-join');
    expect(confirmed?.status).toBe('changed');
    const stale = await sessions.command(id, 'b', 'card-join', proposal.command);
    expect(stale?.result).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    const view = await sessions.view(id, 'b');
    expect(view?.plan.questions.some((q) => q.unknownId === question.unknownId)).toBe(true);
  });
});
