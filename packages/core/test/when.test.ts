// いつにするかの候補への答えの数え（engine/when.ts）を、別に書いた全ての組み合わせの数え上げと照らす。
import { describe, expect, it } from 'vitest';
import {
  type AnswerRecord,
  basisChanges,
  type CountValue,
  countCandidate,
  decisionBasis,
  effectiveAnswer,
  type RecommendInput,
  recommend,
} from '../src/engine/when';

/** 未定の人の yes／no を全部試し、どの完成形でも成り立てば meets、どれでも成り立たなければ cannot。 */
function oracle(
  people: string[],
  required: Set<string>,
  k: number,
  values: Map<string, CountValue>,
): { condition: string; pivotal: string[] } {
  const open = people.filter((p) => (values.get(p) ?? 'unknown') === 'unknown');
  const holds = (assign: Map<string, 'yes' | 'no'>) => {
    const v = (p: string) => assign.get(p) ?? (values.get(p) as 'yes' | 'no');
    return (
      people.filter((p) => v(p) === 'yes').length >= k && [...required].every((p) => v(p) === 'yes')
    );
  };
  const completions: Map<string, 'yes' | 'no'>[] = [];
  for (let mask = 0; mask < 1 << open.length; mask++) {
    completions.push(new Map(open.map((p, i) => [p, mask & (1 << i) ? 'yes' : 'no'])));
  }
  const results = completions.map(holds);
  const condition = results.every(Boolean) ? 'meets' : results.some(Boolean) ? 'open' : 'cannot';
  const pivotal = open.filter((p) =>
    completions.some((c) => {
      const yes = new Map(c).set(p, 'yes');
      const no = new Map(c).set(p, 'no');
      return holds(yes) !== holds(no);
    }),
  );
  return { condition, pivotal };
}

