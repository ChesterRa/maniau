// 買い物が計画から消えた後も、「買ってある」は完成の事象と用件から確かめる。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement } from './fixtures';

const key = 'task:opt:arr:purchase:item:buy:buy';
const boughtRequirement = () =>
  requirement({
    key: 'req:belongings:item',
    kind: 'belongings',
    what: '白い長袖シャツ',
    atHomeUnknownId: 'u-atHome:item',
    bought: true,
  });
const check = (bodies: Record<string, unknown>[], incomplete = false) => {
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    ...bodies.map((body, n) => event(n + 2, body)),
  ];
  return verifyPlan({
    household: household(),
    events: incomplete ? events.filter((e) => e.seq !== 2) : events,
    plan: plan({ throughSeq: events.length, requirements: [boughtRequirement()] }),
  });
};
const codes = (result: ReturnType<typeof check>, kind: 'violation' | 'undetermined') =>
  result.issues.filter((i) => i.kind === kind).map((i) => i.code);
const assignment = { type: 'assignmentProposed', taskKey: key, assigneeId: 'a' };
const done = (what?: string) => ({
  type: 'commitmentChanged',
  taskKey: key,
  assigneeId: 'a',
  action: 'done',
  ...(what ? { content: { titleKey: 'task.buy', titleParams: { what } } } : {}),
});

describe('買った物', () => {
  it('今の品物を本人が済ませた時は、買ってあると示せる', () => {
    expect(codes(check([assignment, done('白い長袖シャツ')]), 'violation')).not.toContain(
      'belonging_bought_mismatch',
    );
  });
  it('買った後に同じ品物の状態を答え直したら、購入の済みを現在の状態にしない', () => {
    const answer = (value: 'yes' | 'no', about = '白い長袖シャツ') => ({
      type: 'answered',
      unknownId: 'u-atHome:item',
      value,
      about,
    });
    for (const value of ['yes', 'no'] as const) {
      expect(
        codes(check([assignment, done('白い長袖シャツ'), answer(value)]), 'violation'),
      ).toContain('belonging_bought_mismatch');
      expect(
        codes(check([assignment, answer(value), done('白い長袖シャツ')]), 'violation'),
      ).not.toContain('belonging_bought_mismatch');
    }
    expect(
      codes(check([assignment, done('白い長袖シャツ'), answer('no', '赤い帽子')]), 'violation'),
    ).not.toContain('belonging_bought_mismatch');
  });
  it('買った事象が無い、別の品物を買った、後から担当を決め直した時は、買ってあると断定できない', () => {
    for (const result of [
      check([]),
      check([assignment, done('赤い帽子')]),
      check([assignment, done('白い長袖シャツ'), assignment]),
    ]) {
      expect(codes(result, 'violation')).toContain('belonging_bought_mismatch');
    }
  });
  it('昔の用件なしの済みと、事象が欠けた時は未判定にする', () => {
    for (const result of [
      check([assignment, done()]),
      check([assignment, done('白い長袖シャツ')], true),
    ]) {
      expect(codes(result, 'undetermined')).toContain('belonging_bought_unverified');
      expect(codes(result, 'violation')).not.toContain('belonging_bought_mismatch');
    }
  });
});
