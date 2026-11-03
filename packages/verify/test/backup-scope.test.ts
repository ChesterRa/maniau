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
    primaryWindow?: { start: string; end: string };
    missingWindow?: boolean;
    unwindowedWaiting?: boolean;
    primaryNeedsCheck?: boolean;
    currentReply?: 'yes' | 'waiting' | 'cancelled';
    backupRequest?: boolean;
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
  const currentWindow = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
  const primaryWindow = options.missingWindow
    ? undefined
    : (options.primaryWindow ?? currentWindow);
  const snapshot = {
    to: 'helper',
    kind: 'reply',
    basis,
    ...(primaryWindow ? { window: primaryWindow } : {}),
  };
  const backupBasis = { ...basis, optionKey: 'two' };
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
  if (options.currentReply) {
    add({
      type: 'externalRequestSent',
      taskKey: 'primary-task',
      requestId: 'r-current',
      snapshot: { ...snapshot, window: currentWindow },
    });
    if (options.currentReply === 'yes')
      add({ type: 'externalReplyRecorded', requestId: 'r-current', reply: 'yes' });
    else if (options.currentReply === 'cancelled')
      add({ type: 'cancellationSent', requestId: 'r-current' });
  }
  if (options.unwindowedWaiting) {
    const { window: _window, ...noWindow } = snapshot;
    add({
      type: 'externalRequestSent',
      taskKey: 'primary-task',
      requestId: 'r-unwindowed',
      snapshot: noWindow,
    });
  }
  if (options.backupRequest) {
    add({ type: 'assignmentProposed', taskKey: 'backup-step', assigneeId: 'a' });
    add({
      type: 'externalRequestSent',
      taskKey: 'backup-step',
      requestId: 'r-backup',
      snapshot: { to: 'helper', kind: 'reply', basis: backupBasis, window: currentWindow },
    });
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
        ...(options.backupRequest
          ? [
              task('primary-task', {
                basis,
                start: undefined,
                end: undefined,
                commitment: 'done',
                external: { to: 'helper', kind: 'reply' },
              }),
            ]
          : []),
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
        {
          ...request('r1', 'primary-task', state, options.primaryLive ?? true),
          ...(primaryWindow ? { window: primaryWindow } : {}),
          ...(options.primaryNeedsCheck ? { needsCheck: true } : {}),
        },
        ...(options.currentReply
          ? [
              {
                ...request(
                  'r-current',
                  'primary-task',
                  options.currentReply === 'yes'
                    ? 'confirmed'
                    : options.currentReply === 'cancelled'
                      ? 'cancelled'
                      : 'awaitingReply',
                  true,
                ),
                window: currentWindow,
              },
            ]
          : []),
        ...(options.unwindowedWaiting
          ? [request('r-unwindowed', 'primary-task', 'awaitingReply', true)]
          : []),
        ...(options.backupRequest
          ? [
              {
                ...request('r-backup', 'backup-step', 'awaitingReply', true),
                basis: backupBasis,
                window: currentWindow,
              },
            ]
          : []),
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

  it('取り消した依頼と、同じ日に頼み直して確定した依頼を混同しない', () => {
    expect(
      overlaps(example('cancelled', { currentReply: 'yes', primaryNeedsCheck: true })),
    ).toEqual([]);
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

describe('本命の外の返事と今の日時', () => {
  const old = { start: '2026-11-30T08:10+09:00', end: '2026-11-30T18:15+09:00' };
  const same = { start: '2026-12-06T23:10+00:00', end: '2026-12-07T09:15+00:00' };
  const changedEnd = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T17:15+09:00' };
  const changedTime = { start: '2026-12-07T09:10+09:00', end: '2026-12-07T18:15+09:00' };
  const current = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
  it('昔の日または同じ日でも別の時段のはいは、新しい案を確定せず、予備の作業も時間を使う', () => {
    // 計画側に needsCheck が無くても、送信した事象の控えとの食い違いを独立して確かめる。
    expect(overlaps(example('yes', { primaryWindow: old })).length).toBeGreaterThan(0);
    expect(overlaps(example('yes', { primaryWindow: changedTime })).length).toBeGreaterThan(0);
    expect(overlaps(example('yes', { primaryWindow: changedEnd })).length).toBeGreaterThan(0);
    expect(
      overlaps(example('yes', { primaryWindow: current, primaryNeedsCheck: true })).length,
    ).toBeGreaterThan(0);
  });
  it('旧い時段の依頼を要確認と示さない計画は、送信事象から違反を見つける', () => {
    const issues = (window: { start: string; end: string }, needsCheck = false) =>
      example('yes', { primaryWindow: window, primaryNeedsCheck: needsCheck }).issues.filter(
        (i) => i.code === 'request_uncertainty_unmarked' && i.subject === 'r1',
      );
    expect(issues(old)).toHaveLength(1);
    expect(issues(changedTime)).toHaveLength(1);
    expect(issues(changedEnd)).toHaveLength(1);
    expect(issues(same)).toEqual([]);
    expect(issues(old, true)).toEqual([]);
  });
  it('同じ瞬間を別の時差で表しても、既に確定した本命と認める', () => {
    expect(overlaps(example('yes', { primaryWindow: same }))).toEqual([]);
    expect(overlaps(example('yes', { primaryWindow: current }))).toEqual([]);
    expect(overlaps(example('yes'))).toEqual([]);
  });
  it('旧い依頼に時段の控えが無い時は、今の本命が確定したと決めない', () => {
    const result = example('yes', { missingWindow: true });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'request_window_unverified',
        subject: 'r1',
      }),
    );
    const checked = example('yes', { missingWindow: true, primaryNeedsCheck: true });
    expect(
      checked.issues.filter(
        (issue) => issue.code === 'request_uncertainty_unmarked' && issue.subject === 'r1',
      ),
    ).toEqual([]);
    expect(
      result.issues.some(
        (i) => i.code === 'task_overlap_scope_unknown' && i.kind === 'undetermined',
      ),
    ).toBe(true);
    expect(overlaps(result)).toEqual([]);
    const withNew = example('waiting', { missingWindow: true, currentReply: 'yes' });
    expect(
      withNew.issues.some(
        (i) => i.code === 'task_overlap_scope_unknown' && i.kind === 'undetermined',
      ),
    ).toBe(true);
  });
  it('別の日の断りと控えのない返事待ちが共存する時、旧い断りが今も有効と断定しない', () => {
    const result = example('no', { primaryWindow: old, unwindowedWaiting: true });
    expect(
      result.issues.filter(
        (issue) => issue.kind === 'violation' && issue.code === 'rejected_option_unreported',
      ),
    ).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'task_overlap_scope_unknown',
      }),
    );
  });
  it('旧日と現在の依頼が共存した時は、現在の日の依頼の返事を見る', () => {
    expect(
      overlaps(example('yes', { primaryWindow: old, currentReply: 'waiting' })).length,
    ).toBeGreaterThan(0);
    expect(overlaps(example('waiting', { primaryWindow: old, currentReply: 'yes' }))).toEqual([]);
    expect(overlaps(example('yes', { primaryWindow: old, currentReply: 'yes' }))).toEqual([]);
    // 前の日の断りも、新しい日に改めて頼んで承諾された後までは持ち越さない。
    expect(overlaps(example('no', { primaryWindow: old, currentReply: 'yes' }))).toEqual([]);
    expect(
      overlaps(example('no', { primaryWindow: old, currentReply: 'waiting' })).length,
    ).toBeGreaterThan(0);
    // 新しい依頼がまだ一つも無い時は、旧い断りを無視して本命が使えると決めない。
    expect(
      overlaps(example('no', { primaryWindow: old, backupExtra: true })).length,
    ).toBeGreaterThan(0);
  });
  it('新しい日の依頼を同じ作業から送れば、古い日の依頼は不要になる', () => {
    const r = example('yes', { primaryWindow: old, currentReply: 'yes', primaryLive: true });
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'request_liveness_mismatch',
        subject: 'r1',
      }),
    );
    const noWindow = example('waiting', { missingWindow: true, currentReply: 'yes' });
    expect(
      noWindow.issues.filter(
        (issue) => issue.code === 'request_liveness_mismatch' && issue.subject === 'r1',
      ),
    ).toEqual([]);
  });
  it('今の日に頼んだ依頼が取消し済みなら、それを根拠に前の日の依頼を外さない', () => {
    const report = example('waiting', { primaryWindow: old, currentReply: 'cancelled' });
    expect(
      report.issues.filter(
        (issue) =>
          issue.kind === 'violation' &&
          issue.subject === 'r1' &&
          ['request_liveness_mismatch', 'cancellation_missing'].includes(issue.code),
      ),
    ).toEqual([]);
  });
  it('旧日の返事を理由に現在も必要な予備の依頼を不要と断じない', () => {
    const r = example('yes', { primaryWindow: old, backupRequest: true });
    expect(
      r.issues.filter((i) => i.code === 'request_liveness_mismatch' && i.subject === 'r-backup'),
    ).toEqual([]);
  });
});
