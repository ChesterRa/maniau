// 引き受けた作業が、家族が別の案を選んだために進まなくなった時（計画には生きて残るが、もう進めない）。持った
// 本人に「もう要りません」を出し、選ぶ前の「選んだら」にも、要らなくなる引き受けを並べる。
import { describe, expect, it } from 'vitest';
import { choicePreview, proposalSnapshot, todayCards } from '../src';
import { computePlan } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const opt = (template: string) => `opt:${CARE}:${template}`;
const write = `task:${opt('opt-gakudo')}:write`;
const NOW = '2026-11-25T19:40+09:00';

/** 学童を本命に選び、申込書を書く作業を a が引き受けた所まで。 */
function gakudoAccepted() {
  const log = noticeArrived()
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-gakudo'),
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: write, assigneeId: 'a' });
  const task = computePlan(log.events, NOW).tasks.find((t) => t.key === write);
  const shown = task ? proposalSnapshot(task) : undefined;
  if (!shown) throw new Error('控えが無い');
  return log.add('commitmentChanged', '2026-11-25T19:37+09:00', 'a', {
    taskKey: write,
    assigneeId: 'a',
    action: 'accept',
    shown,
  });
}

describe('別の案を選んで進まなくなった引き受け', () => {
  it('祖母に選び直すと、a の申込書の作業は生きたまま進まなくなり、a に「もう要りません」を出す', () => {
    const before = computePlan(gakudoAccepted().events, NOW);
    expect(before.released).toBeUndefined();
    const after = computePlan(
      gakudoAccepted().add('optionChosen', '2026-11-25T19:38+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-grandma'),
        role: 'primary',
      }).events,
      NOW,
    );
    const task = after.tasks.find((t) => t.key === write);
    expect(task).toMatchObject({ live: true, commitment: 'accepted' });
    expect(after.released).toEqual([
      expect.objectContaining({ taskKey: write, assigneeId: 'a', reason: 'inactive' }),
    ]);
    expect(todayCards(after, 'a').main[0]).toMatchObject({ kind: 'released' });
    expect(todayCards(after, 'b').main.some((c) => c.kind === 'released')).toBe(false);
    // 選ぶ前の「選んだら」に、要らなくなる引き受けを並べる（見せた物の要約にも入る）。
    const preview = choicePreview(before, after, CARE, opt('opt-grandma'));
    expect(preview.released).toEqual([
      expect.objectContaining({ taskKey: write, assigneeId: 'a', reason: 'inactive' }),
    ]);
  });

  it('学童に戻せば、分かったと言う前なら元の引き受けのまま進む', () => {
    const back = gakudoAccepted()
      .add('optionChosen', '2026-11-25T19:38+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-grandma'),
        role: 'primary',
      })
      .add('optionChosen', '2026-11-25T19:39+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'primary',
      });
    const plan = computePlan(back.events, NOW);
    expect(plan.released).toBeUndefined();
    expect(plan.tasks.find((t) => t.key === write)?.commitment).toBe('accepted');
  });
});