describe('答えの条件と左右する人', () => {
  it('0〜5 人の全ての答え・要る人・最少の人数で、数え上げと同じ', () => {
    let checked = 0;
    const kinds: CountValue[] = ['yes', 'no', 'unknown'];
    for (let n = 0; n <= 5; n++) {
      const people = Array.from({ length: n }, (_, i) => `p${i}`);
      for (let code = 0; code < 3 ** n; code++) {
        const values = new Map<string, CountValue>();
        let rest = code;
        for (const p of people) {
          values.set(p, kinds[rest % 3] as CountValue);
          rest = Math.floor(rest / 3);
        }
        for (let reqMask = 0; reqMask < 1 << n; reqMask++) {
          const required = new Set(people.filter((_, i) => reqMask & (1 << i)));
          for (let k = 0; k <= n + 1; k++) {
            const got = countCandidate({ people, required: [...required], minCount: k, values });
            const want = oracle(people, required, k, values);
            expect(
              got.condition,
              JSON.stringify({ values: [...values], required: [...required], k }),
            ).toBe(want.condition);
            expect([...got.pivotal].sort()).toEqual([...want.pivotal].sort());
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  });

  it('L・U と要る人の内訳', () => {
    const values = new Map<string, CountValue>([
      ['a', 'yes'],
      ['b', 'unknown'],
      ['c', 'no'],
    ]);
    expect(
      countCandidate({ people: ['a', 'b', 'c'], required: ['b'], minCount: 2, values }),
    ).toEqual({
      yes: 1,
      possible: 2,
      requiredNo: [],
      requiredOpen: ['b'],
      condition: 'open',
      pivotal: ['b'],
    });
  });
});

const record = (over: Partial<AnswerRecord> & Pick<AnswerRecord, 'seq' | 'answer' | 'source'>) => ({
  personId: 'g1',
  candidateId: 'c1',
  rev: 1,
  by: over.source === 'family' ? 'a' : over.source === 'link' ? 'link' : 'g1',
  at: '2026-12-01T09:00+09:00',
  ...over,
});

describe('効く答え', () => {
  it('同じ出所の後の記録が前に代わる', () => {
    expect(
      effectiveAnswer([
        record({ seq: 1, answer: 'no', source: 'link' }),
        record({ seq: 2, answer: 'yes', source: 'link' }),
      ])?.value,
    ).toBe('yes');
  });
  it('リンクの取り下げは、自分の画面の答えを消さない（出所ごと）', () => {
    expect(
      effectiveAnswer([
        record({ seq: 1, answer: 'yes', source: 'self' }),
        record({ seq: 2, answer: 'withdrawn', source: 'link' }),
      ])?.value,
    ).toBe('yes');
  });
  it('出所の答えが違えば食い違い（自分の画面とリンクも）', () => {
    expect(
      effectiveAnswer([
        record({ seq: 1, answer: 'yes', source: 'self' }),
        record({ seq: 2, answer: 'no', source: 'link' }),
      ])?.value,
    ).toBe('conflict');
  });
  it('本人側と家族の記録が違えば食い違い（どちらかにしない）', () => {
    const got = effectiveAnswer([
      record({ seq: 1, answer: 'yes', source: 'link' }),
      record({ seq: 2, answer: 'no', source: 'family' }),
    ]);
    expect(got?.value).toBe('conflict');
    expect(got?.sources.map((s) => s.source).sort()).toEqual(['family', 'link']);
  });
  it('取り下げは、その出所だけを未回答に戻す（「いいえ」ではない）', () => {
    expect(
      effectiveAnswer([
        record({ seq: 1, answer: 'yes', source: 'link' }),
        record({ seq: 2, answer: 'withdrawn', source: 'link' }),
      ]),
    ).toBeUndefined();
    expect(
      effectiveAnswer([
        record({ seq: 1, answer: 'yes', source: 'family' }),
        record({ seq: 2, answer: 'no', source: 'link' }),
        record({ seq: 3, answer: 'withdrawn', source: 'link' }),
      ])?.value,
    ).toBe('yes');
  });
  it('たぶんは出所ごとに条件の一言を持ち、未定として数える', () => {
    const got = effectiveAnswer([
      record({ seq: 1, answer: 'maybe', source: 'link', note: '午前なら' }),
      record({ seq: 2, answer: 'maybe', source: 'family', note: '午後なら' }),
    ]);
    expect(got?.value).toBe('maybe');
    expect(got?.sources.map((r) => r.note)).toEqual(['午前なら', '午後なら']);
  });
});

const way = (
  wayId: string,
  deadline: string,
  extra: { usable?: boolean; costUnknown?: true } = {},
) => ({
  wayId,
  usable: extra.usable ?? true,
  decisionDeadline: deadline,
  ...(extra.costUnknown ? { costUnknown: true as const } : {}),
});

describe('勧め', () => {
  const base = (id: string, yes: number, ways: RecommendInput['ways']): RecommendInput => ({
    id,
    condition: 'meets',
    yes,
    ways,
  });
  it('答えの条件を満たし、使えるやり方がある候補が一つだけなら、その数も添えて勧める', () => {
    expect(
      recommend([
        base('c1', 2, [way('w', '2026-12-08T20:00+09:00', { usable: false })]),
        base('c2', 1, [way('w', '2026-12-10T20:00+09:00')]),
        { ...base('c3', 0, [way('w', '2026-12-11T20:00+09:00')]), condition: 'open' },
      ]),
    ).toEqual({ candidateId: 'c2', reason: 'onlyUsable', meetsCount: 2, usableCount: 1 });
  });
  it('一つだけでも、使えるやり方の代償に分からない物があれば勧めない', () => {
    expect(
      recommend([
        base('c1', 2, [
          way('a', '2026-12-08T20:00+09:00'),
          way('b', '2026-12-08T21:00+09:00', { costUnknown: true }),
        ]),
      ]),
    ).toBeUndefined();
  });
  it('同じ一つのやり方で、人数も決め時も劣らず一つは勝る候補を勧める', () => {
    expect(
      recommend([
        base('c1', 3, [way('w', '2026-12-08T20:00+09:00')]),
        base('c2', 2, [way('w', '2026-12-08T19:00+09:00')]),
      ]),
    ).toEqual({ candidateId: 'c1', reason: 'dominates', meetsCount: 2, usableCount: 2 });
  });
  it('人数と決め時が食い違えば勧めない', () => {
    expect(
      recommend([
        base('c1', 3, [way('w', '2026-12-08T19:00+09:00')]),
        base('c2', 2, [way('w', '2026-12-08T20:00+09:00')]),
      ]),
    ).toBeUndefined();
  });
  it('使えるやり方が候補で違う・二つ以上ある時は、代償と決め時を組み合わせず、勧めない', () => {
    expect(
      recommend([
        base('c1', 3, [way('a', '2026-12-08T20:00+09:00')]),
        base('c2', 2, [way('b', '2026-12-08T19:00+09:00')]),
      ]),
    ).toBeUndefined();
    expect(
      recommend([
        base('c1', 3, [way('a', '2026-12-08T10:00+09:00'), way('b', '2026-12-08T20:00+09:00')]),
        base('c2', 3, [way('a', '2026-12-09T19:00+09:00'), way('b', '2026-12-09T19:00+09:00')]),
      ]),
    ).toBeUndefined();
  });
});

describe('決めた時の根拠', () => {
  const basis = (note: string) =>
    decisionBasis({
      people: ['g1'],
      required: [],
      minCount: 1,
      answers: [
        {
          personId: 'g1',
          value: 'maybe',
          sources: [{ source: 'link', answer: 'maybe', note }],
        },
      ],
    });
  it('たぶんの条件の一言が変われば、答えが変わったとする', () => {
    expect(basisChanges(basis('午前なら'), basis('午後なら'))).toEqual(['answers']);
    expect(basisChanges(basis('午前なら'), basis('午前なら'))).toEqual([]);
  });
  it('決め時の無い「使える」やり方は、勧めに数えない', () => {
    expect(
      recommend([{ id: 'c1', condition: 'meets', yes: 1, ways: [{ wayId: 'w', usable: true }] }]),
    ).toBeUndefined();
  });
});
