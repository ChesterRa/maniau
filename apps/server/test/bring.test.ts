// 持って行く物（デモの家庭で通しに）：使う日（12/5）の書かれた持ち物を、家にあると答えると、使う日の前の日から
// 二人の「きょう」に出る。用意の締切（使う日の朝 8:00）の前に「やっぱり無かった」と答え直すと、持って行く物から
// 外れ、買う手配が出る。締切の後に答え直すと、買う手配は作らず、無いことを二人に出し、「用意できた」に戻せる。
// 使う日が過ぎたら答えを受けない。読み取りは偽物（API を呼ばない）。
import { ExtractionOutput } from '@maniau/core';
import { expect, it } from 'vitest';
import { demoSessions, type NoticeReader } from '../src/demo-sessions';

const TEXT = '12月5日(土)は、白い靴下を持ってきてください。';
const socksReader: NoticeReader = async (request) => {
  const sentenceId = request.source.sentences[0]?.id;
  if (!sentenceId) throw new Error('架空のお知らせに文がない');
  return {
    output: ExtractionOutput.parse({
      items: [
        {
          id: 'i1',
          sentenceIds: [sentenceId],
          kind: 'belongings',
          written: TEXT,
          date: '2026-12-05',
          writtenWeekday: 'sat',
          startTime: null,
          endTime: null,
          what: '白い靴下',
          dayType: null,
          deadline: null,
          audience: null,
          place: null,
          relativeDay: 'none',
          conditionNodeId: null,
          inferred: false,
          familyAction: false,
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

type Sessions = ReturnType<typeof demoSessions>;
const bringOf = (view: Awaited<ReturnType<Sessions['view']>>) =>
  view?.today.quiet.filter((c) => c.kind === 'bring') ?? [];

/** 架空の家庭に靴下のお知らせを入れ、家にあると答える。 */
async function socksAtHome(sessions: Sessions) {
  const id = sessions.create('arrived');
  const read = await sessions.notice(
    id,
    'b',
    { text: TEXT, sender: 'school', operationId: 'socks' },
    socksReader,
  );
  expect(read?.status).toBe('ok');
  const sourceId = read?.status === 'ok' ? read.sourceId : '';
  const unknownId = `u-atHome:${sourceId}:i1`;
  const first = await sessions.view(id, 'b');
  expect(first?.plan.questions.some((q) => q.unknownId === unknownId)).toBe(true);
  const yes = await sessions.command(id, 'b', 'answer-yes', {
    type: 'answer',
    unknownId,
    value: 'yes',
    seen: { what: '白い靴下', throughSeq: first?.plan.throughSeq ?? 0 },
  });
  expect(yes?.result.status).toBe('ok');
  expect(bringOf(yes?.view)).toEqual([]);
  return { id, unknownId };
}

const advance = async (sessions: Sessions, id: string, to: string) =>
  expect(
    (await sessions.command(id, 'b', `clock-${to}`, { type: 'advanceClock', to }))?.result.status,
  ).toBe('ok');

it('家にあると答えた物を前の日に二人に出し、「やっぱり無かった」で買う手配に戻す', async () => {
  const sessions = demoSessions();
  const { id, unknownId } = await socksAtHome(sessions);
  await advance(sessions, id, '2026-12-04T09:00+09:00');
  for (const member of ['a', 'b']) {
    expect(bringOf(await sessions.view(id, member))).toMatchObject([
      {
        kind: 'bring',
        bought: false,
        reanswer: true,
        requirement: { what: '白い靴下', date: '2026-12-05', atHome: 'yes' },
      },
    ]);
  }

  const seen = await sessions.view(id, 'a');
  const no = await sessions.command(id, 'a', 'answer-no', {
    type: 'answer',
    unknownId,
    value: 'no',
    seen: { what: '白い靴下', throughSeq: seen?.plan.throughSeq ?? 0 },
  });
  expect(no?.result.status).toBe('ok');
  expect(bringOf(no?.view)).toEqual([]);
  expect(no?.view.plan.arrangements.some((a) => a.atHomeUnknownId === unknownId)).toBe(true);
});

it('用意の締切の後に無いと分かれば、無いことを二人に出し、「用意できた」に戻せる。使う日が過ぎたら受けない', async () => {
  const sessions = demoSessions();
  const { id, unknownId } = await socksAtHome(sessions);
  await advance(sessions, id, '2026-12-05T09:00+09:00');
  const seen = await sessions.view(id, 'a');
  expect(bringOf(seen)).toMatchObject([{ kind: 'bring', reanswer: true }]);
  const no = await sessions.command(id, 'a', 'answer-late-no', {
    type: 'answer',
    unknownId,
    value: 'no',
    seen: { what: '白い靴下', throughSeq: seen?.plan.throughSeq ?? 0 },
  });
  expect(no?.result.status).toBe('ok');
  expect(no?.view.plan.arrangements.some((a) => a.atHomeUnknownId === unknownId)).toBe(false);
  for (const member of ['a', 'b']) {
    expect(bringOf(await sessions.view(id, member))).toMatchObject([
      { bought: false, reanswer: true, requirement: { atHome: 'no' } },
    ]);
  }

  const other = await sessions.view(id, 'b');
  const ready = await sessions.command(id, 'b', 'answer-ready', {
    type: 'answer',
    unknownId,
    value: 'yes',
    seen: { what: '白い靴下', throughSeq: other?.plan.throughSeq ?? 0 },
  });
  expect(ready?.result.status).toBe('ok');
  expect(bringOf(await sessions.view(id, 'a'))).toMatchObject([
    { reanswer: true, requirement: { atHome: 'yes' } },
  ]);

  await advance(sessions, id, '2026-12-06T00:00+09:00');
  const after = await sessions.view(id, 'a');
  expect(bringOf(after)).toEqual([]);
  const late = await sessions.command(id, 'a', 'answer-after-day', {
    type: 'answer',
    unknownId,
    value: 'no',
    seen: { what: '白い靴下', throughSeq: after?.plan.throughSeq ?? 0 },
  });
  expect(late?.result).toMatchObject({ status: 'conflict', reason: 'unknownGone' });
});
