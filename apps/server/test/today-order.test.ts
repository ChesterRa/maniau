// 「きょう」の札の順：担当の決まっていない作業と、引き受けを待つ作業は、要る時の早い順に出す。返事を待つ間に
// 学童へ選び直すと、健太には明日の申込書の作業と、学童の日（12/7）の弁当の準備（だれがやるか）が一度に出る。
// 初めに見せる札は三つまでなので、遠い日の準備で明日の作業を下に押しやらない。
import { expect, it } from 'vitest';
import { demoSessions } from '../src/demo-sessions';

const ARR = 'arr:childCare:n1:i6:c';

it('選び直した後、明日の作業を、遠い日の当日の準備より先に出す（準備の札も出す）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('chase');
  const previews = await sessions.preview(id, 'b', ARR);
  const gakudo = previews?.find((p) => p.optionKey.endsWith('opt-gakudo'));
  if (!gakudo?.seen) throw new Error('学童の「選んだら」が無い');
  const done = await sessions.command(id, 'b', 'order-1', {
    type: 'chooseOption',
    arrangementKey: ARR,
    optionKey: gakudo.optionKey,
    role: 'primary',
    assigneeId: gakudo.assigneeId ?? 'a',
    seen: gakudo.seen,
  });
  expect(done?.result.status).toBe('ok');
  const view = await sessions.view(id, 'a');
  if (!view) throw new Error('見せる物が無い');
  const order = view.today.main.map((card) =>
    'task' in card ? `${card.kind}:${card.task.key.split(':').at(-1)}` : card.kind,
  );
  expect(order).toEqual([
    'proposal:write',
    'proposal:submit',
    'unowned:bento-shop',
    'unowned:bento-make',
  ]);
});
