import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);

describe('事象と外への依頼', () => {
  it('引き受けた人と操作した人が違えば違反', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, {
        type: 'commitmentChanged',
        taskKey: 't',
        assigneeId: 'a',
        actorId: 'b',
        action: 'accept',
      }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, tasks: [task('t', { commitment: 'accepted' })] }),
      events,
    });
    expect(codes(report)).toContain('commitment_actor_mismatch');
  });

  it('担当を替えた場合は、各操作の時点の担当を使う', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, {
        type: 'commitmentChanged',
        taskKey: 't',
        assigneeId: 'a',
        actorId: 'a',
        action: 'accept',
      }),
      event(3, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'b' }),
      event(4, {
        type: 'commitmentChanged',
        taskKey: 't',
        assigneeId: 'b',
        actorId: 'b',
        action: 'accept',
      }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        tasks: [task('t', { assigneeId: 'b', commitment: 'accepted' })],
      }),
      events,
    });
    expect(codes(report)).not.toContain('commitment_assignment_mismatch');
    expect(codes(report)).not.toContain('assignee_state_mismatch');
  });

  it('家族が作業を引き受けただけでは、外への取消しを要求しない', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 2,
        tasks: [
          task('t', {
            live: false,
            commitment: 'accepted',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
      }),
      events,
    });
    expect(codes(report)).not.toContain('cancellation_missing');
  });

  it('不要になった送信済みの依頼に取消しの連絡を要求する', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept' }),
      event(3, { type: 'externalRequestSent', taskKey: 't', requestId: 'r1' }),
      event(4, { type: 'externalReplyRecorded', requestId: 'r1', reply: 'yes' }),
    ];
    const request = {
      requestId: 'r1',
      taskKey: 't',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'confirmed',
      basis: { itemIds: [] },
      live: false,
    };
    const sentTask = task('t', {
      live: false,
      commitment: 'done',
      external: { to: 'helper', kind: 'reply' },
      start: undefined,
      end: undefined,
    });
    const without = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, tasks: [sentTask], requests: [request] }),
      events,
    });
    expect(codes(without)).toContain('cancellation_missing');
    const cancellation = task('cancel', { cancels: 'r1', start: undefined, end: undefined });
    const withCancellation = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, tasks: [sentTask, cancellation], requests: [request] }),
      events,
    });
    expect(codes(withCancellation)).not.toContain('cancellation_missing');
    expect(codes(withCancellation)).not.toContain('request_state_mismatch');
  });

  it('以前の返事を別の依頼の確定に使わない', () => {
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, { type: 'externalRequestSent', taskKey: 't', requestId: 'r1' }),
      event(3, { type: 'externalReplyRecorded', requestId: 'r1', reply: 'yes' }),
      event(4, { type: 'externalRequestSent', taskKey: 't', requestId: 'r2' }),
    ];
    const base = {
      taskKey: 't',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      basis: { itemIds: [] },
      live: true,
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        tasks: [
          task('t', {
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
        requests: [
          { ...base, requestId: 'r1', state: 'confirmed' },
          { ...base, requestId: 'r2', state: 'confirmed' },
        ],
      }),
      events,
    });
    expect(
      report.issues.some(
        (issue) => issue.code === 'request_state_mismatch' && issue.subject === 'r2',
      ),
    ).toBe(true);
  });

  it('推薦欄がなくても、選んだ本命が返事待ちなら確定扱いしない', () => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, { type: 'externalRequestSent', taskKey: 't', requestId: 'r1' }),
    ];
    const request = {
      requestId: 'r1',
      taskKey: 't',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'awaitingReply',
      basis: { itemIds: [] },
      live: true,
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 3,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            status: 'decidable',
            chosenOptionKey: 'one',
            options: [option('one', { taskKeys: ['t'] })],
          }),
        ],
        tasks: [
          task('t', {
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
        requests: [request],
      }),
      events,
    });
    expect(codes(report)).toContain('decidable_waiting_reply');
  });

  it('別の家庭の事象を受け入れない', () => {
    const foreign = event(1, {
      householdId: 'other',
      type: 'clockAdvanced',
      to: '2026-12-01T09:00+09:00',
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 1 }),
      events: [foreign],
    });
    expect(codes(report)).toContain('event_household_mismatch');
  });

  it('本命と予備の記録が計画と食い違えば検出する', () => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 1,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            backupOptionKeys: ['two'],
            options: [option('one'), option('two')],
          }),
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('option_selection_mismatch');
  });

  it('予備をやめた事象を、選択された予備の一覧から除く', () => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'two',
        role: 'backup',
      }),
      event(3, { type: 'optionDropped', arrangementKey: 'arrangement', optionKey: 'two' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 3,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            backupOptionKeys: [],
            options: [option('one'), option('two')],
          }),
        ],
      }),
      events,
    });
    expect(codes(report)).not.toContain('option_selection_mismatch');
    expect(codes(report)).not.toContain('option_drop_without_choice');
  });
});
