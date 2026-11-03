// 確認の依存は、計画の印や求解器の控えではなく、採用された読み取りと家族の事象からたどる。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { collectFacts } from '../src/facts';
import { Collector } from '../src/report';
import { event, household, plan, requirement } from './fixtures';

const A = 'previous';
const B = 'current';
const ITEM = `${B}:i1`;
const source = (id: string) => ({
  id,
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender: 'school',
  language: 'ja',
  sentences: [{ id: `${id}#1`, text: '架空のお知らせ。' }],
});
const readA = (seq: number, label = '行事が開催されるか', version = 1) =>
  event(seq, {
    type: 'modelOutputRecorded',
    actorId: 'system',
    call: 'extract',
    sourceId: A,
    sourceVersion: version,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    output: {
      sourceId: A,
      items: [
        {
          id: `${A}:i1`,
          sourceId: A,
          sentenceIds: [`${A}#1`],
          kind: 'event',
          written: '架空のお知らせ。',
          interpretation: { what: label, date: '2026-12-07' },
          evidence: 'stated',
          effects: [],
        },
      ],
      unknowns: [{ id: `${A}:u1`, label, values: ['yes', 'no'], kind: 'schedule' }],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
  });
type Reference = 'condition' | 'answer' | 'cancel' | 'replace';
const readB = (
  seq: number,
  reference: Reference,
  target = `${A}:i1`,
  nodes?: Record<string, unknown>[],
) =>
  event(seq, {
    type: 'modelOutputRecorded',
    actorId: 'system',
    call: 'extract',
    sourceId: B,
    sourceVersion: 1,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    output: {
      sourceId: B,
      items: [
        {
          id: ITEM,
          sourceId: B,
          sentenceIds: [`${B}#1`],
          kind: 'need',
          written: '架空のお知らせ。',
          interpretation: {
            what: '申し込み',
            shape: 'by',
            deadline: '2026-12-07T08:00+09:00',
            deadlineDayOnly: true,
          },
          evidence: 'stated',
          ...(reference === 'condition' ? { conditionNodeId: `${B}:c1` } : {}),
          effects:
            reference === 'answer'
              ? [{ type: 'resolveUnknown', unknownId: `${A}:u1`, value: 'yes' }]
              : reference === 'cancel' || reference === 'replace'
                ? [{ type: reference, itemId: target }]
                : [],
        },
      ],
      unknowns: [],
      conditions:
        nodes ??
        (reference === 'condition'
          ? [{ id: `${B}:c1`, kind: 'eq', unknownId: `${A}:u1`, value: 'yes' }]
          : []),
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
  });
const start = (reference: Reference = 'condition') => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source: source(A) }),
  readA(3),
  event(4, { type: 'noticeReceived', source: source(B) }),
  readB(5, reference),
];
const facts = (events: ReturnType<typeof event>[]) =>
  collectFacts(
    events.map((entry) => DomainEvent.parse(entry)),
    new Collector(),
  );
const status = (events: ReturnType<typeof event>[]) => facts(events).needConfirmation.get(ITEM);
const confirmed = (reference: Reference = 'condition') => [
  ...start(reference),
  event(6, { type: 'itemConfirmed', itemId: ITEM }),
];

