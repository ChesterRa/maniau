import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ConditionNode,
  DomainEvent,
  evaluateCondition,
  Household,
  MAX_CONDITION_NODES,
  type Unknown,
  validateConditions,
  validateHousehold,
} from '../src';

const demoHousehold = () =>
  JSON.parse(readFileSync(new URL('../../../data/demo/household.json', import.meta.url), 'utf8'));

describe('デモの家族', () => {
  it('型に合い、参照と区間に誤りが無い', () => {
    const household = Household.parse(demoHousehold());
    expect(validateHousehold(household)).toEqual([]);
    const adults = household.members.filter((m) => m.kind === 'adult');
    for (const adult of adults) {
      const days = household.routines.filter((r) => r.memberId === adult.id).map((r) => r.weekday);
      expect(days.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('壊した参照と重なる区間を見つける', () => {
    const household = Household.parse(demoHousehold());
    const firstDay = household.routines[0];
    const firstSegment = firstDay?.segments[0];
    if (!firstDay || !firstSegment) throw new Error('デモの区間が無い');
    firstSegment.placeId = 'nowhere';
    firstDay.segments.push({ ...firstSegment, start: '06:00', end: '07:00', viaStationIds: [] });
    const problems = validateHousehold(household).map((i) => i.problem);
    expect(problems).toContain('unknownRef');
    expect(problems).toContain('overlap');
  });
});

describe('条件の式', () => {
  // 「5日に行った場合、7日は振替休業日。延期なら8日に行い、7日は通常授業」
  const unknowns: Unknown[] = [
    {
      id: 'u-date',
      label: '学習発表会の実施日',
      values: ['2026-12-05', '2026-12-08'],
      kind: 'schedule',
    },
  ];
  const nodes: ConditionNode[] = [
    { id: 'c-held-5', kind: 'eq', unknownId: 'u-date', value: '2026-12-05' },
    { id: 'c-held-8', kind: 'eq', unknownId: 'u-date', value: '2026-12-08' },
    { id: 'c-not-5', kind: 'not', childId: 'c-held-5' },
    { id: 'c-either', kind: 'or', childIds: ['c-held-5', 'c-held-8'] },
  ];

  it('宣言どおりの式は通る', () => {
    expect(validateConditions(nodes, unknowns)).toEqual([]);
  });

  it('値が決まるまでは「分からない」、決まれば真偽', () => {
    const none = new Map<string, string>();
    expect(evaluateCondition('c-held-5', nodes, none)).toBe('unknown');
    expect(evaluateCondition('c-either', nodes, none)).toBe('unknown');
    const postponed = new Map([['u-date', '2026-12-08']]);
    expect(evaluateCondition('c-held-5', nodes, postponed)).toBe(false);
    expect(evaluateCondition('c-not-5', nodes, postponed)).toBe(true);
    expect(evaluateCondition('c-either', nodes, postponed)).toBe(true);
  });

  it('宣言の無い値・無い子・循環を見つける', () => {
    const broken: ConditionNode[] = [
      { id: 'x1', kind: 'eq', unknownId: 'u-date', value: '2026-12-06' },
      { id: 'x2', kind: 'eq', unknownId: 'u-missing', value: 'yes' },
      { id: 'x3', kind: 'and', childIds: ['x4', 'x9'] },
      { id: 'x4', kind: 'not', childId: 'x3' },
    ];
    const problems = validateConditions(broken, unknowns).map((i) => i.problem);
    expect(problems).toEqual(
      expect.arrayContaining(['undeclaredValue', 'undeclaredUnknown', 'missingChild', 'cycle']),
    );
  });

  it('同じ子を共有する深い式も、子を一度ずつ評価して速く終わる', () => {
    // and の子に、一つ下の節点を二度ずつ入れる。覚えずに評価すると 2^40 回たどる。
    const depth = 40;
    const deep: ConditionNode[] = [
      { id: 'd0', kind: 'eq', unknownId: 'u-date', value: '2026-12-05' },
    ];
    for (let i = 1; i <= depth; i += 1) {
      deep.push({ id: `d${i}`, kind: 'and', childIds: [`d${i - 1}`, `d${i - 1}`] });
    }
    expect(validateConditions(deep, unknowns)).toEqual([]);
    const held5 = new Map([['u-date', '2026-12-05']]);
    const started = performance.now();
    expect(evaluateCondition(`d${depth}`, deep, held5)).toBe(true);
    expect(evaluateCondition(`d${depth}`, deep, new Map())).toBe('unknown');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('節点が多すぎる式は使わない', () => {
    const many: ConditionNode[] = Array.from({ length: MAX_CONDITION_NODES + 1 }, (_, i) => ({
      id: `m${i}`,
      kind: 'eq',
      unknownId: 'u-date',
      value: '2026-12-05',
    }));
    const problems = validateConditions(many, unknowns);
    expect(problems).toHaveLength(MAX_CONDITION_NODES + 1);
    expect(new Set(problems.map((i) => i.problem))).toEqual(new Set(['tooLarge']));
  });
});

describe('事象', () => {
  it('本人の引き受けの事象を受け付け、知らない種類を断る', () => {
    const base = {
      id: 'e1',
      householdId: 'demo-toyosu',
      seq: 1,
      version: 1,
      occurredAt: '2026-11-25T19:31+09:00',
      recordedAt: '2026-11-25T19:31+09:00',
      actorId: 'b',
    };
    const accepted = DomainEvent.safeParse({
      ...base,
      type: 'commitmentChanged',
      taskKey: 'task:x',
      assigneeId: 'b',
      action: 'accept',
    });
    expect(accepted.success).toBe(true);
    expect(DomainEvent.safeParse({ ...base, type: 'somethingElse' }).success).toBe(false);
  });
});
