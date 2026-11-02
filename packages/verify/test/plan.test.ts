import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);

describe('入力と根拠', () => {
  it('空の計画は通し、不正な型と別の家庭の計画を断る', () => {
    expect(verifyPlan({ household: household(), plan: plan(), events: [] }).status).toBe('pass');
    expect(codes(verifyPlan({ household: household(), plan: {}, events: [] }))).toContain(
      'invalid_plan',
    );
    expect(
      codes(
        verifyPlan({ household: household(), plan: plan({ householdId: 'other' }), events: [] }),
      ),
    ).toContain('household_mismatch');
  });

  it('検証に渡した家庭の情報が、その時点の事象と異なれば検出する', () => {
    const stored = household();
    const modified = household();
    const member = modified.members[0];
    if (!member) throw new Error('成員がない');
    member.name = '別の名前';
    const report = verifyPlan({
      household: modified,
      plan: plan({ throughSeq: 1 }),
      events: [event(1, { type: 'householdSet', household: stored })],
    });
    expect(codes(report)).toContain('household_snapshot_mismatch');
  });

  it('循環する先後関係を、作業時刻が未定でも検出する', () => {
    const a = task('a', {
      start: undefined,
      end: undefined,
      after: [{ taskKey: 'b', waitMin: 0 }],
    });
    const b = task('b', {
      start: undefined,
      end: undefined,
      after: [{ taskKey: 'a', waitMin: 0 }],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [a, b] }),
      events: [],
    });
    expect(codes(report)).toContain('dependency_cycle');
  });

  it('買い物の案に家庭の取れる手の雛形がなくても、存在しない手配と決めつけない', () => {
    const purchase = option('buy', { templateId: 'buy' });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement({ kind: 'belongings' })],
        arrangements: [arrangement({ kind: 'purchase', options: [purchase] })],
      }),
      events: [],
    });
    expect(codes(report)).not.toContain('option_template_missing');
    expect(codes(report)).toContain('purchase_template_unverified');
  });

  it('取れるか未判定の案を残したまま、不可能と表示しない', () => {
    const candidate = option('one');
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({
            status: 'infeasible',
            reasons: [{ code: 'noOptionLeft', refs: ['one'] }],
            options: [candidate],
          }),
        ],
      }),
      events: [],
    });
    expect(codes(report)).toContain('infeasible_with_unknown_option');
  });

  it('探索の上限に達しただけで不可能としない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({ status: 'infeasible', reasons: [{ code: 'searchLimit', refs: [] }] }),
        ],
      }),
      events: [],
    });
    expect(codes(report)).toContain('infeasible_without_proof');
  });

  it('どの案が問いで変わるか分からない時、別の案の期限を過ぎただけで違反にしない', () => {
    const first = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'estimate',
    });
    const second = option('two', {
      decisionDeadline: '2026-12-04T18:00+09:00',
      deadlineCertainty: 'estimate',
    });
    const question = {
      key: 'q1',
      unknownId: 'u1',
      askBy: '2026-12-03T12:00+09:00',
      fallbackValue: 'no',
      affects: ['arrangement'],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [arrangement({ options: [first, second] })],
        questions: [question],
      }),
      events: [],
    });
    expect(codes(report)).not.toContain('question_after_decision');
    expect(codes(report)).toContain('question_option_scope_unknown');
  });

  it('家庭の手順と異なる所要時間を見つける', () => {
    const item = task('t', {
      durationMin: 20,
      end: '2026-12-07T10:20+09:00',
      step: { templateId: 'one', stepId: 'step' },
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [item] }),
      events: [],
    });
    expect(codes(report)).toContain('step_constraints_mismatch');
  });

  it('追加の準備は、手配の日を基準にした日付の決まりと照らす', () => {
    const family = household();
    family.careOptions[0]?.extraSteps.push({
      id: 'lunch',
      titleKey: 'task.lunch',
      durationMin: 30,
      segments: ['home'],
      waitAfterMin: 0,
      dayOffset: 0,
    });
    const base = {
      step: { templateId: 'one', stepId: 'lunch' },
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
    };
    const check = (start: string, end: string) =>
      verifyPlan({
        household: family,
        plan: plan({
          requirements: [requirement()],
          arrangements: [arrangement({ options: [option('one', { taskKeys: ['t'] })] })],
          tasks: [task('t', { ...base, start, end })],
        }),
        events: [],
      });
    expect(codes(check('2026-12-07T10:00+09:00', '2026-12-07T10:30+09:00'))).not.toContain(
      'extra_step_wrong_date',
    );
    expect(codes(check('2026-12-06T10:00+09:00', '2026-12-06T10:30+09:00'))).toContain(
      'extra_step_wrong_date',
    );
    expect(codes(check('2026-12-07T23:45+09:00', '2026-12-08T00:15+09:00'))).toContain(
      'extra_step_wrong_date',
    );
  });
});

