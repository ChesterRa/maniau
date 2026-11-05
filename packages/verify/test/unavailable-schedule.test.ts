import type { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { checkHistory } from '../src/history';
import { Collector } from '../src/report';
import { checkSchedule } from '../src/schedule';
import { household, plan, task } from './fixtures';

const date = '2026-12-07';
const busy = (start: string, end: string, memberId = 'a') => ({
  id: 'u1',
  memberId,
  date,
  start,
  end,
});
const codes = (rows: ReturnType<typeof busy>[], fields: Record<string, unknown> = {}): string[] => {
  const family = { ...household(), unavailable: rows } as Household;
  const value = plan({ tasks: [task('x', fields)] });
  const report = new Collector();
  const history = checkHistory(family, value, [], new Collector());
  checkSchedule(family, value, history, report);
  return report.issues.map((issue) => issue.code);
};

describe('作業と記録した手が離せない時間', () => {
  it('未完了の作業が占用と重なれば違反', () => {
    expect(codes([busy('10:15', '11:00')])).toContain('task_unavailable');
    expect(codes([busy('10:15', '11:00')], { commitment: 'accepted', reconfirm: true })).toContain(
      'task_unavailable',
    );
  });

  it('端が接するだけ、別人、別の日は重なりにしない', () => {
    expect(codes([busy('09:00', '10:00')])).not.toContain('task_unavailable');
    expect(codes([busy('10:30', '11:00')])).not.toContain('task_unavailable');
    expect(codes([busy('10:15', '11:00', 'b')])).not.toContain('task_unavailable');
    expect(codes([{ ...busy('10:15', '11:00'), date: '2026-12-08' }])).not.toContain(
      'task_unavailable',
    );
  });

  it('作業自体の前にある移動の重なりも照らす', () => {
    expect(codes([busy('09:50', '10:00')], { travelBeforeMin: 15 })).toContain('task_unavailable');
  });

  it('完了した作業には、後からの占用を遡って当てない', () => {
    expect(codes([busy('10:15', '11:00')], { commitment: 'done' })).not.toContain(
      'task_unavailable',
    );
  });
});
