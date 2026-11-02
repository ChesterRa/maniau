import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, household, option, plan, requirement, task } from './fixtures';

function careChain(first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) {
  const home = household();
  const template = home.careOptions[0];
  if (!template?.steps[0]) throw new Error('手順の試験データがない');
  template.steps = [
    { ...template.steps[0], id: 'write', durationMin: 10 },
    { ...template.steps[0], id: 'submit', durationMin: 5 },
  ];
  const basis = {
    itemIds: [],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'one',
  };
  const write = task('write', {
    basis,
    step: { templateId: 'one', stepId: 'write' },
    durationMin: 10,
    start: '2026-12-01T10:00+09:00',
    end: '2026-12-01T10:10+09:00',
    ...first,
  });
  const submit = task('submit', {
    basis,
    step: { templateId: 'one', stepId: 'submit' },
    durationMin: 5,
    start: '2026-12-01T10:10+09:00',
    end: '2026-12-01T10:15+09:00',
    after: [{ taskKey: 'write', waitMin: 0 }],
    assigneeId: 'b',
    ...second,
  });
  return verifyPlan({
    household: home,
    plan: plan({
      requirements: [requirement()],
      arrangements: [arrangement({ options: [option('one', { taskKeys: ['write', 'submit'] })] })],
      tasks: [write, submit],
    }),
    events: [],
  });
}

describe('案の途中で担当が替わる時', () => {
  it('交接待ちの印がある作業に、時刻または場所を置いていたら違反', () => {
    const timed = careChain({ handoff: true }, { handoff: true });
    expect(timed.issues.filter((issue) => issue.code === 'handoff_scheduled')).toHaveLength(2);
    const placed = careChain({
      handoff: true,
      start: undefined,
      end: undefined,
      atPlaceId: 'home',
    });
    expect(placed.issues).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'handoff_scheduled' }),
    );
  });

  it('印がなくても同じ案の連続する二人の手順に時刻を置けば違反', () => {
    const result = careChain();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'step_handoff_scheduled',
        subject: 'submit',
      }),
    );
  });

  it('時刻がなくても別の担当に引き継ぐ手順は交接待ちの印が必要', () => {
    const result = careChain(
      { start: undefined, end: undefined },
      { start: undefined, end: undefined },
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'step_handoff_unmarked',
        subject: 'submit',
      }),
    );
  });

  it('両方を同じ人が行うなら交接違反にしない', () => {
    const result = careChain({}, { assigneeId: 'a' });
    expect(result.issues.map((issue) => issue.code)).not.toContain('step_handoff_scheduled');
  });

  it('交接待ちの両作業に時刻も場所もなければ配置違反にしない', () => {
    const result = careChain(
      { handoff: true, start: undefined, end: undefined },
      { handoff: true, start: undefined, end: undefined },
    );
    expect(result.issues.map((issue) => issue.code)).not.toContain('handoff_scheduled');
    expect(result.issues.map((issue) => issue.code)).not.toContain('step_handoff_scheduled');
  });

  it('実行する作業の受け渡しが決まっていなければ未判定とする', () => {
    const result = verifyPlan({
      household: household(),
      plan: plan({ tasks: [task('pending', { handoff: true, start: undefined, end: undefined })] }),
      events: [],
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'handoff_unverified',
        subject: 'pending',
      }),
    );
  });

  it('三つの手順で最初に担当が替われば、その後も同じ鎖として扱う', () => {
    const home = household();
    const template = home.careOptions[0];
    if (!template?.steps[0]) throw new Error('手順の試験データがない');
    const originalStep = template.steps[0];
    template.steps = ['one', 'two', 'three'].map((id) => ({ ...originalStep, id }));
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'chain' };
    const step = (id: string, assigneeId: string, overrides: Record<string, unknown>) =>
      task(id, { basis, step: { templateId: 'one', stepId: id }, assigneeId, ...overrides });
    const result = verifyPlan({
      household: home,
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({
            options: [option('chain', { templateId: 'one', taskKeys: ['one', 'two', 'three'] })],
          }),
        ],
        tasks: [
          step('one', 'a', { handoff: true, start: undefined, end: undefined }),
          step('two', 'b', {
            handoff: true,
            start: undefined,
            end: undefined,
            after: [{ taskKey: 'one', waitMin: 0 }],
          }),
          step('three', 'b', { after: [{ taskKey: 'two', waitMin: 0 }] }),
        ],
      }),
      events: [],
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'step_handoff_unmarked',
        subject: 'three',
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'step_handoff_scheduled',
        subject: 'three',
      }),
    );
  });

  it('過去に済んだ作業と次の担当が違う時は、実際の受け渡しを未判定とする', () => {
    const result = careChain({ commitment: 'done' });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'step_handoff_unverified',
        subject: 'submit',
      }),
    );
  });

  it('別々の一般作業の前後関係は、それだけで物の受け渡しと決めない', () => {
    const result = verifyPlan({
      household: household(),
      plan: plan({
        tasks: [
          task('one', { end: '2026-12-07T10:30+09:00' }),
          task('two', {
            assigneeId: 'b',
            start: '2026-12-07T10:30+09:00',
            end: '2026-12-07T11:00+09:00',
            after: [{ taskKey: 'one', waitMin: 0 }],
          }),
        ],
      }),
      events: [],
    });
    expect(result.issues.map((issue) => issue.code)).not.toContain('step_handoff_scheduled');
  });
});
