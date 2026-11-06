// 日が直された後の一言の「頼んだ」（架空のデモ・偽の読み取り。API は呼ばない）。前の日の分を送った作業は、今の日の
// 分を頼み直す作業に戻るので、一言の前提でも「まだ送っていない」とし、候補は新しい日の分を頼む時間を持つ。デモの
// 家庭にはほかにも作業があるので、一言では記録せず（取り違えないため）、同じ命令を札で記録する。
import type { PreviewCommand } from '@maniau/core';
import { keys } from '@maniau/core/engine';
import { expect, it } from 'vitest';
import { demoSessions, type UtteranceReader } from '../src/demo-sessions';

const care = 'arr:childCare:n1:i6:c';
const ask = keys.task(keys.option(care, 'opt-grandma'), 'ask');

it('日を直した後の一言の「頼んだ」は、新しい日の分の候補になり、札で記録できる', async () => {
  const sessions = demoSessions();
  const id = sessions.create('chase');
  const correction: PreviewCommand = {
    type: 'correctItem',
    itemId: 'n1:i6',
    interpretation: { date: '2026-12-14', writtenWeekday: 1 },
  };
  const shown = await sessions.changePreview(id, 'a', correction);
  if (!shown || 'status' in shown) throw new Error('直す内容を見られない');
  expect(
    (
      await sessions.command(id, 'a', 'date', {
        ...correction,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      })
    )?.result.status,
  ).toBe('ok');
  let shownSent: boolean | undefined;
  const reader: UtteranceReader = async (input) => {
    shownSent = input.tasks.find((t) => t.key === ask)?.sent;
    return {
      output: {
        kind: 'change',
        actions: [
          {
            type: 'recordSent',
            taskKey: ask,
            requestId: null,
            reply: null,
            unknownId: null,
            value: null,
          },
        ],
        refs: { taskKeys: [ask], requestIds: [], itemIds: [] },
        unsupported: null,
      },
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  const heard = await sessions.utterance(
    id,
    'b',
    { text: 'おばあちゃんに14日もお願いした', operationId: 'hear' },
    reader,
  );
  expect(shownSent).toBe(false);
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補がない');
  const proposal = heard.reply.proposals[0];
  if (proposal?.command.type !== 'recordSent') throw new Error('候補がない');
  expect(proposal.command).toMatchObject({ taskKey: ask });
  expect(proposal.command.window?.start.startsWith('2026-12-14')).toBe(true);
  // ほかにも作業があるので、一言では記録しない（押しても記録しない）。
  expect(proposal.blocked).toBe('otherTasks');
  expect((await sessions.confirm(id, 'b', proposal.id, 'confirm'))?.status).toBe('changed');
  // 札で、同じ命令を記録する。
  const card = await sessions.command(id, 'b', 'sent-card', proposal.command);
  expect(card?.result.status).toBe('ok');
  const view = await sessions.view(id, 'b');
  const sent = view?.plan.requests.filter((r) => r.taskKey === ask && r.state === 'awaitingReply');
  expect(sent?.some((r) => r.window?.start.startsWith('2026-12-14'))).toBe(true);
});
