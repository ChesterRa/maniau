// 家族による受益者の訂正は、保存した事象から独立にたどる。空にしたことと、直さなかったことを区別する。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { collectFacts } from '../src/facts';
import { Collector } from '../src/report';
import { event, household } from './fixtures';

const item = {
  id: 'source-1:i1',
  sourceId: 'source-1',
  sentenceIds: ['source-1#1'],
  kind: 'need',
  written: '架空の用件',
  interpretation: {
    what: '架空の用件',
    shape: 'by',
    deadline: '2026-12-07T18:00+09:00',
    forMemberId: 'a',
  },
  evidence: 'stated',
  effects: [],
};
const received = event(2, {
  type: 'noticeReceived',
  source: {
    id: 'source-1',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'family',
    language: 'ja',
    sentences: [{ id: 'source-1#1', text: item.written }],
  },
});
const extraction = (seq: number) =>
  event(seq, {
    type: 'modelOutputRecorded',
    actorId: 'system',
    call: 'extract',
    sourceId: 'source-1',
    sourceVersion: 1,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    output: {
      sourceId: 'source-1',
      items: [item],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
  });
const correct = (seq: number, interpretation: Record<string, unknown>) =>
  event(seq, { type: 'itemCorrected', itemId: item.id, interpretation });
const facts = (events: ReturnType<typeof event>[]) =>
  collectFacts(
    events.map((entry) => DomainEvent.parse(entry)),
    new Collector(),
  );
const current = (events: ReturnType<typeof event>[]) => facts(events).items.get(item.id);

describe('「すること」の受益者の訂正', () => {
  it('言明：省略は維持、null は消去し、さらに省略しても戻さず、別の人を選べる', () => {
    const start = [
      event(1, { type: 'householdSet', household: household() }),
      received,
      event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] }),
    ];
    const otherField = [...start, correct(4, { what: '直した用件' })];
    expect(current(otherField)?.interpretation.forMemberId).toBe('a');
    const cleared = [...otherField, correct(5, { forMemberId: null })];
    expect(current(cleared)?.interpretation).not.toHaveProperty('forMemberId');
    const stillCleared = [...cleared, correct(6, { what: 'さらに直した用件' })];
    expect(current(stillCleared)?.interpretation).not.toHaveProperty('forMemberId');
    expect(
      current([...stillCleared, correct(7, { forMemberId: 'b' })])?.interpretation.forMemberId,
    ).toBe('b');
  });

  it('読み取り：消去は同じ読みに結び、読み直したら以前の訂正を重ねない', () => {
    const start = [
      event(1, { type: 'householdSet', household: household() }),
      received,
      extraction(3),
    ];
    const cleared = [...start, correct(4, { forMemberId: null })];
    expect(facts(cleared).needConfirmation.get(item.id)).toBe('confirmed');
    expect(current(cleared)?.interpretation).not.toHaveProperty('forMemberId');
    const reread = [...cleared, extraction(5)];
    expect(facts(reread).needConfirmation.get(item.id)).toBe('pending');
    expect(current(reread)?.interpretation.forMemberId).toBe('a');
    expect(
      current([...reread, correct(6, { forMemberId: null })])?.interpretation,
    ).not.toHaveProperty('forMemberId');
  });
});
