// 家族の言明は読み取りとは別に、出典と本人を事象から確かめる。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement } from './fixtures';

const source = (sender = 'family') => ({
  id: 'source-1',
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender,
  language: 'ja',
  sentences: [{ id: 'sentence-1', text: '架空の予定を整える。' }],
});

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'item-1',
  sourceId: 'source-1',
  sentenceIds: ['sentence-1'],
  kind: 'need',
  written: '架空の予定を整える。',
  interpretation: { what: '予定を整える', shape: 'by', deadline: '2026-12-07T18:00+09:00' },
  evidence: 'stated',
  effects: [],
  ...overrides,
});

const initial = (
  changes: { actorId?: string; sender?: string; item?: Record<string, unknown> } = {},
) => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source: source(changes.sender) }),
  event(3, {
    type: 'itemsStated',
    sourceId: 'source-1',
    items: [item(changes.item)],
    actorId: changes.actorId ?? 'a',
  }),
];

const check = (events: unknown[], throughSeq: number) =>
  verifyPlan({
    household: household(),
    events,
    plan: plan({
      throughSeq,
      requirements: [
        requirement({ kind: 'need', what: '予定を整える', basis: { itemIds: ['item-1'] } }),
      ],
    }),
  });

const codes = (report: ReturnType<typeof verifyPlan>, kind: 'violation' | 'undetermined') =>
  report.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('家族のすることの言明', () => {
  it('有効な大人の言明を、モデルの読み取りなしで要件の根拠にたどる', () => {
    const result = check(initial(), 3);
    expect(codes(result, 'violation')).toEqual([]);
    expect(codes(result, 'undetermined')).not.toContain('basis_item_missing');
    expect(codes(result, 'undetermined')).not.toContain('source_missing');
  });

  it('その時の有効な大人以外の言明を根拠にしない', () => {
    for (const actorId of ['system', 'helper', 'absent']) {
      const result = check(initial({ actorId }), 3);
      expect(codes(result, 'violation')).toContain('family_event_actor_invalid');
      expect(codes(result, 'undetermined')).toContain('basis_item_missing');
    }
  });

  it('家族以外の出典や別出典の事項を家族の言明にしない', () => {
    const wrongSender = check(initial({ sender: 'school' }), 3);
    expect(codes(wrongSender, 'violation')).toContain('stated_source_invalid');
    expect(codes(wrongSender, 'undetermined')).toContain('basis_item_missing');

    const wrongSource = check(initial({ item: { sourceId: 'other-source' } }), 3);
    expect(codes(wrongSource, 'violation')).toContain('item_source_mismatch');
    expect(codes(wrongSource, 'undetermined')).toContain('basis_item_missing');
  });

  it('言明ではない証拠を言明として扱わない', () => {
    const result = check(initial({ item: { evidence: 'inferred' } }), 3);
    expect(codes(result, 'violation')).toContain('stated_item_evidence_invalid');
    expect(codes(result, 'undetermined')).toContain('basis_item_missing');
  });

  it('取り下げ後は要件の根拠にできず、消した後は内容を持ち越さない', () => {
    const withdrawn = check(
      [...initial(), event(4, { type: 'sourceWithdrawn', sourceId: 'source-1' })],
      4,
    );
    expect(codes(withdrawn, 'violation')).toContain('inactive_item_basis');

    const purged = check(
      [
        ...initial(),
        event(4, {
          type: 'sourceContentPurged',
          sourceId: 'source-1',
          scope: 'all',
          actorId: 'system',
        }),
      ],
      4,
    );
    expect(codes(purged, 'undetermined')).toContain('basis_item_missing');
    expect(JSON.stringify(purged)).not.toContain('架空の予定');
  });

  it('やり方の選びも有効な大人と、その時までの事項を確かめる', () => {
    const choice = { type: 'needWaysSet', itemId: 'item-1', wayIds: [], about: 'fixture' };
    const valid = check([...initial(), event(4, choice)], 4);
    expect(codes(valid, 'undetermined')).not.toContain('item_action_target_unverified');
    const missing = check([...initial(), event(4, { ...choice, itemId: 'missing' })], 4);
    expect(codes(missing, 'undetermined')).toContain('item_action_target_unverified');
    const helper = check([...initial(), event(4, { ...choice, actorId: 'helper' })], 4);
    expect(codes(helper, 'violation')).toContain('family_event_actor_invalid');
    const unknownWay = check([...initial(), event(4, { ...choice, wayIds: ['missing'] })], 4);
    expect(codes(unknownWay, 'violation')).toContain('need_way_unknown');
    const wrongKind = check([...initial({ item: { kind: 'duty' } }), event(4, choice)], 4);
    expect(codes(wrongKind, 'violation')).toContain('need_choice_target_invalid');
  });

  it('受益者は原文の対象とは別に、家庭の成員であることを確かめる', () => {
    const interpretation = {
      what: '予定を整える',
      shape: 'by',
      deadline: '2026-12-07T18:00+09:00',
    };
    const valid = check(
      initial({ item: { interpretation: { ...interpretation, forMemberId: 'a' } } }),
      3,
    );
    expect(codes(valid, 'violation')).not.toContain('need_member_unknown');
    const wrong = check(
      initial({ item: { interpretation: { ...interpretation, forMemberId: 'absent' } } }),
      3,
    );
    expect(codes(wrong, 'violation')).toContain('need_member_unknown');
  });
});
