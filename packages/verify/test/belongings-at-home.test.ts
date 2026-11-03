// 持ち物の「家にある」は、家族の答えとその時に見せた品物から独立に確かめる。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement } from './fixtures';

const unknownId = 'u-atHome:item';
const inspect = (
  answers: { value: string; about?: string }[],
  atHome: 'yes' | 'no',
  incomplete = false,
) => {
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    ...answers.map((answer, n) => event(n + 2, { type: 'answered', unknownId, ...answer })),
  ];
  return verifyPlan({
    household: household(),
    events: incomplete ? events.filter((entry) => entry.seq !== 2) : events,
    plan: plan({
      throughSeq: events.length,
      requirements: [
        requirement({
          kind: 'belongings',
          what: '白い長袖シャツ',
          atHomeUnknownId: unknownId,
          atHome,
        }),
      ],
    }),
  });
};
const issue = (r: ReturnType<typeof inspect>, code: string) =>
  r.issues.filter((i) => i.code === code);

describe('持ち物に示す家族の答え', () => {
  it('最後の答えと一致し、答えた時の品物も同じなら矛盾としない', () => {
    expect(
      issue(
        inspect(
          [
            { value: 'no', about: '白い長袖シャツ' },
            { value: 'yes', about: '白い長袖シャツ' },
          ],
          'yes',
        ),
        'at_home_answer_mismatch',
      ),
    ).toEqual([]);
    expect(issue(inspect([{ value: 'yes' }], 'yes'), 'at_home_answer_mismatch')).toEqual([]);
  });
  it('答えが無い・後から逆の答えがある・別の品物に答えた時は、家にあると決めない', () => {
    for (const r of [
      inspect([], 'yes'),
      inspect(
        [
          { value: 'yes', about: '白い長袖シャツ' },
          { value: 'no', about: '白い長袖シャツ' },
        ],
        'yes',
      ),
      inspect([{ value: 'yes', about: '赤い帽子' }], 'yes'),
    ])
      expect(issue(r, 'at_home_answer_mismatch').some((i) => i.kind === 'violation')).toBe(true);
  });
  it('読み取りの作用が同じ未定値を変え得る時は、家族の答えだけで断定しない', () => {
    const extraction = {
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
          effects: [{ type: 'resolveUnknown', unknownId, value: 'no' }],
        },
      ],
    };
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'answered', unknownId, value: 'yes' }),
      event(3, {
        type: 'modelOutputRecorded',
        call: 'extract',
        model: 'm',
        promptVersion: 'v',
        inputHash: 'h',
        sourceId: 's',
        output: extraction,
      }),
    ];
    const r = verifyPlan({
      household: household(),
      events,
      plan: plan({
        throughSeq: 3,
        requirements: [
          requirement({
            kind: 'belongings',
            what: '白い長袖シャツ',
            atHomeUnknownId: unknownId,
            atHome: 'no',
          }),
        ],
      }),
    });
    expect(issue(r, 'at_home_answer_unverified').some((i) => i.kind === 'undetermined')).toBe(true);
    expect(issue(r, 'at_home_answer_mismatch')).toEqual([]);
  });
  it('答えの識別子を失った時は、見かけの値だけでは確認できない', () => {
    const events = [event(1, { type: 'householdSet', household: household() })];
    const result = verifyPlan({
      household: household(),
      events,
      plan: plan({
        throughSeq: 1,
        requirements: [requirement({ kind: 'belongings', what: '白い長袖シャツ', atHome: 'yes' })],
      }),
    });
    expect(issue(result, 'at_home_answer_unverified').some((i) => i.kind === 'undetermined')).toBe(
      true,
    );
  });
  it('事象が欠けた時は断定せず、未判定とする', () => {
    const r = inspect([{ value: 'no' }, { value: 'yes' }], 'yes', true);
    expect(issue(r, 'at_home_answer_unverified').some((i) => i.kind === 'undetermined')).toBe(true);
    expect(issue(r, 'at_home_answer_mismatch')).toEqual([]);
  });
});