describe('決め時', () => {
  it('期限の真偽値が違っても、現在時刻と決め時から判定する', () => {
    const candidate = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'checked',
      expired: true,
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        now: '2026-12-01T09:00+09:00',
        requirements: [requirement()],
        arrangements: [
          arrangement({
            status: 'infeasible',
            reasons: [{ code: 'noOptionLeft', refs: ['one'] }],
            options: [candidate],
          }),
        ],
      }),
      events: [],
    });
    expect(codes(report)).toContain('expired_state_mismatch');
    expect(codes(report)).toContain('no_option_left_unverified');
  });

  it('選んだ本命が未着手で決め時を過ぎた時、理由なしで成立としない', () => {
    const candidate = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'checked',
      expired: false,
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        now: '2026-12-03T09:00+09:00',
        throughSeq: 1,
        requirements: [requirement()],
        arrangements: [arrangement({ chosenOptionKey: 'one', options: [candidate] })],
      }),
      events: [
        event(1, {
          type: 'optionChosen',
          arrangementKey: 'arrangement',
          optionKey: 'one',
          role: 'primary',
        }),
      ],
    });
    expect(codes(report)).toContain('expired_state_mismatch');
    expect(codes(report)).toContain('missed_deadline_unreported');
    expect(codes(report)).toContain('failed_option_treated_as_valid');
    expect(report.issues.find((issue) => issue.code === 'option_start_unverified')?.kind).toBe(
      'undetermined',
    );
  });

  it('本命を断られて予備も推薦もない時、手配を成立としない', () => {
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
      event(4, { type: 'externalReplyRecorded', requestId: 'r', reply: 'no' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 4,
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
        ],
        requests: [
          {
            requestId: 'r',
            taskKey: 't',
            to: 'helper',
            kind: 'reply',
            sentAt: '2026-11-30T10:00+09:00',
            sentBy: 'a',
            state: 'turnedDown',
            basis,
            live: true,
          },
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('rejected_option_unreported');
    expect(codes(report)).toContain('failed_option_treated_as_valid');
  });

  it('期限を過ぎた未選択の案を推薦しない', () => {
    const candidate = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'checked',
      expired: false,
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        now: '2026-12-03T09:00+09:00',
        requirements: [requirement()],
        arrangements: [arrangement({ recommendedOptionKey: 'one', options: [candidate] })],
      }),
      events: [],
    });
    expect(codes(report)).toContain('expired_option_recommended');
  });

  it('期限内に選んで実行した案は、後に時刻が過ぎても無効としない', () => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'done' }),
    ];
    const candidate = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'checked',
      expired: false,
      taskKeys: ['t'],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        now: '2026-12-03T09:00+09:00',
        throughSeq: 3,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            recommendedOptionKey: 'one',
            options: [candidate],
          }),
        ],
        tasks: [
          task('t', {
            commitment: 'done',
            start: undefined,
            end: undefined,
            basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
          }),
        ],
      }),
      events,
    });
    expect(codes(report)).not.toContain('expired_option_recommended');
  });

  it('前回の選択で完了した作業を、選び直した案の開始証拠に使わない', () => {
    const events = [
      event(1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
      event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'done' }),
      event(4, { type: 'optionDropped', arrangementKey: 'arrangement', optionKey: 'one' }),
      event(5, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
    ];
    const candidate = option('one', {
      decisionDeadline: '2026-12-02T18:00+09:00',
      deadlineCertainty: 'checked',
      expired: false,
      taskKeys: ['t'],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        now: '2026-12-03T09:00+09:00',
        throughSeq: 5,
        requirements: [requirement()],
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            recommendedOptionKey: 'one',
            options: [candidate],
          }),
        ],
        tasks: [
          task('t', {
            commitment: 'done',
            start: undefined,
            end: undefined,
            basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
          }),
        ],
      }),
      events,
    });
    expect(codes(report)).toContain('started_option_unknown');
  });

  it('家庭の申込期限より後の決め時を見つける', () => {
    const candidate = option('one', {
      decisionDeadline: '2026-12-05T09:00+09:00',
      deadlineCertainty: 'checked',
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [arrangement({ options: [candidate] })],
      }),
      events: [],
    });
    expect(codes(report)).toContain('decision_after_rule_deadline');
  });

  it('営業日は週末と祝日を飛ばし、期限を独立に照合する', () => {
    const family = household();
    const template = family.careOptions.find((entry) => entry.id === 'one');
    if (!template) throw new Error('取れる手がない');
    template.deadline = { type: 'businessDaysBefore', days: 1, at: '18:00' };
    const candidate = option('one', {
      decisionDeadline: '2026-11-23T17:00+09:00',
      deadlineCertainty: 'checked',
    });
    const report = verifyPlan({
      household: family,
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({
            start: '2026-11-24T08:10+09:00',
            end: '2026-11-24T18:15+09:00',
            options: [candidate],
          }),
        ],
      }),
      events: [],
    });
    expect(codes(report)).toContain('decision_after_rule_deadline');
  });
});
