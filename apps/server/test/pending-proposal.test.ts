// もう一人の大人がまだ引き受けていない作業（きょうの静かな札、pending）：提案を受けた人には「おねがい」、もう一人
// には同じ作業を静かに見せる。引き受けたら相手の作業になり、断ったら「だれがやるか」の札になって、ここから消える。
// 作業が二つあれば二つ。だれが頼んだかは言わない。架空のデモの家（彩が健太に、学童の予備を頼む）。
import { type Command, proposalSnapshot } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { demoSessions } from '../src/demo-sessions';

const care = 'arr:childCare:n1:i6:c';
const gakudo = `opt:${care}:opt-gakudo`;

describe('まだ引き受けていない作業', () => {
  it('頼んだ作業を、もう一人には静かに見せ、引き受け・断りで消える', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    let op = 0;
    const send = async (memberId: string, command: Command) => {
      const done = await sessions.command(id, memberId, `op-${++op}`, command);
      if (!done) throw new Error('デモの家が無い');
      return done;
    };
    const pendingOf = (view: Awaited<ReturnType<typeof send>>['view']) =>
      view.today.quiet.flatMap((c) => (c.kind === 'pending' ? [c.task] : []));

    const asked = await send('b', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: gakudo,
      role: 'backup',
      assigneeId: 'a',
    });
    expect(asked.result.status).toBe('ok');
    const two = pendingOf(asked.view);
    expect(two.map((t) => t.key.split(':').pop()).sort()).toEqual(['submit', 'write']);
    expect(two.every((t) => t.assigneeId === 'a' && t.commitment === 'proposed')).toBe(true);
    // 頼まれた健太には、同じ作業が「おねがい」として出て、静かな札には出ない。
    const kenta = (await sessions.view(id, 'a')) as Awaited<ReturnType<typeof send>>['view'];
    expect(kenta.today.main.filter((c) => c.kind === 'proposal')).toHaveLength(2);
    expect(pendingOf(kenta)).toEqual([]);

    const write = two.find((t) => t.key.endsWith(':write'));
    const submit = two.find((t) => t.key.endsWith(':submit'));
    const shown = write && proposalSnapshot(write);
    if (!write || !submit || !shown) throw new Error('学童の作業が無い');
    const accepted = await send('a', { type: 'accept', taskKey: write.key, shown });
    expect(accepted.result.status).toBe('ok');
    const afterAccept = pendingOf(
      (await sessions.view(id, 'b')) as Awaited<ReturnType<typeof send>>['view'],
    );
    expect(afterAccept.map((t) => t.key)).toEqual([submit.key]);

    const declined = await send('a', {
      type: 'commitment',
      taskKey: submit.key,
      action: 'decline',
    });
    expect(declined.result.status).toBe('ok');
    const aya = (await sessions.view(id, 'b')) as Awaited<ReturnType<typeof send>>['view'];
    expect(pendingOf(aya)).toEqual([]);
    expect(aya.today.main.some((c) => c.kind === 'unowned' && c.task.key === submit.key)).toBe(
      true,
    );
  });
});
