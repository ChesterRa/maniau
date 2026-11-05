// 固定した架空の学校通知と家庭の事象を正式に読み、独立検証の結果を照らす。
// 家庭にない日程を「問題なし」とせず、分からない根拠を独立に照らす。
import { DomainEvent, Extraction, type PlanResult } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../src/demo';

const now = '2026-11-25T19:31+09:00';
const date = '2026-12-07';
const fullDay = { start: `${date}T00:00+09:00`, end: '2026-12-08T00:00+09:00' };

function eventsFor(unconditional: boolean) {
  return demoEvents('arrived').map((event) => {
    if (event.type === 'householdSet') {
      return DomainEvent.parse({
        ...event,
        household: { ...event.household, routines: [], routineExceptions: [] },
      });
    }
    if (event.type === 'modelOutputRecorded' && event.call === 'extract' && unconditional) {
      const output = Extraction.parse(event.output);
      return DomainEvent.parse({
        ...event,
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
    return event;
  });
}

function verify(events: ReturnType<typeof eventsFor>, plan: PlanResult) {
  const household = foldEvents(events).household;
  if (!household) throw new Error('家庭が無い');
  return verifyPlan({ household, plan, events });
}
const violationCodes = (result: ReturnType<typeof verify>) =>
  result.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('学校の休みと全員未入力の家庭', () => {
  it('正しく全日未確認を出すのは違反でなく、印や要件ごと落とせば検知する', () => {
    const events = eventsFor(true);
    const plan = computePlan(events, now);
    const requirement = plan.requirements.find((r) => r.kind === 'childCare' && r.live);
    if (!requirement) throw new Error('子の要件が無い');
    expect(plan.arrangements.filter((a) => a.live && a.kind === 'childCare')).toEqual([]);
    const honest: PlanResult = {
      ...plan,
      requirements: plan.requirements.map((r) =>
        r.key === requirement.key ? { ...r, missingAdults: ['a', 'b'], unsure: [fullDay] } : r,
      ),
    };
    const good = verify(events, honest);
    expect(violationCodes(good).filter((code) => code.startsWith('child_care_'))).toEqual([]);
    const droppedFacts: PlanResult = {
      ...honest,
      requirements: honest.requirements.map((r) => {
        if (r.key !== requirement.key) return r;
        const { missingAdults: _adults, unsure: _unsure, ...rest } = r;
        return rest;
      }),
    };
    expect(violationCodes(verify(events, droppedFacts))).toContain('child_care_missing_adults');
    expect(violationCodes(verify(events, droppedFacts))).toContain('child_care_unsure_mismatch');
    const dropped = {
      ...honest,
      requirements: honest.requirements.filter((r) => r.key !== requirement.key),
    };
    expect(violationCodes(verify(events, dropped))).toContain('child_care_requirement_missing');
  });

  it('条件しだいで休みか分からない時、要件の欠落を確定違反と決めない', () => {
    const events = eventsFor(false);
    const plan = computePlan(events, now);
    const dropped = {
      ...plan,
      requirements: plan.requirements.filter((r) => r.kind !== 'childCare'),
    };
    const result = verify(events, dropped);
    expect(violationCodes(result)).not.toContain('child_care_requirement_missing');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_knowledge_unverified' }),
    );
  });
});
