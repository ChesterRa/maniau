// 外へ送った控えの日を家庭の時区で照らす。訂正された送信は作業の履歴から除く。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
const window = (date: string) => ({ start: `${date}T08:10+09:00`, end: `${date}T18:15+09:00` });
const sent = (requestId: string, date?: string) => ({
  type: 'externalRequestSent',
  taskKey: 't',
  requestId,
  snapshot: { to: 'helper', kind: 'reply', basis, ...(date ? { window: window(date) } : {}) },
});
const check = (bodies: Record<string, unknown>[], date: string, commitment: string) => {
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
    ...bodies.map((body, index) => event(index + 3, body)),
  ];
  return verifyPlan({
    household: household(),
    events,
    plan: plan({
      throughSeq: events.length,
      arrangements: [arrangement({ ...window(date) })],
      tasks: [
        task('t', {
          titleKey: 'task.ask',
          titleParams: { date },
          basis,
          commitment,
          external: { to: 'helper', kind: 'reply' },
        }),
      ],
    }),
  });
};
const mismatch = (report: ReturnType<typeof check>) =>
  report.issues.filter(
    (issue) => issue.kind === 'violation' && issue.code === 'commitment_state_mismatch',
  );

describe('外へ送った日の控え', () => {
  it('前の日の送信を新しい日の済みにはせず、同じ日なら済みにする', () => {
    const events = [sent('r1', '2026-12-07')];
    expect(mismatch(check(events, '2026-12-14', 'accepted'))).toEqual([]);
    expect(mismatch(check(events, '2026-12-14', 'done'))).toHaveLength(1);
    expect(mismatch(check(events, '2026-12-07', 'done'))).toEqual([]);
  });
  it('新しい送信を誤記として直せば、前の送信の日に戻す', () => {
    const both = [sent('r1', '2026-12-07'), sent('r2', '2026-12-14')];
    expect(mismatch(check(both, '2026-12-14', 'done'))).toEqual([]);
    expect(mismatch(check(both, '2026-12-07', 'done'))).toHaveLength(1);
    const corrected = [...both, { type: 'requestRecordCorrected', requestId: 'r2' }];
    expect(mismatch(check(corrected, '2026-12-14', 'accepted'))).toEqual([]);
    expect(mismatch(check(corrected, '2026-12-14', 'done'))).toHaveLength(1);
    expect(mismatch(check(corrected, '2026-12-07', 'done'))).toEqual([]);
  });
  it('古い送信に日が無い時、済みを従来どおり扱い、日を未判定とする', () => {
    const report = check([sent('r1')], '2026-12-14', 'done');
    expect(mismatch(report)).toEqual([]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'request_window_unverified',
        subject: 't',
      }),
    );
  });
  it('今の日の依頼でも、取消しを伝えた後は済みのままにしない', () => {
    const events = [sent('r1', '2026-12-07'), { type: 'cancellationSent', requestId: 'r1' }];
    expect(mismatch(check(events, '2026-12-07', 'accepted'))).toEqual([]);
    expect(mismatch(check(events, '2026-12-07', 'done'))).toHaveLength(1);
  });
});

describe('返事待ちと今の日', () => {
  const currentDay = '2026-12-14';
  const checkWaiting = (sentDay?: string) => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, sent('r1', sentDay)),
    ];
    return verifyPlan({
      household: household(),
      events,
      plan: plan({
        throughSeq: 3,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            ...window(currentDay),
            status: 'decidable',
            chosenOptionKey: 'one',
            options: [option('one', { taskKeys: ['t'] })],
          }),
        ],
        tasks: [
          task('t', {
            basis,
            commitment: sentDay && sentDay !== currentDay ? 'accepted' : 'done',
            external: { to: 'helper', kind: 'reply' },
          }),
        ],
        requests: [
          {
            requestId: 'r1',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis,
            ...(sentDay ? { window: window(sentDay) } : {}),
            live: true,
          },
        ],
      }),
    });
  };
  const waitingIssues = (report: ReturnType<typeof checkWaiting>) =>
    report.issues.filter((issue) => issue.code === 'decidable_waiting_reply');

  it('前の日の返事待ちでは今の日の確定を止めない', () => {
    expect(waitingIssues(checkWaiting('2026-12-07'))).toEqual([]);
  });
  it('今の日の返事待ちを確定したと扱えば違反にする', () => {
    expect(waitingIssues(checkWaiting(currentDay))).toContainEqual(
      expect.objectContaining({ kind: 'violation' }),
    );
  });
  it('日が分からない古い控えは未判定とする', () => {
    expect(waitingIssues(checkWaiting())).toContainEqual(
      expect.objectContaining({ kind: 'undetermined' }),
    );
    expect(waitingIssues(checkWaiting())).not.toContainEqual(
      expect.objectContaining({ kind: 'violation' }),
    );
  });
});
