// 不要と事業者が受け付けた知らせの後、作業が戻れば、本人の引き受けを再確認する。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

const shown = {
  titleKey: 'task.work',
  titleParams: {},
  start: '2026-12-07T10:00+09:00',
  end: '2026-12-07T10:30+09:00',
  travelBeforeMin: 0,
  travelAfterMin: 0,
};
const accepted = (seq: number) =>
  event(seq, {
    type: 'commitmentChanged',
    taskKey: 'work',
    assigneeId: 'a',
    action: 'accept',
    shown,
    basisSourceIds: ['n1'],
  });
const notified = (seq: number, key = 'released:work:a#1', recipient = 'a') =>
  event(seq, {
    type: 'notified',
    notificationKey: key,
    toMemberId: recipient,
    actorId: 'system',
    channel: 'webPush',
    result: 'accepted',
    kind: 'assignment',
    content: { titleKey: 'notify.released', params: {} },
    appVersion: 'fixture',
  });
const history = () => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 'work', assigneeId: 'a' }),
  accepted(3),
  notified(4),
];
const current = (throughSeq: number, reconfirm: boolean) =>
  plan({
    throughSeq,
    tasks: [
      task('work', {
        titleKey: 'task.work',
        titleParams: {},
        commitment: 'accepted',
        start: shown.start,
        end: shown.end,
        reconfirm,
      }),
    ],
  });
const codes = (events: unknown[], reconfirm: boolean) =>
  verifyPlan({ household: household(), plan: current(events.length, reconfirm), events })
    .issues.filter((issue) => issue.kind === 'violation')
    .map((issue) => issue.code);

describe('知らせた後に戻った引き受け', () => {
  it('不要と知らせた後、再確認のない引き受けを拒み、確認中を受け入れる', () => {
    expect(codes(history(), false)).toContain('released_reconfirm_missing');
    expect(codes(history(), true)).not.toContain('released_reconfirm_missing');
  });
  it('本人の新たな accept の後は元の確認を持ち越さない', () => {
    expect(codes([...history(), accepted(5)], false)).not.toContain('released_reconfirm_missing');
  });
  it('要るか未確認の知らせ、別の作業・別の人への知らせを混ぜない', () => {
    for (const notice of [
      notified(4, 'releasedCheck:work:a#1'),
      notified(4, 'released:other:a#1'),
      notified(4, 'released:work:b#1', 'b'),
    ]) {
      expect(codes([...history().slice(0, 3), notice], false)).not.toContain(
        'released_reconfirm_missing',
      );
    }
  });
});
