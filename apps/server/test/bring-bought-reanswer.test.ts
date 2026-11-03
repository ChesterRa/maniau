// 買った後に、一言で家にあるかを言い直す（架空のデモ・偽の読み取り。API は呼ばない）。買ったことは家にある
// ことを示さない（買って帰る前かもしれない）ので、一言の前提の今の答えは空にする。「見つからない」も「家に
// あった」も候補になり、押すと記録して、二人の札に出る。
import { expect, it } from 'vitest';
import { demoSessions, type UtteranceReader } from '../src/demo-sessions';

const unknownId = 'u-atHome:n1:i5';
const buyKey = 'task:opt:arr:purchase:n1:i5:buy:buy';

/** 無いと答えた白い長袖シャツ（使う日 12/5）を買い、使う日の朝に一言で言い直す。二人の札を返す。 */
async function boughtThenSay(value: 'yes' | 'no', text: string) {
  const sessions = demoSessions();
  const id = sessions.create('asked');
  const ok = async (memberId: string, operationId: string, command: object) =>
    expect(
      (await sessions.command(id, memberId, operationId, command as never))?.result.status,
    ).toBe('ok');
  await ok('b', 'date', {
    type: 'correctItem',
    itemId: 'n1:i5',
    interpretation: { date: '2026-12-05' },
  });
  await ok('a', 'buy', {
    type: 'commitment',
    taskKey: buyKey,
    action: 'done',
    seen: { titleKey: 'task.buy', titleParams: { what: '白い長袖シャツ' } },
  });
  await ok('b', 'clock', { type: 'advanceClock', to: '2026-12-05T09:00+09:00' });
  const cards = async () =>
    Promise.all(
      ['a', 'b'].map(async (member) => {
        const view = await sessions.view(id, member);
        const card = view?.today.quiet.find(
          (c) => c.kind === 'bring' && c.requirement.atHomeUnknownId === unknownId,
        );
        return card?.kind === 'bring'
          ? [card.bought, card.reanswer, card.requirement.atHome]
          : null;
      }),
    );
  // 言い直す前は、買った物として出す。
  expect(await cards()).toEqual([
    [true, true, 'no'],
    [true, true, 'no'],
  ]);

  let shownAnswer: string | null | undefined;
  const reader: UtteranceReader = async (input) => {
    shownAnswer = input.unknowns.find((u) => u.id === unknownId)?.answer;
    return {
      output: {
        kind: 'change',
        actions: [
          { type: 'answer', taskKey: null, requestId: null, reply: null, unknownId, value },
        ],
        refs: { taskKeys: [], requestIds: [], itemIds: [] },
        unsupported: null,
      },
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  const heard = await sessions.utterance(id, 'b', { text, operationId: `hear-${value}` }, reader);
  expect(shownAnswer).toBeNull();
  expect(heard).toMatchObject({ status: 'ok', reply: { kind: 'change' } });
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補がない');
  const proposal = heard.reply.proposals[0];
  if (!proposal) throw new Error('候補がない');
  expect((await sessions.confirm(id, 'b', proposal.id, `confirm-${value}`))?.status).toBe('ok');
  return cards();
}

it('無いと答えて買った物を後で見失ったら、一言でもう一度無いと記録できる', async () => {
  expect(await boughtThenSay('no', 'シャツが見つからない')).toEqual([
    [false, true, 'no'],
    [false, true, 'no'],
  ]);
});

it('買った物が家にあったと言えば、家にあると記録できる（買っただけでは家にあるとしない）', async () => {
  expect(await boughtThenSay('yes', '白い長袖シャツは家にありました')).toEqual([
    [false, true, 'yes'],
    [false, true, 'yes'],
  ]);
});
