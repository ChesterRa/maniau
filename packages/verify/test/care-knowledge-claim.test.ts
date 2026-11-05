// 見せる「未確認」と手配の窓が、別に得た根拠からはみ出さないかを照らす。
import { describe, expect, it } from 'vitest';
import { careKnowledge } from '../src/care-knowledge';
import { checkCareKnowledgeClaim } from '../src/care-knowledge-claim';

const h = (n: number) => n * 60;
const span = (a: number, b: number) => ({ start: h(a), end: h(b) });

describe('子の見守りの未確認と手配の主張', () => {
  it('一部の不明を正しく出し、窓を作らないことは違反ではない', () => {
    const proof = careKnowledge([
      { id: 'a', known: [span(9, 12)], unavailable: [] },
      { id: 'b', known: [span(0, 24)], unavailable: [span(9, 13)] },
    ]);
    if (!proof) throw new Error('架空の根拠を読めない');
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['a'],
        unsure: [span(12, 13)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toEqual([]);
    expect(
      checkCareKnowledgeClaim(proof, {
        unsure: [span(12, 13)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toContain('missingAdults');
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['b'],
        unsure: [span(12, 13)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toContain('missingAdults');
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['a'],
        unsure: [],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toContain('unsure');
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['a'],
        unsure: [span(12, 14)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toContain('unsure');
  });

  it('二人とも不能な範囲だけに手配し、残りの不明を表せば違反ではない', () => {
    const proof = careKnowledge([
      { id: 'a', known: [span(0, 24)], unavailable: [span(9, 12)] },
      { id: 'b', known: [], unavailable: [span(10, 11)] },
    ]);
    if (!proof) throw new Error('架空の根拠を読めない');
    const valid = {
      missingAdults: ['b'],
      unsure: [span(9, 10), span(11, 12)],
      arrangements: [span(10, 11)],
      requiresArrangement: true,
    };
    expect(checkCareKnowledgeClaim(proof, valid)).toEqual([]);
    expect(checkCareKnowledgeClaim(proof, { ...valid, arrangements: [span(9, 10)] })).toContain(
      'arrangementOutsideCertain',
    );
    expect(checkCareKnowledgeClaim(proof, { ...valid, arrangements: [span(10, 12)] })).toContain(
      'arrangementOutsideCertain',
    );
    expect(checkCareKnowledgeClaim(proof, { ...valid, arrangements: [] })).toContain(
      'arrangementMissing',
    );
    // 確かな一段の内側でも、その一部だけを手配すれば残りを落としている。
    expect(
      checkCareKnowledgeClaim(proof, {
        ...valid,
        arrangements: [{ start: h(10), end: h(10) + 30 }],
      }),
    ).toContain('arrangementWindowMismatch');
    expect(
      checkCareKnowledgeClaim(proof, { ...valid, arrangements: [span(10, 11), span(10, 11)] }),
    ).toContain('arrangementDuplicate');
    // 元の事項が条件付きなら、手配の有無を違反と断定しない（呼出側で未判定にする）。
    expect(
      checkCareKnowledgeClaim(proof, { ...valid, arrangements: [], requiresArrangement: false }),
    ).toEqual([]);
  });

  it('同じ未確認の区間を分けて示す場合は、端が接していれば同じ範囲', () => {
    const proof = careKnowledge([
      { id: 'a', known: [span(0, 24)], unavailable: [span(9, 12)] },
      { id: 'b', known: [], unavailable: [] },
    ]);
    if (!proof) throw new Error('架空の根拠を読めない');
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['b'],
        unsure: [span(9, 10), span(10, 12)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toEqual([]);
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['b'],
        unsure: [span(9, 10), span(11, 12)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toContain('unsure');
  });

  it('根拠の無い人や時刻を付けない', () => {
    const proof = careKnowledge([{ id: 'a', known: [span(0, 24)], unavailable: [] }]);
    if (!proof) throw new Error('架空の根拠を読めない');
    expect(checkCareKnowledgeClaim(proof, { arrangements: [], requiresArrangement: true })).toEqual(
      [],
    );
    expect(
      checkCareKnowledgeClaim(proof, {
        missingAdults: ['a'],
        unsure: [span(9, 10)],
        arrangements: [],
        requiresArrangement: true,
      }),
    ).toEqual(['missingAdults', 'unsure']);
  });
});
