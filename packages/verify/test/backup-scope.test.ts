// 本命と予備が同時に必要かを、選択と依頼の事象から確かめる（求解のコードは使わない）。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

type Reply = 'yes' | 'no' | 'waiting' | 'cancelled';

function example(
  reply: Reply,
  options: {
    anotherWaiting?: boolean;
    otherWaitingLive?: boolean;
    backupDone?: boolean;
    backupLive?: boolean;
    backupCancellation?: boolean;
    backupExtra?: boolean;
    planSaysConfirmed?: boolean;
    primaryLive?: boolean;
    incompleteHistory?: boolean;
    unattributedWaiting?: boolean;
  } = {},
) {
  const family = household();
  if (options.backupExtra) {
    family.careOptions
      .find((entry) => entry.id === 'two')
      ?.extraSteps.push({
        id: 'lunch',
        titleKey: 'task.lunch',
        durationMin: 30,
        segments: ['home'],
        waitAfterMin: 0,
        dayOffset: 0,
      });
  }
  const basis = {
    itemIds: [],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'one',
  };
  const snapshot = { to: 'helper', kind: 'reply', basis };
  const events: ReturnType<typeof event>[] = [];
  const add = (body: Record<string, unknown>) => events.push(event(events.length + 1, body));
  add({ type: 'householdSet', household: family });
  add({ type: 'optionChosen', arrangementKey: 'arrangement', optionKey: 'one', role: 'primary' });
  add({ type: 'optionChosen', arrangementKey: 'arrangement', optionKey: 'two', role: 'backup' });
  add({ type: 'assignmentProposed', taskKey: 'primary-task', assigneeId: 'a' });
  add({ type: 'externalRequestSent', taskKey: 'primary-task', requestId: 'r1', snapshot });
  if (reply === 'yes' || reply === 'no') {
    add({ type: 'externalReplyRecorded', requestId: 'r1', reply });
  } else if (reply === 'cancelled') {
    add({ type: 'cancellationSent', requestId: 'r1' });
  }
  if (options.anotherWaiting) {
    add({ type: 'assignmentProposed', taskKey: 'primary-task-2', assigneeId: 'a' });
    add({ type: 'externalRequestSent', taskKey: 'primary-task-2', requestId: 'r2', snapshot });
  }
  if (options.unattributedWaiting) {
    add({ type: 'assignmentProposed', taskKey: 'vanished-task', assigneeId: 'a' });
    add({ type: 'externalRequestSent', taskKey: 'vanished-task', requestId: 'r3' });
  }
  const state = options.planSaysConfirmed
    ? 'confirmed'
    : reply === 'yes'
      ? 'confirmed'
      : reply === 'no'
        ? 'turnedDown'
        : reply === 'cancelled'
          ? 'cancelled'
          : 'awaitingReply';
  const request = (requestId: string, taskKey: string, requestState: string, live: boolean) => ({
    requestId,
    taskKey,
    to: 'helper',
    kind: 'reply',
    sentAt: '2026-11-30T10:00+09:00',
    sentBy: 'a',
    state: requestState,
    basis,
    live,
  });
  const input = {
    household: family,
    events: options.incompleteHistory ? events.filter((entry) => entry.seq !== 2) : events,
    plan: plan({
      throughSeq: events.length,
      requirements: [requirement()],
      arrangements: [
        arrangement({
          chosenOptionKey: 'one',
          backupOptionKeys: ['two'],
          options: [
            option('one', { taskKeys: ['primary-task', 'primary-task-2'] }),
            option('two', { taskKeys: ['backup-step'] }),
          ],
        }),
      ],
      tasks: [
        task('backup-step', {
          basis: {
            itemIds: [],
            requirementKey: 'requirement',
            arrangementKey: 'arrangement',
            optionKey: 'two',
          },
          step: { templateId: 'two', stepId: options.backupExtra ? 'lunch' : 'step' },
          ...(options.backupCancellation ? { cancels: 'older-request' } : {}),
          commitment: options.backupDone ? 'done' : 'proposed',
          live: options.backupLive ?? true,
        }),
        task('submission'),
      ],
      requests: [
        request('r1', 'primary-task', state, options.primaryLive ?? true),
        ...(options.anotherWaiting
          ? [request('r2', 'primary-task-2', 'awaitingReply', options.otherWaitingLive ?? true)]
          : []),
      ],
    }),
  };
  return verifyPlan(input);
}

const overlaps = (report: ReturnType<typeof example>) =>
  report.issues.filter((issue) => issue.kind === 'violation' && issue.code === 'task_overlap');

describe('本命の返事と予備の通常の手順', () => {
  it('本命がはいで決まり、待つ依頼が無ければ、まだ済んでいない予備の手順は実行から外す', () => {
    expect(overlaps(example('yes'))).toEqual([]);
  });

  it('本命の返事待ち、または一つはいでも他に返事待ちがあれば、予備の手順も重なりを検出する', () => {
    expect(overlaps(example('waiting')).length).toBeGreaterThan(0);
    expect(overlaps(example('yes', { anotherWaiting: true })).length).toBeGreaterThan(0);
  });

  it('本命が断られた、または取り消された時は、予備の手順も重なりを検出する', () => {
    expect(overlaps(example('no')).length).toBeGreaterThan(0);
    expect(overlaps(example('cancelled')).length).toBeGreaterThan(0);
  });

  it('計画だけが確定と言っても、事象が返事待ちなら予備を外さない', () => {
    expect(overlaps(example('waiting', { planSaysConfirmed: true })).length).toBeGreaterThan(0);
  });

  it('はいの依頼が現在は生きていなければ、予備が不要と決めない', () => {
    const report = example('yes', { primaryLive: false });
    expect(report.issues.some((issue) => issue.code === 'task_overlap_scope_unknown')).toBe(true);
  });

  it('本命に確定と不要な返事待ちが混じる時は、返事待ちの必要性を未判定にする', () => {
    const report = example('yes', { anotherWaiting: true, otherWaitingLive: false });
    expect(overlaps(report)).toEqual([]);
    expect(report.issues.some((issue) => issue.code === 'task_overlap_scope_unknown')).toBe(true);
  });

  it('事象が欠けるか、返事待ちの依頼がどの案か分からなければ、重なりを未判定にする', () => {
    for (const report of [
      example('yes', { incompleteHistory: true }),
      example('yes', { unattributedWaiting: true }),
    ]) {
      expect(report.issues.some((issue) => issue.code === 'task_overlap_scope_unknown')).toBe(true);
    }
  });

  it('本命が確定しても、実際に済ませた予備の作業は時間を使う', () => {
    expect(overlaps(example('yes', { backupDone: true })).length).toBeGreaterThan(0);
    expect(
      overlaps(example('yes', { backupDone: true, backupLive: false })).length,
    ).toBeGreaterThan(0);
  });

  it('予備の取消しの連絡は、本命の確定後も時間を使う', () => {
    expect(overlaps(example('yes', { backupCancellation: true })).length).toBeGreaterThan(0);
  });

  it('予備の当日準備は、予備に切り替わった時だけ時間を使う', () => {
    expect(overlaps(example('waiting', { backupExtra: true }))).toEqual([]);
    expect(overlaps(example('yes', { backupExtra: true }))).toEqual([]);
    expect(overlaps(example('no', { backupExtra: true })).length).toBeGreaterThan(0);
  });
});
