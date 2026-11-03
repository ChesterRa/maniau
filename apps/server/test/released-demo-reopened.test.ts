// デモの通知入力が、不要となった引き受けを戻す場合（偽の読み取り、外部 API なし）。
import { type ExtractionOutput, proposalSnapshot } from '@maniau/core';
import { keys } from '@maniau/core/engine';
import { expect, it } from 'vitest';
import { demoSessions, type NoticeReader } from '../src/demo-sessions';

it('新しいお知らせの作用で不要から戻る時は、承諾を引き継がず本人へ再提案する', async () => {
  const sessions = demoSessions();
  const sid = sessions.create('arrived');
  const care = 'arr:childCare:n1:i6:c';
  const school = keys.option(care, 'opt-gakudo');
  let op = 0;
  const command = async (member: string, body: Parameters<typeof sessions.command>[3]) =>
    sessions.command(sid, member, `demo-back-${++op}`, body);
  expect(
    (await command('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }))?.result
      .status,
  ).toBe('ok');
  expect(
    (
      await command('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: school,
        role: 'primary',
        assigneeId: 'a',
      })
    )?.result.status,
  ).toBe('ok');
  let view = await sessions.view(sid, 'a');
  const task = view?.plan.tasks.find(
    (t) => t.basis.optionKey === school && t.step?.stepId === 'write',
  );
  if (!task) throw new Error('作業が無い');
  const shown = proposalSnapshot(task);
  if (!shown) throw new Error('控えが無い');
  expect((await command('a', { type: 'accept', taskKey: task.key, shown }))?.result.status).toBe(
    'ok',
  );
  expect(
    (await command('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-08' }))?.result
      .status,
  ).toBe('ok');
  view = await sessions.view(sid, 'a');
  expect(view?.plan.released?.some((r) => r.taskKey === task.key)).toBe(true);
  const text = '発表会は12月5日に行います。';
  let calls = 0;
  const fake: NoticeReader = async (request) => {
    calls += 1;
    const sentenceId = request.source.sentences[0]?.id;
    if (!sentenceId) throw new Error('文が無い');
    const output: ExtractionOutput = {
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
      items: [
        {
          id: 'i',
          sentenceIds: [sentenceId],
          kind: 'event',
          written: text,
          date: '2026-12-05',
          writtenWeekday: 'sat',
          startTime: null,
          endTime: null,
          what: '発表会',
          dayType: null,
          deadline: null,
          audience: null,
          place: null,
          relativeDay: 'none',
          conditionNodeId: null,
          inferred: false,
          familyAction: false,
          effects: [
            { type: 'resolveUnknown', unknownId: 'n1:u1', value: '2026-12-05', itemId: null },
          ],
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
  const read = await sessions.notice(
    sid,
    'b',
    { text, sender: 'school', operationId: 'new-notice' },
    fake,
  );
  expect(read?.status).toBe('ok');
  expect(calls).toBe(1);
  view = await sessions.view(sid, 'a');
  expect(view?.plan.tasks.find((t) => t.key === task.key)?.commitment).toBe('proposed');
  expect(
    view?.today.main.some((card) => card.kind === 'proposal' && card.task.key === task.key),
  ).toBe(true);
});
