// 時刻を決めずに引き受ける作業も、本人が見た内容に結び付ける。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

const shown = {
  titleKey: 'task.duty',
  titleParams: { what: '教室の清掃', date: '2026-12-07' },
  travelBeforeMin: 0,
  travelAfterMin: 0,
};
const events = (seen: Record<string, unknown>) => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
  event(3, {
    type: 'commitmentChanged',
    taskKey: 't',
    assigneeId: 'a',
    action: 'accept',
    shown: seen,
  }),
];
const inspect = (
  timing: 'day' | 'undated' | 'fixed',
  changes: Record<string, unknown> = {},
  seen: Record<string, unknown> = shown,
) =>
  verifyPlan({
    household: household(),
    events: events(seen),
    plan: plan({
      throughSeq: 3,
      tasks: [
        task('t', {
          titleKey: shown.titleKey,
          titleParams: shown.titleParams,
          commitment: 'accepted',
          timing,
          start: undefined,
          end: undefined,
          ...changes,
        }),
      ],
    }),
  }).issues;
const codes = (issues: ReturnType<typeof inspect>, kind: 'violation' | 'undetermined') =>
  issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('時刻なしで引き受ける提案', () => {
  for (const timing of ['day', 'undated'] as const) {
    it(`${timing}: 見た控えと同じなら再確認は不要`, () => {
      const issues = inspect(timing);
      expect(codes(issues, 'violation')).not.toContain('proposal_reconfirm_missing');
      expect(codes(issues, 'undetermined')).not.toContain('proposal_current_unplaced');
      expect(codes(inspect(timing, { reconfirm: true }), 'violation')).toContain(
        'proposal_reconfirm_unnecessary',
      );
    });
    it(`${timing}: 用件が変われば時刻なしでも再確認が要る`, () => {
      const changed = { titleParams: { what: '教室の清掃', date: '2026-12-14' } };
      expect(codes(inspect(timing, changed), 'violation')).toContain('proposal_reconfirm_missing');
      expect(codes(inspect(timing, { ...changed, reconfirm: true }), 'violation')).not.toContain(
        'proposal_reconfirm_missing',
      );
    });
  }
  it('時刻ありで受けた控えを時刻なしの作業にそのまま引き継がない', () => {
    const timed = { ...shown, start: '2026-12-07T10:00+09:00', end: '2026-12-07T10:30+09:00' };
    expect(codes(inspect('day', {}, timed), 'violation')).toContain('proposal_reconfirm_missing');
  });
  it('時刻なしで受けた控えに後から時刻を付ければ再確認が要る', () => {
    const placed = { start: '2026-12-07T10:00+09:00', end: '2026-12-07T10:30+09:00' };
    expect(codes(inspect('fixed', placed), 'violation')).toContain('proposal_reconfirm_missing');
  });
  it('固定時刻を置けなかった作業は、両方に時刻が無くても一致としない', () => {
    const issues = inspect('fixed');
    expect(codes(issues, 'violation')).toContain('proposal_reconfirm_missing');
    expect(codes(issues, 'undetermined')).toContain('proposal_current_unplaced');
  });
});
