// 日が直された後、一言で「頼んだ」と伝えても記録できる（架空のデモ・偽の読み取り。API は呼ばない）。前の日の分を
// 送った作業は、今の日の分を頼み直す作業に戻るので、一言の前提でも「まだ送っていない」とする。
import { keys } from '@maniau/core/engine';
import { expect, it } from 'vitest';
import { demoSessions, type UtteranceReader } from '../src/demo-sessions';

const care = 'arr:childCare:n1:i6:c';
const ask = keys.task(keys.option(care, 'opt-grandma'), 'ask');

it('日を直した後、一言で新しい日の分を頼んだと記録できる', async () => {
  const sessions = demoSessions();
  const id = sessions.create('chase');
  expect(
    (
      await sessions.command(id, 'a', 'date', {
        type: 'correctItem',
        itemId: 'n1:i6',
        interpretation: { date: '2026-12-14', writtenWeekday: 1 },
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
  if (!proposal) throw new Error('候補がない');
  expect((await sessions.confirm(id, 'b', proposal.id, 'confirm'))?.status).toBe('ok');
  const view = await sessions.view(id, 'b');
  const sent = view?.plan.requests.filter((r) => r.taskKey === ask && r.state === 'awaitingReply');
  expect(sent?.some((r) => r.window?.start.startsWith('2026-12-14'))).toBe(true);
});
