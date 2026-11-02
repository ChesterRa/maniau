// 「済んだ」の用件が今と違う時、前の物の済みを今の作業に当てない。
// 検証器は引き受けの事象を自分でたどり、エンジンの状態や比較関数を使わない。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const base = [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
];
const shirt = { titleKey: 'task.t', titleParams: { what: '白いシャツ', child: '子' } };
const done = (content?: typeof shirt) =>
  event(3, {
    type: 'commitmentChanged',
    taskKey: 't',
    assigneeId: 'a',
    action: 'done',
    ...(content ? { content } : {}),
  });
const inspect = (
  events: ReturnType<typeof event>[],
  overrides: Record<string, unknown>,
  throughSeq = events.length,
) =>
  verifyPlan({
    household: household(),
    events,
    plan: plan({ throughSeq, tasks: [task('t', overrides)] }),
  });
const violations = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('済んだ時に見せた用件', () => {
  it('用件が変われば済みではなく再確認が要り、用件が戻ればまた済みになる', () => {
    const events = [...base, done(shirt)];
    const changed = { titleParams: { what: '赤い帽子', child: '子' } };
    expect(violations(inspect(events, { ...changed, commitment: 'done' }))).toContain(
      'commitment_state_mismatch',
    );
    const accepted = inspect(events, { ...changed, commitment: 'accepted', reconfirm: true });
    expect(violations(accepted)).not.toContain('commitment_state_mismatch');
    expect(violations(accepted)).not.toContain('proposal_reconfirm_missing');
    expect(violations(inspect(events, { ...changed, commitment: 'accepted' }))).toContain(
      'proposal_reconfirm_missing',
    );
    expect(
      violations(
        inspect(events, {
          commitment: 'done',
          titleParams: { child: '子', what: '白いシャツ' },
        }),
      ),
    ).not.toContain('commitment_state_mismatch');
  });

  it('用件のキー、値、欄の増減のいずれも照らす', () => {
    const events = [...base, done(shirt)];
    for (const changed of [
      { titleKey: 'task.other', titleParams: shirt.titleParams },
      { titleParams: { child: '子', what: '青いシャツ' } },
      { titleParams: { what: '白いシャツ' } },
      { titleParams: { ...shirt.titleParams, where: '店' } },
    ]) {
      expect(violations(inspect(events, { ...changed, commitment: 'done' }))).toContain(
        'commitment_state_mismatch',
      );
      expect(
        violations(inspect(events, { ...changed, commitment: 'accepted', reconfirm: true })),
      ).not.toContain('commitment_state_mismatch');
    }
  });

  it('用件が無い古い済みは従来どおり扱う', () => {
    const events = [...base, done()];
    expect(
      violations(inspect(events, { titleParams: { what: '帽子' }, commitment: 'done' })),
    ).not.toContain('commitment_state_mismatch');
    expect(
      violations(inspect(events, { titleParams: { what: '帽子' }, commitment: 'accepted' })),
    ).toContain('commitment_state_mismatch');
  });

  it('後の本人操作・担当替えを、前の済みの控えで上書きしない', () => {
    const previous = [...base, done(shirt)];
    const withdrew = [
      ...previous,
      event(4, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'withdraw' }),
    ];
    expect(
      violations(inspect(withdrew, { titleParams: { what: '帽子' }, commitment: 'withdrawn' })),
    ).not.toContain('commitment_state_mismatch');
    const reassigned = [
      ...previous,
      event(4, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'b' }),
    ];
    expect(
      violations(
        inspect(reassigned, {
          titleParams: { what: '帽子' },
          commitment: 'proposed',
          assigneeId: 'b',
        }),
      ),
    ).not.toContain('commitment_state_mismatch');
  });

  it('担当本人でない済みや、計画の通し番号より後の事象を使わない', () => {
    const other = event(4, {
      type: 'commitmentChanged',
      taskKey: 't',
      assigneeId: 'a',
      actorId: 'b',
      action: 'done',
      content: { titleKey: 'task.t', titleParams: { what: '帽子' } },
    });
    const events = [...base, done(shirt), other];
    const current = { commitment: 'done', titleParams: shirt.titleParams };
    expect(violations(inspect(events, current))).toContain('commitment_actor_mismatch');
    expect(violations(inspect(events, current))).not.toContain('commitment_state_mismatch');
    expect(violations(inspect(events, current, 3))).not.toContain('commitment_state_mismatch');
  });

  it('済みの用件と作業を同じ旧品名にしても、今の要件と食い違えば検出する', () => {
    for (const [titleKey, kind] of [
      ['task.buy', 'belongings'],
      ['task.submit', 'submission'],
    ] as const) {
      const events = [
        ...base,
        done({ titleKey, titleParams: { what: '白いシャツ', child: '子' } }),
      ];
      const check = (what: string) =>
        verifyPlan({
          household: household(),
          events,
          plan: plan({
            throughSeq: 3,
            requirements: [requirement({ key: 'r', kind, what })],
            tasks: [
              task('t', {
                titleKey,
                titleParams: { what: '白いシャツ', child: '子' },
                commitment: 'done',
                basis: { itemIds: [], requirementKey: 'r' },
              }),
            ],
          }),
        });
      expect(violations(check('赤い帽子'))).toContain('task_requirement_content_mismatch');
      expect(violations(check('白いシャツ'))).not.toContain('task_requirement_content_mismatch');
    }
  });

  it('手配の手順に前の日を残したら、済みの控えと同じでも今の要件と照らして検出する', () => {
    const check = (needDate: string, arrangementDate: string, taskDate: string) =>
      verifyPlan({
        household: household(),
        events: [
          ...base,
          event(3, {
            type: 'commitmentChanged',
            taskKey: 't',
            assigneeId: 'a',
            action: 'done',
            content: { titleKey: 'task.step', titleParams: { date: taskDate } },
          }),
        ],
        plan: plan({
          throughSeq: 3,
          requirements: [requirement({ date: needDate })],
          arrangements: [
            arrangement({
              start: `${arrangementDate}T08:10+09:00`,
              end: `${arrangementDate}T18:15+09:00`,
              options: [option('one', { taskKeys: ['t'] })],
            }),
          ],
          tasks: [
            task('t', {
              titleKey: 'task.step',
              titleParams: { date: taskDate },
              step: { templateId: 'one', stepId: 'step' },
              commitment: 'done',
              basis: {
                itemIds: [],
                requirementKey: 'requirement',
                arrangementKey: 'arrangement',
                optionKey: 'one',
              },
            }),
          ],
        }),
      });
    expect(violations(check('2026-12-14', '2026-12-14', '2026-12-07'))).toContain(
      'task_requirement_date_mismatch',
    );
    expect(violations(check('2026-12-07', '2026-12-14', '2026-12-07'))).toContain(
      'arrangement_requirement_date_mismatch',
    );
    expect(violations(check('2026-12-14', '2026-12-14', '2026-12-14'))).not.toContain(
      'task_requirement_date_mismatch',
    );
    expect(violations(check('2026-12-14', '2026-12-14', '2026-12-14'))).not.toContain(
      'arrangement_requirement_date_mismatch',
    );
  });

  it('前の日の済みだけで、新しい日の案が決め時までに始まったとは言えない', () => {
    const check = (finishedDate: string, withdrew = false) => {
      const events = [
        event(1, { type: 'householdSet', household: household() }),
        event(2, {
          type: 'optionChosen',
          arrangementKey: 'arrangement',
          optionKey: 'one',
          role: 'primary',
        }),
        event(3, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
        event(4, {
          type: 'commitmentChanged',
          taskKey: 't',
          assigneeId: 'a',
          action: 'done',
          content: { titleKey: 'task.step', titleParams: { date: finishedDate } },
        }),
        ...(withdrew
          ? [
              event(5, {
                type: 'commitmentChanged',
                taskKey: 't',
                assigneeId: 'a',
                action: 'withdraw',
              }),
            ]
          : []),
      ];
      return verifyPlan({
        household: household(),
        events,
        plan: plan({
          throughSeq: events.length,
          now: '2026-12-08T09:00+09:00',
          requirements: [requirement({ date: '2026-12-14' })],
          arrangements: [
            arrangement({
              start: '2026-12-14T08:10+09:00',
              end: '2026-12-14T18:15+09:00',
              chosenOptionKey: 'one',
              inUseOptionKey: 'one',
              options: [
                option('one', {
                  taskKeys: ['t'],
                  expired: true,
                  decisionDeadline: '2026-12-07T17:20+09:00',
                  deadlineCertainty: 'estimate',
                }),
              ],
            }),
          ],
          tasks: [
            task('t', {
              titleKey: 'task.step',
              titleParams: { date: '2026-12-14' },
              step: { templateId: 'one', stepId: 'step' },
              basis: {
                itemIds: [],
                requirementKey: 'requirement',
                arrangementKey: 'arrangement',
                optionKey: 'one',
              },
              commitment: withdrew
                ? 'withdrawn'
                : finishedDate === '2026-12-14'
                  ? 'done'
                  : 'accepted',
              ...(!withdrew && finishedDate !== '2026-12-14' ? { reconfirm: true } : {}),
            }),
          ],
        }),
      });
    };
    const old = check('2026-12-07');
    expect(old.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'missed_deadline_unreported',
        subject: 'one',
      }),
    );
    const same = check('2026-12-14');
    expect(same.issues.map((issue) => issue.code)).not.toContain('missed_deadline_unreported');
    const withdrew = check('2026-12-14', true);
    expect(withdrew.issues.map((issue) => issue.code)).toContain('missed_deadline_unreported');
  });

  it('依頼の日を家庭の時区で照らし、違う日や訂正済みの送信を今の進捗にしない', () => {
    const basis = {
      itemIds: [],
      requirementKey: 'requirement',
      arrangementKey: 'arrangement',
      optionKey: 'one',
    };
    const check = (window?: { start: string; end: string }, corrected = false) => {
      const events = [
        event(1, { type: 'householdSet', household: household() }),
        event(2, {
          type: 'optionChosen',
          arrangementKey: 'arrangement',
          optionKey: 'one',
          role: 'primary',
        }),
        event(3, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
        event(4, {
          type: 'externalRequestSent',
          taskKey: 't',
          requestId: 'r',
          snapshot: { to: 'helper', kind: 'reply', basis, ...(window ? { window } : {}) },
        }),
        ...(corrected ? [event(5, { type: 'requestRecordCorrected', requestId: 'r' })] : []),
      ];
      return verifyPlan({
        household: household(),
        events,
        plan: plan({
          throughSeq: events.length,
          now: '2026-12-08T09:00+09:00',
          requirements: [requirement({ date: '2026-12-14' })],
          arrangements: [
            arrangement({
              start: '2026-12-14T08:10+09:00',
              end: '2026-12-14T18:15+09:00',
              chosenOptionKey: 'one',
              options: [
                option('one', {
                  taskKeys: ['t'],
                  expired: true,
                  decisionDeadline: '2026-12-07T17:20+09:00',
                  deadlineCertainty: 'estimate',
                }),
              ],
            }),
          ],
          tasks: [
            task('t', {
              titleKey: 'task.step',
              titleParams: { date: '2026-12-14' },
              step: { templateId: 'one', stepId: 'step' },
              basis,
              commitment: corrected ? 'proposed' : 'done',
              external: { to: 'helper', kind: 'reply' },
            }),
          ],
          requests: corrected
            ? []
            : [
                {
                  requestId: 'r',
                  taskKey: 't',
                  to: 'helper',
                  kind: 'reply',
                  sentBy: 'a',
                  sentAt: '2026-11-30T10:00+09:00',
                  state: 'awaitingReply',
                  basis,
                  live: true,
                  ...(window ? { window } : {}),
                },
              ],
        }),
      });
    };
    const old = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
    // UTC の表示日が 12/13 でも、家庭の時区では 12/14 になる。
    const same = { start: '2026-12-13T23:10+00:00', end: '2026-12-14T09:15+00:00' };
    expect(check(old).issues.map((issue) => issue.code)).toContain('missed_deadline_unreported');
    expect(check(same).issues.map((issue) => issue.code)).not.toContain(
      'missed_deadline_unreported',
    );
    expect(check().issues.map((issue) => issue.code)).not.toContain('missed_deadline_unreported');
    expect(check(same, true).issues.map((issue) => issue.code)).toContain(
      'missed_deadline_unreported',
    );
  });
});