describe('確認した読み取りの参照先', () => {
  it.each(['condition', 'answer', 'cancel', 'replace'] as const)(
    '%s の参照先が読み直されれば、前の確認を使わない',
    (reference) => {
      const events = confirmed(reference);
      expect(status(events)).toBe('confirmed');
      expect(status([...events, readA(7, '別の行事')])).toBe('pending');
      expect(status([...events, readA(7)])).toBe('pending');
    },
  );
  it('入れ子と共有された条件節点をたどり、参照先の読み直しを見つける', () => {
    const nested = readB(5, 'condition', `${A}:i1`, [
      { id: `${B}:c1`, kind: 'and', childIds: [`${B}:c2`, `${B}:c3`] },
      { id: `${B}:c2`, kind: 'not', childId: `${B}:c4` },
      { id: `${B}:c3`, kind: 'or', childIds: [`${B}:c4`, `${B}:c4`] },
      { id: `${B}:c4`, kind: 'eq', unknownId: `${A}:u1`, value: 'yes' },
    ]);
    const events = [
      ...start().slice(0, 4),
      nested,
      event(6, { type: 'itemConfirmed', itemId: ITEM }),
    ];
    expect(status(events)).toBe('confirmed');
    expect(status([...events, readA(7)])).toBe('pending');
  });
  it('参照先が替われば、前の訂正と確かめた日時を使った計画を検出する', () => {
    const events = [
      ...start(),
      event(6, { type: 'itemCorrected', itemId: ITEM, interpretation: { what: '直した申し込み' } }),
      readA(7, '参加を希望するか'),
    ];
    const reconstructed = facts(events);
    expect(reconstructed.needConfirmation.get(ITEM)).toBe('pending');
    expect(reconstructed.items.get(ITEM)?.interpretation.what).toBe('申し込み');
    const wrong = plan({
      throughSeq: 7,
      requirements: [
        requirement({ kind: 'need', basis: { itemIds: [ITEM] }, by: '2026-12-07T23:59+09:00' }),
      ],
    });
    const result = verifyPlan({ household: household(), events, plan: wrong });
    expect(
      result.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code),
    ).toContain('need_unconfirmed_requirement_mismatch');
  });
  it('同じ参照先への続けての訂正は合わさり、読み直しでどちらも失効する', () => {
    const events = [
      ...start(),
      event(6, { type: 'itemCorrected', itemId: ITEM, interpretation: { what: '直した申し込み' } }),
      event(7, { type: 'itemCorrected', itemId: ITEM, interpretation: { place: '地域窓口' } }),
    ];
    expect(facts(events).items.get(ITEM)?.interpretation).toMatchObject({
      what: '直した申し込み',
      place: '地域窓口',
    });
    const after = facts([...events, readA(8)]);
    expect(after.needConfirmation.get(ITEM)).toBe('pending');
    expect(after.items.get(ITEM)?.interpretation).not.toHaveProperty('place');
    expect(after.items.get(ITEM)?.interpretation.what).toBe('申し込み');
  });
  it('参照先の読み直し後は、以前の排除も新しい読み取りに当てない', () => {
    const events = [
      ...start(),
      event(6, { type: 'itemDismissed', itemId: ITEM, reason: 'misread' }),
    ];
    expect(status(events)).toBe('dismissed');
    expect(status([...events, readA(7)])).toBe('pending');
  });
  it('無関係な出典の読み直しでは確認を失わない', () => {
    const c = 'unrelated';
    const events = [
      ...confirmed(),
      event(7, { type: 'noticeReceived', source: source(c) }),
      event(8, {
        type: 'modelOutputRecorded',
        actorId: 'system',
        call: 'extract',
        sourceId: c,
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: c,
          items: [],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [`${c}#1`],
          ambiguities: [],
        },
      }),
    ];
    expect(status(events)).toBe('confirmed');
  });
  it('採用されなかった古い版の読み取りは依存先を変えない', () => {
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source(A) }),
      readA(3),
      event(4, {
        type: 'transcriptionCorrected',
        sourceId: A,
        sourceVersion: 2,
        sentences: [{ id: `${A}#1`, text: '直した架空のお知らせ。' }],
      }),
      readA(5, '行事が開催されるか', 2),
      event(6, { type: 'noticeReceived', source: source(B) }),
      readB(7, 'condition'),
      event(8, { type: 'itemConfirmed', itemId: ITEM }),
      readA(9),
    ];
    const reconstructed = facts(events);
    expect(reconstructed.sourceReadingSeq.get(A)).toBe(5);
    expect(reconstructed.needConfirmation.get(ITEM)).toBe('confirmed');
  });
  it('参照先の文の訂正は読み直すまで保留し、取り下げ自体も読み直しにしない', () => {
    const events = confirmed();
    expect(
      status([
        ...events,
        event(7, {
          type: 'transcriptionCorrected',
          sourceId: A,
          sourceVersion: 2,
          sentences: [{ id: `${A}#1`, text: '直した架空のお知らせ。' }],
        }),
      ]),
    ).toBe('confirmed');
    expect(status([...events, event(7, { type: 'sourceWithdrawn', sourceId: A })])).toBe(
      'confirmed',
    );
  });
  it('参照先の中身の全削除、または無かった対象が見つかれば、確認し直す', () => {
    expect(
      status([
        ...confirmed(),
        event(7, { type: 'sourceContentPurged', sourceId: A, scope: 'all', actorId: 'system' }),
      ]),
    ).toBe('pending');
    const before = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source(B) }),
      readB(3, 'cancel'),
      event(4, { type: 'itemConfirmed', itemId: ITEM }),
    ];
    expect(status(before)).toBe('confirmed');
    expect(
      status([...before, event(5, { type: 'noticeReceived', source: source(A) }), readA(6)]),
    ).toBe('pending');
  });
});
