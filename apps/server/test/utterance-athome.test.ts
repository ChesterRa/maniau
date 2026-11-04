// 家族の一言や札で「家にあるか」に答える：前提に買い物の手配の値を載せ、候補の命令には見せた品物を付ける。
// 押すまでに品物が直されていれば、古い候補では記録しない。見せた後に答えが入っていれば（同じ答えの言い直し
// でも）、古い候補で上書きしない。読み取りは偽物で、Claude の API は呼ばない。
import type { UtteranceContext } from '@maniau/core';
import { expect, it } from 'vitest';
import { demoSessions, type UtteranceReader } from '../src/demo-sessions';

const UNKNOWN = 'u-atHome:n1:i5';
const SHIRT = 'arr:purchase:n1:i5';

/** 今開いた画面（または一言の前提）が見ている事象の位置。 */
const shownAt = async (sessions: ReturnType<typeof demoSessions>, id: string) =>
  (await sessions.view(id, 'b'))?.plan.throughSeq ?? 0;

const reader =
  (calls: UtteranceContext[], value: 'yes' | 'no'): UtteranceReader =>
  async (context) => {
    calls.push(context);
    return {
      output: {
        kind: 'change',
        actions: [
          {
            type: 'answer',
            taskKey: null,
            requestId: null,
            reply: null,
            unknownId: UNKNOWN,
            value,
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
const answerNo = (calls: UtteranceContext[]) => reader(calls, 'no');

async function heard() {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const calls: UtteranceContext[] = [];
  const done = await sessions.utterance(
    id,
    'b',
    { text: 'シャツは家にないよ', operationId: 'say-1' },
    answerNo(calls),
  );
  if (done?.status !== 'ok' || done.reply.kind !== 'change') throw new Error('候補が無い');
  const [proposal] = done.reply.proposals;
  if (!proposal) throw new Error('候補が無い');
  return { sessions, id, calls, proposal };
}

it('「シャツは家にない」と言えば、家にあるかの値に答える候補を出す（ほかにも答えられる値があれば、押しても記録しない）', async () => {
  const { sessions, id, calls, proposal } = await heard();
  expect(calls[0]?.unknowns).toContainEqual({
    id: UNKNOWN,
    label: '白い長袖シャツが家にあるか（2026-12-05までに要る）',
    values: ['yes', 'no'],
    answer: null,
  });
  // 一言は事象を足さないので、今の位置が、前提が見ていた位置。
  expect(proposal.command).toEqual({
    type: 'answer',
    unknownId: UNKNOWN,
    value: 'no',
    seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
  });
  // このデモには、発表会の日（読み取りの未定の値）も答えられる値としてあるので、一言からは記録しない（札で
  // 答える）。家にあるかとほかの値の名前は文なので、見分けの証拠にしない。
  expect(calls[0]?.unknowns.length).toBeGreaterThan(1);
  expect(proposal.blocked).toBe('otherUnknowns');
  const confirmed = await sessions.confirm(id, 'b', proposal.id, 'c-1');
  expect(confirmed?.status).toBe('changed');
  if (confirmed?.status !== 'changed') return;
  expect(confirmed.view.plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
  expect(confirmed.view.plan.arrangements.find((a) => a.key === SHIRT)?.status).toBe('askFirst');
});

it('押すまでに品物が直されていたら、古い候補では答えない', async () => {
  const { sessions, id, proposal } = await heard();
  const corrected = await sessions.command(id, 'a', 'cmd-1', {
    type: 'correctItem',
    itemId: 'n1:i5',
    interpretation: { what: '赤い帽子' },
  });
  expect(corrected?.result.status).toBe('ok');
  const stale = await sessions.confirm(id, 'b', proposal.id, 'c-2');
  expect(stale?.status).toBe('changed');
  if (stale?.status !== 'changed') return;
  expect(stale.view.plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
});

it('あると答えて問いが消えた後も、要る時までは「やっぱり無かった」を候補にできる（札からは答え直せる）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const yes = await sessions.command(id, 'b', 'cmd-yes', {
    type: 'answer',
    unknownId: UNKNOWN,
    value: 'yes',
    seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
  });
  expect(yes?.result.status).toBe('ok');
  expect(yes?.view.plan.arrangements.some((a) => a.key === SHIRT)).toBe(false);
  // 一言の前提には、今の答え（ある）と一緒に残す。
  const calls: UtteranceContext[] = [];
  const heard = await sessions.utterance(
    id,
    'b',
    { text: 'やっぱりシャツ家になかった', operationId: 'say-2' },
    answerNo(calls),
  );
  expect(calls[0]?.unknowns).toContainEqual({
    id: UNKNOWN,
    label: '白い長袖シャツが家にあるか（2026-12-05までに要る）',
    values: ['yes', 'no'],
    answer: 'yes',
  });
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補が無い');
  const [proposal] = heard.reply.proposals;
  if (!proposal) throw new Error('候補が無い');
  // ほかにも答えられる値があるので、一言の候補は記録しない。札（同じ命令）からなら答え直せる。
  expect(proposal.blocked).toBe('otherUnknowns');
  expect((await sessions.confirm(id, 'b', proposal.id, 'c-3'))?.status).toBe('changed');
  const again = await sessions.command(id, 'b', 'cmd-no', {
    type: 'answer',
    unknownId: UNKNOWN,
    value: 'no',
    seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
  });
  expect(again?.result.status).toBe('ok');
  // 買い物の手配が戻る（買える時があれば、買う作業を出す）。
  expect(again?.view.plan.arrangements.find((a) => a.key === SHIRT)?.status).toBe('decidable');
  // 要る時を過ぎたら、もう答えを受けない。
  const late = await sessions.command(id, 'b', 'clock', {
    type: 'advanceClock',
    to: '2026-12-05T08:30+09:00',
  });
  expect(late?.result.status).toBe('ok');
  const after = await sessions.command(id, 'b', 'cmd-late', {
    type: 'answer',
    unknownId: UNKNOWN,
    value: 'yes',
    seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
  });
  expect(after?.result).toMatchObject({ status: 'conflict', reason: 'unknownGone' });
});

it('候補を見せた後に、もう一人が同じ答えを言い直していたら、古い候補では上書きしない', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const answer = async (operationId: string, memberId: string, value: 'yes' | 'no') =>
    sessions.command(id, memberId, operationId, {
      type: 'answer',
      unknownId: UNKNOWN,
      value,
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
    });
  expect((await answer('a-1', 'a', 'no'))?.result.status).toBe('ok');
  const heard = await sessions.utterance(
    id,
    'b',
    { text: 'シャツ見つかったよ', operationId: 'say-4' },
    reader([], 'yes'),
  );
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補が無い');
  const [proposal] = heard.reply.proposals;
  if (!proposal) throw new Error('候補が無い');
  // 見せた後に、もう一人が「無い」と答え直した（値は前と同じ）。
  expect((await answer('a-2', 'a', 'no'))?.result.status).toBe('ok');
  const stale = await sessions.confirm(id, 'b', proposal.id, 'c-4');
  expect(stale?.status).toBe('changed');
  if (stale?.status !== 'changed') return;
  expect(stale.view.plan.arrangements.some((a) => a.key === SHIRT)).toBe(true);
});

it('古い札の答えは、見せた後にもう一人が答えていたら受けない（新しい前提からなら答え直せる）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const answer = (memberId: string, operationId: string, value: 'yes' | 'no', throughSeq: number) =>
    sessions.command(id, memberId, operationId, {
      type: 'answer',
      unknownId: UNKNOWN,
      value,
      seen: { what: '白い長袖シャツ', throughSeq },
    });
  // b の画面は、まだ「白い長袖シャツはありますか？」。その後に a が「ある」と答えた。
  const oldPage = await shownAt(sessions, id);
  expect((await answer('a', 'a-yes', 'yes', oldPage))?.result.status).toBe('ok');
  const stale = await answer('b', 'b-old', 'no', oldPage);
  expect(stale?.result).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
  expect(stale?.view.plan.arrangements.some((a) => a.key === SHIRT)).toBe(false);
  // 今の前提から（一言の「やっぱり無かった」）なら、答え直せる。
  const fresh = await answer('b', 'b-new', 'no', await shownAt(sessions, id));
  expect(fresh?.result.status).toBe('ok');
  expect(fresh?.view.plan.arrangements.some((a) => a.key === SHIRT)).toBe(true);
});

it('読む間に、もう一人が同じ答えを言い直していたら、候補を見せない', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const answerNo = async (operationId: string) =>
    sessions.command(id, 'a', operationId, {
      type: 'answer',
      unknownId: UNKNOWN,
      value: 'no',
      seen: { what: '白い長袖シャツ', throughSeq: await shownAt(sessions, id) },
    });
  expect((await answerNo('a-1'))?.result.status).toBe('ok');
  const yes = reader([], 'yes');
  const heard = await sessions.utterance(
    id,
    'b',
    { text: 'シャツ見つかったよ', operationId: 'say-5' },
    async (context) => {
      // モデルが読んでいる間に、a が「無い」と答え直した（値は前と同じ）。
      expect((await answerNo('a-2'))?.result.status).toBe('ok');
      return yes(context);
    },
  );
  expect(heard?.status).toBe('stale');
});
