import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan } from './fixtures';

const basis = { itemIds: [] };
const originalWindow = {
  start: '2026-12-07T08:10+09:00',
  end: '2026-12-07T18:15+09:00',
};
const request = {
  requestId: 'r',
  taskKey: 't',
  to: 'helper',
  kind: 'reply',
  sentAt: '2026-11-30T10:00+09:00',
  sentBy: 'a',
  state: 'awaitingReply',
  basis,
  live: true,
};

function check(
  snapshotWindow?: typeof originalWindow,
  projectedWindow?: typeof originalWindow,
  includeSnapshot = true,
) {
  const snapshot = {
    to: 'helper',
    kind: 'reply',
    basis,
    ...(snapshotWindow ? { window: snapshotWindow } : {}),
  };
  return verifyPlan({
    household: household(),
    plan: plan({
      throughSeq: 3,
      requests: [{ ...request, ...(projectedWindow ? { window: projectedWindow } : {}) }],
    }),
    events: [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, {
        type: 'externalRequestSent',
        taskKey: 't',
        requestId: 'r',
        ...(includeSnapshot ? { snapshot } : {}),
      }),
    ],
  }).issues.filter((issue) => issue.code.startsWith('request_window_'));
}

describe('依頼を送った時の期間', () => {
  it('元の控えと開始か終了が違う期間を表示すれば違反', () => {
    expect(
      check(originalWindow, { ...originalWindow, start: '2026-12-14T08:10+09:00' }),
    ).toMatchObject([{ kind: 'violation', code: 'request_window_mismatch', subject: 'r' }]);
    expect(
      check(originalWindow, { ...originalWindow, end: '2026-12-14T18:15+09:00' }),
    ).toMatchObject([{ kind: 'violation', code: 'request_window_mismatch', subject: 'r' }]);
  });

  it('異なる時差表記でも同じ瞬間なら違反にしない', () => {
    expect(
      check(originalWindow, { start: '2026-12-06T23:10+00:00', end: '2026-12-07T09:15+00:00' }),
    ).toEqual([]);
  });

  it('送信の控えに期間がないのに計画が期間を示せば違反', () => {
    expect(check(undefined, originalWindow)).toMatchObject([
      { kind: 'violation', code: 'request_window_without_snapshot', subject: 'r' },
    ]);
    expect(check(undefined, originalWindow, false)).toMatchObject([
      { kind: 'violation', code: 'request_window_without_snapshot', subject: 'r' },
    ]);
  });

  it('送信事象そのものが不完全な列から見つからない時は未判定とする', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, requests: [{ ...request, window: originalWindow }] }),
      events: [event(1, { type: 'householdSet', household: household() })],
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'request_window_unverified',
        subject: 'r',
      }),
    );
  });

  it('控えに期間があっても計画にない時は確認できないとする', () => {
    expect(check(originalWindow, undefined)).toMatchObject([
      { kind: 'undetermined', code: 'request_window_unverified', subject: 'r' },
    ]);
  });

  it('どちらにも期間がない依頼は期間の問題にしない', () => {
    expect(check()).toEqual([]);
  });
});
