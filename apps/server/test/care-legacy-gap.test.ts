// 旧形の日程の間の未記録を、見守り可能と決めずに家族へ聞けるかを確かめる。
import { DomainEvent, Extraction, Household, validateHousehold } from '@maniau/core';
import { careCoverage, computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { householdCareKnowledge } from '../../../packages/verify/src/care-household-evidence';
import { demoEvents } from '../src/demo';

describe('旧い区間の間の未記録', () => {
  it('10–11 時は A 未記録、B 仕事なので、家族に確かめる', () => {
    const source = demoEvents('arrived');
    const original = foldEvents(source).household;
    if (!original) throw new Error('家庭がない');
    const date = '2026-12-07';
    const h = Household.parse({
      ...original,
      routineExceptions: [
        {
          memberId: 'a',
          date,
          segments: [
            { kind: 'home', start: '09:00', end: '10:00', placeId: 'home' },
            { kind: 'work', start: '11:00', end: '12:00', placeId: 'home' },
          ],
        },
        {
          memberId: 'b',
          date,
          segments: [{ kind: 'work', start: '10:00', end: '11:00', placeId: 'home' }],
        },
      ],
    });
    expect(validateHousehold(h)).toEqual([]);
    const events = source.map((e) => {
      if (e.type === 'householdSet') return DomainEvent.parse({ ...e, household: h });
      if (e.type === 'modelOutputRecorded' && e.call === 'extract') {
        const output = Extraction.parse(e.output);
        return DomainEvent.parse({
          ...e,
          output: {
            ...output,
            items: output.items.map((item) => {
              if (item.kind !== 'dayChange' || item.interpretation.dayType !== 'noSchool')
                return item;
              const { conditionNodeId: _condition, ...rest } = item;
              return rest;
            }),
          },
        });
      }
      return e;
    });
    const result = careCoverage(h, date);
    const independent = householdCareKnowledge(h, date);
    const plan = computePlan(events, '2026-11-25T19:40+09:00');
    const requirement = plan.requirements.find((r) => r.live && r.kind === 'childCare');
    const report = verifyPlan({ household: h, plan, events });
    expect(independent?.missing).toContainEqual({ start: 600, end: 660, adults: ['a'] });
    expect(result.missing).toContain('a');
    expect(requirement?.missingAdults).toContain('a');
    expect(requirement?.unsure).toEqual([
      { start: '2026-12-07T10:00+09:00', end: '2026-12-07T11:00+09:00' },
    ]);
    expect(
      report.issues.filter(
        (issue) => issue.kind === 'violation' && issue.code.startsWith('child_care_'),
      ),
    ).toEqual([]);
  });
});
