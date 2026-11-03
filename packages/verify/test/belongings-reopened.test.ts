// 買った後の答えと購入の済みを、計画エンジンと別に事象の順で照らす。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement, task } from './fixtures';

const key = 'task:opt:arr:purchase:item:buy:buy';
const unknownId = 'u-atHome:item';
const what = '白い長袖シャツ';
const assignment = { type: 'assignmentProposed', taskKey: key, assigneeId: 'a' };
const done = {
  type: 'commitmentChanged',
  taskKey: key,
  assigneeId: 'a',
  action: 'done',
  content: { titleKey: 'task.buy', titleParams: { what } },
};
const no = (about = what) => ({ type: 'answered', unknownId, value: 'no', about });
const check = (bodies: Record<string, unknown>[], commitment: string, incomplete = false) => {
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    ...bodies.map((body, index) => event(index + 2, body)),
  ];
  return verifyPlan({
    household: household(),
    events: incomplete ? events.filter((entry) => entry.seq !== 2) : events,
    plan: plan({
      throughSeq: events.length,
      requirements: [
        requirement({
          key: 'req:belongings:item',
          kind: 'belongings',
          what,
          atHomeUnknownId: unknownId,
        }),
      ],
      tasks: [
        task(key, {
          titleKey: 'task.buy',
          titleParams: { what },
          commitment,
          basis: { itemIds: [], requirementKey: 'req:belongings:item' },
        }),
      ],
    }),
  });
};
const issues = (report: ReturnType<typeof check>) =>
  report.issues.filter((issue) => issue.code === 'commitment_state_mismatch');

describe('購入をもう一度用意する', () => {
  it('買った後に無いと答えれば再開し、古い済みには戻さない', () => {
    const bodies = [assignment, done, no()];
    expect(issues(check(bodies, 'accepted'))).toEqual([]);
    expect(issues(check(bodies, 'done'))).toContainEqual(
      expect.objectContaining({ kind: 'violation' }),
    );
  });
  it('答えた後に買った時や、別の品物への答えは済みを覆さない', () => {
    for (const bodies of [
      [assignment, no(), done],
      [assignment, done, no('赤い帽子')],
    ]) {
      expect(issues(check(bodies, 'done'))).toEqual([]);
      expect(issues(check(bodies, 'accepted'))).toContainEqual(
        expect.objectContaining({ kind: 'violation' }),
      );
    }
  });
  it('事象の列が不完全な時は違反と断定しない', () => {
    expect(issues(check([assignment, done, no()], 'done', true))).toEqual([]);
  });
  it('読み取りの作用で答えが変わり得る時は、家族の答えだけで断定しない', () => {
    const source = {
      type: 'modelOutputRecorded',
      call: 'extract',
      model: 'm',
      promptVersion: 'v',
      inputHash: 'h',
      sourceId: 's',
      output: {
        sourceId: 's',
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        items: [
          {
            id: 's:i',
            sourceId: 's',
            sentenceIds: ['s#1'],
            kind: 'event',
            written: '知らせ',
            interpretation: { what: '知らせ' },
            evidence: 'stated',
            effects: [{ type: 'resolveUnknown', unknownId, value: 'yes' }],
          },
        ],
      },
    };
    for (const commitment of ['accepted', 'done']) {
      const report = check([assignment, done, no(), source], commitment);
      expect(issues(report)).toEqual([]);
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: 'commitment_state_unknown',
          kind: 'undetermined',
        }),
      );
    }
  });
});
