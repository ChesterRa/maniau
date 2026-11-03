// 接送の言明は、事項の確かさや、ほかの事項への作用と分けて検査する。
import { type DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { collectFacts } from '../src/facts';
import { Collector } from '../src/report';
import { event, household, plan } from './fixtures';

const family = Household.parse({
  ...household(),
  members: [
    ...household().members,
    { id: 'child', kind: 'child', name: '子', clubEscort: { to: true, from: true } },
  ],
});
const source = {
  id: 'club',
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'club',
  language: 'ja',
  sentences: [{ id: 'club#1', text: '練習試合の日を変更します。' }],
};
const item = (id: string, effects: object[] = []) => ({
  id,
  sourceId: 'club',
  sentenceIds: ['club#1'],
  kind: 'event',
  written: '練習試合の日を変更します。',
  evidence: 'stated',
  interpretation: { what: '練習試合', date: '2026-12-06', startTime: '09:00', place: '公園' },
  effects,
});
const statement = (overrides: Record<string, unknown> = {}) => ({
  type: 'escortStated',
  itemId: 'new',
  leg: 'to',
  needed: false,
  childId: 'child',
  what: '練習試合',
  date: '2026-12-06',
  at: '09:00',
  place: '公園',
  ...overrides,
});
const events = (body: Record<string, unknown> = statement()) => [
  event(1, { type: 'householdSet', household: family }),
  event(2, { type: 'noticeReceived', source }),
  event(3, {
    type: 'modelOutputRecorded',
    call: 'extract',
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    sourceId: 'club',
    sourceVersion: 1,
    output: {
      sourceId: 'club',
      items: [item('old'), item('new', [{ type: 'replace', itemId: 'old' }])],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
  }),
  event(4, body),
];

describe('送り迎えの言明の独立検査', () => {
  it('この回は送らないという言明は、読取の確かさや置き換えを変えない', () => {
    const facts = collectFacts(events() as DomainEvent[], new Collector());
    expect(facts.active.get('old')).toBe(false);
    expect(facts.active.get('new')).toBe(true);
    expect(facts.items.get('new')?.evidence).toBe('stated');
    expect(facts.escorts.get('new:to')).toMatchObject({ needed: false, childId: 'child' });
  });
  it('実在しない事項への言明は、対象を確認できないとする', () => {
    const result = verifyPlan({
      household: family,
      plan: plan({ throughSeq: 4 }),
      events: events(statement({ itemId: 'not-present' })),
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'item_action_target_unverified',
      }),
    );
  });
  it('仕組みは家族の言明を作れない', () => {
    const result = verifyPlan({
      household: family,
      plan: plan({ throughSeq: 4 }),
      events: events({ ...statement(), actorId: 'system' }),
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'family_event_actor_invalid',
      }),
    );
  });
});
