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

  it('本人以外の操作を違反として記録しても、引き受けの状態は変えない', () => {
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
      plan: plan({ throughSeq: 2, tasks: [task('t', { commitment: 'proposed' })] }),
      events,
    });
    expect(codes(report)).toContain('commitment_actor_mismatch');
    expect(codes(report)).not.toContain('commitment_state_mismatch');
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

  it('選び替えられた依頼は、計画側が live のままでも取消しが要る', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, { type: 'externalRequestSent', taskKey: 't', requestId: 'r' }),
      event(4, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'two',
        role: 'primary',
      }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'two',
            options: [option('one', { taskKeys: ['t'] }), option('two')],
          }),
        ],
        tasks: [
          task('t', {
            basis,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis,
            live: true,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('request_liveness_mismatch');
    expect(codes(report)).toContain('cancellation_missing');
  });

  it('案を何も選ばずに出した依頼は、案が未選択という理由だけでは取り消さない', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const events = [
      event(1, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(2, { type: 'externalRequestSent', taskKey: 't', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 2,
        requirements: [requirement()],
        arrangements: [arrangement({ options: [option('one', { taskKeys: ['t'] })] })],
        tasks: [
          task('t', {
            basis,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis,
            live: true,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).not.toContain('cancellation_missing');
    expect(codes(report)).not.toContain('request_liveness_mismatch');
  });

  it('本命の返事待ちでも、予備の根拠が不明なら取消しの要否を断定しない', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'two' };
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
      event(3, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(4, { type: 'externalRequestSent', taskKey: 't', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            backupOptionKeys: ['two'],
            options: [option('one'), option('two', { taskKeys: ['t'] })],
          }),
        ],
        tasks: [
          task('t', {
            basis,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
          task('cancel', { cancels: 'r', start: undefined, end: undefined }),
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis,
            live: true,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).not.toContain('unexpected_cancellation');
    expect(codes(report)).toContain('cancellation_need_unverified');
  });

  it('本命の依頼が確定すると、出していた予備への取消しが必要になる', () => {
    const primary = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const backup = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'two' };
    const window = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
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
      event(3, { type: 'assignmentProposed', taskKey: 'primary', assigneeId: 'a' }),
      event(4, {
        type: 'externalRequestSent',
        taskKey: 'primary',
        requestId: 'r1',
        snapshot: { to: 'helper', kind: 'reply', basis: primary, window },
      }),
      event(5, { type: 'assignmentProposed', taskKey: 'backup', assigneeId: 'a' }),
      event(6, {
        type: 'externalRequestSent',
        taskKey: 'backup',
        requestId: 'r2',
        snapshot: { to: 'helper', kind: 'reply', basis: backup, window },
      }),
      event(7, { type: 'externalReplyRecorded', requestId: 'r1', reply: 'yes' }),
    ];
    const makePlan = (cancel: boolean) =>
      plan({
        throughSeq: 7,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            backupOptionKeys: ['two'],
            options: [
              option('one', { taskKeys: ['primary'] }),
              option('two', { taskKeys: ['backup'] }),
            ],
          }),
        ],
        tasks: [
          task('primary', {
            basis: primary,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
          task('backup', {
            basis: backup,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
          ...(cancel ? [task('cancel', { cancels: 'r2', start: undefined, end: undefined })] : []),
        ],
        requests: [
          {
            requestId: 'r1',
            taskKey: 'primary',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'confirmed',
            basis: primary,
            window,
            live: true,
          },
          {
            requestId: 'r2',
            taskKey: 'backup',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis: backup,
            window,
            live: !cancel,
          },
        ],
      });
    const missing = verifyPlan({ household: household(), plan: makePlan(false), events });
    expect(codes(missing)).toContain('request_liveness_mismatch');
    expect(codes(missing)).toContain('cancellation_missing');
    const corrected = verifyPlan({ household: household(), plan: makePlan(true), events });
    expect(codes(corrected)).not.toContain('cancellation_missing');
    expect(codes(corrected)).not.toContain('unexpected_cancellation');
  });

  it('唯一の本命を取り下げても、元の依頼を未選択の依頼として残さない', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, { type: 'externalRequestSent', taskKey: 't', requestId: 'r' }),
      event(4, { type: 'optionDropped', arrangementKey: 'arrangement', optionKey: 'one' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
        requirements: [requirement()],
        arrangements: [arrangement({ options: [option('one', { taskKeys: ['t'] })] })],
        tasks: [
          task('t', {
            basis,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'awaitingReply',
            basis,
            live: true,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('request_liveness_mismatch');
    expect(codes(report)).toContain('cancellation_missing');
  });

  it('元の事項と選択が有効なら、必要な依頼を不要・取消し済みと扱わない', () => {
    const basis = { itemIds: ['i1'], arrangementKey: 'arrangement', optionKey: 'one' };
    const events = [
      event(1, {
        type: 'noticeReceived',
        source: {
          id: 'n1',
          version: 1,
          receivedAt: '2026-11-29T10:00+09:00',
          sender: 'school',
          language: 'ja',
          sentences: [{ id: 's1', text: '休みです。' }],
        },
      }),
      event(2, {
        type: 'modelOutputRecorded',
        call: 'extract',
        model: 'test',
        promptVersion: '1',
        inputHash: 'test',
        sourceId: 'n1',
        output: {
          sourceId: 'n1',
          irrelevantSentenceIds: [],
          unknowns: [],
          conditions: [],
          items: [
            {
              id: 'i1',
              sourceId: 'n1',
              sentenceIds: ['s1'],
              kind: 'dayChange',
              written: '休みです。',
              interpretation: {},
              evidence: 'stated',
            },
          ],
        },
      }),
      event(3, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(4, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(5, { type: 'externalRequestSent', taskKey: 't', requestId: 'r' }),
      event(6, { type: 'cancellationSent', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 6,
        requirements: [requirement()],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', options: [option('one', { taskKeys: ['t'] })] }),
        ],
        tasks: [
          task('t', {
            basis,
            commitment: 'done',
            external: { to: 'helper', kind: 'reply' },
            start: undefined,
            end: undefined,
          }),
          task('cancel', { cancels: 'r', start: undefined, end: undefined }),
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'cancelled',
            basis,
            live: false,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('request_liveness_mismatch');
    expect(codes(report)).toContain('needed_request_cancelled');
    expect(codes(report)).toContain('unexpected_cancellation');
  });

  it('計画だけが不要と示し根拠が不明な依頼は、取消しの要否を断定しない', () => {
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
    expect(codes(without)).not.toContain('cancellation_missing');
    expect(codes(without)).toContain('request_need_unverified');
    const cancellation = task('cancel', { cancels: 'r1', start: undefined, end: undefined });
    const withCancellation = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, tasks: [sentTask, cancellation], requests: [request] }),
      events,
    });
    expect(codes(withCancellation)).not.toContain('cancellation_missing');
    expect(codes(withCancellation)).toContain('cancellation_need_unverified');
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

  it('本命が断られて予備へ移った場合、予備の返事待ちを確定扱いしない', () => {
    const one = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const two = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'two' };
    const window = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
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
      event(3, { type: 'assignmentProposed', taskKey: 't1', assigneeId: 'a' }),
      event(4, {
        type: 'externalRequestSent',
        taskKey: 't1',
        requestId: 'r1',
        snapshot: { to: 'helper', kind: 'reply', basis: one, window },
      }),
      event(5, { type: 'externalReplyRecorded', requestId: 'r1', reply: 'no' }),
      event(6, { type: 'assignmentProposed', taskKey: 't2', assigneeId: 'a' }),
      event(7, {
        type: 'externalRequestSent',
        taskKey: 't2',
        requestId: 'r2',
        snapshot: { to: 'helper', kind: 'reply', basis: two, window },
      }),
    ];
    const current = plan({
      throughSeq: 7,
      requirements: [requirement()],
      arrangements: [
        arrangement({
          chosenOptionKey: 'one',
          backupOptionKeys: ['two'],
          options: [option('one', { taskKeys: ['t1'] }), option('two', { taskKeys: ['t2'] })],
          reasons: [{ code: 'turnedDown', refs: ['r1'] }],
        }),
      ],
      tasks: [
        task('t1', {
          basis: one,
          commitment: 'done',
          external: { to: 'helper', kind: 'reply' },
          start: undefined,
          end: undefined,
        }),
        task('t2', {
          basis: two,
          commitment: 'done',
          external: { to: 'helper', kind: 'reply' },
          start: undefined,
          end: undefined,
        }),
      ],
      requests: [
        {
          requestId: 'r1',
          taskKey: 't1',
          to: 'helper',
          kind: 'reply',
          sentAt: '2026-11-30T10:00+09:00',
          sentBy: 'a',
          state: 'turnedDown',
          basis: one,
          window,
          live: true,
        },
        {
          requestId: 'r2',
          taskKey: 't2',
          to: 'helper',
          kind: 'reply',
          sentAt: '2026-11-30T10:00+09:00',
          sentBy: 'a',
          state: 'awaitingReply',
          basis: two,
          window,
          live: true,
        },
      ],
    });
    const report = verifyPlan({ household: household(), plan: current, events });
    expect(codes(report)).toContain('decidable_waiting_reply');
    expect(codes(report)).not.toContain('failed_option_treated_as_valid');
    const selected = current.arrangements[0];
    if (!selected) throw new Error('手配がない');
    selected.status = 'dependsOnReply';
    selected.reasons.push({ code: 'awaitingReply', refs: ['r2'] });
    const waiting = verifyPlan({ household: household(), plan: current, events });
    expect(codes(waiting)).not.toContain('decidable_waiting_reply');
    expect(codes(waiting)).not.toContain('failed_option_treated_as_valid');
    const backupRequest = current.requests.find((request) => request.requestId === 'r2');
    if (!backupRequest) throw new Error('依頼がない');
    backupRequest.state = 'confirmed';
    current.throughSeq = 8;
    selected.status = 'decidable';
    selected.reasons = [{ code: 'turnedDown', refs: ['r1'] }];
    const confirmed = verifyPlan({
      household: household(),
      plan: current,
      events: [
        ...events,
        event(8, { type: 'externalReplyRecorded', requestId: 'r2', reply: 'yes' }),
      ],
    });
    expect(codes(confirmed)).not.toContain('decidable_waiting_reply');
    expect(codes(confirmed)).not.toContain('failed_option_treated_as_valid');
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
