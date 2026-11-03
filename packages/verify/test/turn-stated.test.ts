// 当番の帰属の言明は、家族と対象を確かめ、読み取りの確かさやお知らせの作用とは分ける。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement, task } from './fixtures';

const source = (id: string) => ({
  id,
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'school',
  language: 'ja',
  sentences: [{ id: `${id}#1`, text: '架空のお茶当番のお知らせ' }],
});

const duty = (id: string, sourceId: string, evidence = 'stated', effects: unknown[] = []) => ({
  id,
  sourceId,
  sentenceIds: [`${sourceId}#1`],
  kind: 'duty',
  written: 'お茶当番',
  interpretation: { what: 'お茶当番', audience: 'さくらさん', familyAction: true },
  evidence,
  effects,
});

const reading = (sourceId: string, items: unknown[]) => ({
  type: 'modelOutputRecorded',
  call: 'extract',
  model: 'fixture',
  promptVersion: 'fixture',
  inputHash: 'fixture',
  sourceId,
  output: { sourceId, items, unknowns: [], conditions: [], irrelevantSentenceIds: [] },
});

const statement = (itemId: string, ours: boolean, actorId = 'a') => ({
  type: 'turnStated',
  itemId,
  ours,
  what: 'お茶当番',
  audience: 'さくらさん',
  actorId,
});

const initial = (evidence = 'stated') => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source: source('n1') }),
  event(3, reading('n1', [duty('i1', 'n1', evidence)])),
];

const check = (events: unknown[], seq: number, basisId?: string) =>
  verifyPlan({
    household: household(),
    events,
    plan: plan({
      throughSeq: seq,
      requirements: basisId
        ? [
            requirement({
              kind: 'attendance',
              what: 'お茶当番',
              basis: { itemIds: [basisId] },
            }),
          ]
        : [],
    }),
  });

const codes = (report: ReturnType<typeof verifyPlan>, kind: 'violation' | 'undetermined') =>
  report.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('当番の帰属の言明', () => {
  it('有効な大人の言明と、読み取りの中にある対象を確認する', () => {
    const valid = check([...initial(), event(4, statement('i1', true))], 4);
    expect(codes(valid, 'violation')).not.toContain('family_event_actor_invalid');
    expect(codes(valid, 'undetermined')).not.toContain('item_action_target_unverified');

    for (const actorId of ['system', 'helper', 'absent']) {
      const invalid = check([...initial(), event(4, statement('i1', false, actorId))], 4, 'i1');
      expect(codes(invalid, 'violation')).toContain('family_event_actor_invalid');
      expect(codes(invalid, 'violation')).not.toContain('duty_turn_conflict');
    }
  });

  it('まだ読み取りにない事項への言明は、後で読み取っても対象を確認できない', () => {
    const unknown = check([...initial(), event(4, statement('missing', false))], 4);
    expect(codes(unknown, 'undetermined')).toContain('item_action_target_unverified');

    const early = check(
      [
        event(1, { type: 'householdSet', household: household() }),
        event(2, statement('i1', false)),
        event(3, { type: 'noticeReceived', source: source('n1') }),
        event(4, reading('n1', [duty('i1', 'n1')])),
      ],
      4,
      'i1',
    );
    expect(codes(early, 'undetermined')).toContain('item_action_target_unverified');
    expect(codes(early, 'violation')).not.toContain('duty_turn_conflict');
  });

  it('うちの番という言明だけでは推定を確認済みにしない', () => {
    const events = [...initial('inferred'), event(4, statement('i1', true))];
    expect(codes(check(events, 4, 'i1'), 'violation')).toContain('unconfirmed_required_item');

    const confirmed = [...events, event(5, { type: 'itemConfirmed', itemId: 'i1' })];
    expect(codes(check(confirmed, 5, 'i1'), 'violation')).not.toContain(
      'unconfirmed_required_item',
    );
  });

  it('うちの番ではないという言明で、前の事項を置き換える作用を消さない', () => {
    const events = [
      ...initial(),
      event(4, { type: 'noticeReceived', source: source('n2') }),
      event(5, reading('n2', [duty('i2', 'n2', 'stated', [{ type: 'replace', itemId: 'i1' }])])),
      event(6, statement('i2', false)),
    ];
    expect(codes(check(events, 6, 'i1'), 'violation')).toContain('inactive_item_basis');
    expect(codes(check(events, 6, 'i2'), 'violation')).not.toContain('inactive_item_basis');
  });

  it('今も同じ用件と対象への最後の否定に、必須の当番を作る計画が食い違えば見つける', () => {
    const denied = [...initial(), event(4, statement('i1', false))];
    expect(codes(check(denied, 4, 'i1'), 'violation')).toContain('duty_turn_conflict');

    const reclaimed = [...denied, event(5, statement('i1', true))];
    expect(codes(check(reclaimed, 5, 'i1'), 'violation')).not.toContain('duty_turn_conflict');

    const another = [
      ...denied,
      event(5, { type: 'itemCorrected', itemId: 'i1', interpretation: { audience: 'みおさん' } }),
    ];
    expect(codes(check(another, 5, 'i1'), 'violation')).not.toContain('duty_turn_conflict');

    const incomplete = [...initial(), event(5, statement('i1', false))];
    const report = check(incomplete, 5, 'i1');
    expect(codes(report, 'violation')).not.toContain('duty_turn_conflict');
    expect(codes(report, 'undetermined')).toContain('duty_turn_unverified');
  });

  it('複数の事項に基づく要件は、一つの否定だけで違反と決めない', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('n1') }),
      event(3, reading('n1', [duty('i1', 'n1'), duty('i2', 'n1')])),
      event(4, statement('i1', false)),
    ];
    const report = verifyPlan({
      household: household(),
      events,
      plan: plan({
        throughSeq: 4,
        requirements: [
          requirement({
            kind: 'attendance',
            what: 'お茶当番',
            basis: { itemIds: ['i1', 'i2'] },
          }),
        ],
      }),
    });
    expect(codes(report, 'violation')).not.toContain('duty_turn_conflict');
  });

  it('要件が無くても、否定された当番を作業だけに残せない', () => {
    const report = verifyPlan({
      household: household(),
      events: [...initial(), event(4, statement('i1', false))],
      plan: plan({
        throughSeq: 4,
        tasks: [
          task('task:duty:i1', {
            titleKey: 'task.duty',
            titleParams: { what: 'お茶当番' },
            basis: { itemIds: ['i1'] },
          }),
        ],
      }),
    });
    expect(codes(report, 'violation')).toContain('duty_turn_conflict');
  });
});
