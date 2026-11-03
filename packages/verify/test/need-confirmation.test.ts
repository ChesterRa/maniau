// モデルが読んだ事項の確かめを、計画の旗や求解器ではなく事象から独立に照らす。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { collectFacts } from '../src/facts';
import { Collector } from '../src/report';
import { arrangement, event, household, plan, requirement, task } from './fixtures';

const SOURCE = 'source-1';
const ITEM = 'source-1:i1';
const DAY = '2026-12-07T08:00+09:00';
const END = '2026-12-07T23:59+09:00';
const current = (deadline = DAY) => ({
  id: ITEM,
  sourceId: SOURCE,
  sentenceIds: [`${SOURCE}#1`],
  kind: 'need',
  written: '12月7日までに申し込む。',
  interpretation: { what: '申し込み', shape: 'by', deadline, deadlineDayOnly: true },
  evidence: 'stated',
  effects: [] as Array<Record<string, unknown>>,
});
const source = (sender = 'school') => ({
  id: SOURCE,
  version: 1,
  receivedAt: '2026-11-30T10:00+09:00',
  sender,
  language: 'ja',
  sentences: [{ id: `${SOURCE}#1`, text: '12月7日までに申し込む。' }],
});
const read = (seq: number, item = current(), version = 1) =>
  event(seq, {
    type: 'modelOutputRecorded',
    actorId: 'system',
    call: 'extract',
    sourceId: SOURCE,
    sourceVersion: version,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    output: {
      sourceId: SOURCE,
      items: [item],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
  });
const model = (sender = 'school') => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source: source(sender) }),
  read(3),
];
const pending = (extra: Record<string, unknown> = {}) =>
  requirement({
    kind: 'need',
    what: '申し込み',
    basis: { itemIds: [ITEM] },
    unconfirmed: true,
    ...extra,
  });
const shapedPlan = (throughSeq: number, overrides: Record<string, unknown> = {}) =>
  plan({
    throughSeq,
    requirements: [pending()],
    ...overrides,
  });
const report = (events: ReturnType<typeof model>, p = shapedPlan(events.at(-1)?.seq ?? 0)) =>
  verifyPlan({ household: household(), events, plan: p });
const violations = (r: ReturnType<typeof verifyPlan>) =>
  r.issues.filter((i) => i.kind === 'violation').map((i) => i.code);
const codes = (r: ReturnType<typeof verifyPlan>) => r.issues.map((i) => i.code);
const arrangementForNeed = () =>
  arrangement({ kind: 'need', needShape: 'by', end: END, status: 'undetermined', options: [] });

describe('通用のすることの読み取りの確かめ', () => {
  it('確かめる前は要件を残すが確定日時・手配・作業を出さない', () => {
    const events = model();
    expect(violations(report(events))).toEqual([]);
    expect(violations(report(events, shapedPlan(3, { requirements: [] })))).toContain(
      'need_confirmation_missing',
    );
    const incorrect = shapedPlan(3, {
      requirements: [pending({ unconfirmed: undefined, by: END, date: '2026-12-07' })],
      arrangements: [arrangementForNeed()],
      tasks: [
        task('invented', {
          basis: { itemIds: [ITEM], requirementKey: 'requirement', arrangementKey: 'arrangement' },
        }),
      ],
    });
    expect(violations(report(events, incorrect))).toEqual(
      expect.arrayContaining([
        'need_unconfirmed_requirement_mismatch',
        'need_unconfirmed_arrangement',
        'need_unconfirmed_task',
      ]),
    );
    expect(
      violations(report(events, shapedPlan(3, { requirements: [pending({ live: false })] }))),
    ).not.toContain('need_unconfirmed_requirement_mismatch');
  });
  it('送り手が家族でもモデルの読み取りは確認が必要、itemsStated の家族の言明は不要', () => {
    const readByModel = model('family');
    const declared = shapedPlan(3, {
      requirements: [pending({ unconfirmed: undefined, by: END })],
      arrangements: [arrangementForNeed()],
    });
    expect(violations(report(readByModel, declared))).toContain('need_unconfirmed_arrangement');
    const stated = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: source('family') }),
      event(3, { type: 'itemsStated', sourceId: SOURCE, items: [current()] }),
    ];
    expect(violations(report(stated, declared))).not.toContain('need_unconfirmed_arrangement');
  });
  it('現在採用中の読み取りへの確認または訂正を認める', () => {
    for (const e of [
      event(4, { type: 'itemConfirmed', itemId: ITEM }),
      event(4, { type: 'itemCorrected', itemId: ITEM, interpretation: { what: '申し込み' } }),
    ]) {
      const events = [...model(), e];
      const p = shapedPlan(4, {
        requirements: [pending({ unconfirmed: undefined, by: END })],
        arrangements: [arrangementForNeed()],
      });
      expect(violations(report(events, p))).not.toContain('need_unconfirmed_arrangement');
    }
  });
  it('確認・訂正・排除後、同じ ID の新しい読み取りには前の言明を当てない', () => {
    for (const e of [
      event(4, { type: 'itemConfirmed', itemId: ITEM }),
      event(4, {
        type: 'itemCorrected',
        itemId: ITEM,
        interpretation: { deadline: '2026-12-06T08:00+09:00' },
      }),
      event(4, { type: 'itemDismissed', itemId: ITEM, reason: 'misread' }),
    ]) {
      const events = [...model(), e, read(5)];
      const facts = collectFacts(
        events.map((e) => DomainEvent.parse(e)),
        new Collector(),
      );
      expect(facts.needConfirmation.get(ITEM)).toBe('pending');
      expect(facts.items.get(ITEM)?.interpretation.deadline).toBe(DAY);
      expect(violations(report(events, shapedPlan(5, { requirements: [] })))).toContain(
        'need_confirmation_missing',
      );
    }
  });
  it('採用されなかった古い版の読み取りは確認を無効にしない', () => {
    const events = [
      ...model(),
      event(4, {
        type: 'transcriptionCorrected',
        sourceId: SOURCE,
        sourceVersion: 2,
        sentences: source().sentences,
      }),
      read(5, current(), 2),
      event(6, { type: 'itemConfirmed', itemId: ITEM }),
      read(7, current(), 1),
    ];
    const facts = collectFacts(
      events.map((e) => DomainEvent.parse(e)),
      new Collector(),
    );
    expect(facts.sourceReadingSeq.get(SOURCE)).toBe(5);
    expect(facts.needConfirmation.get(ITEM)).toBe('confirmed');
    const p = shapedPlan(7, {
      requirements: [pending({ unconfirmed: undefined, by: END })],
      arrangements: [arrangementForNeed()],
    });
    expect(violations(report(events, p))).not.toContain('need_unconfirmed_arrangement');
  });
  it('文を直して読み直す前の新しい確認・訂正・排除は古い事項に当てない', () => {
    const changed = [
      ...model(),
      event(4, {
        type: 'transcriptionCorrected',
        sourceId: SOURCE,
        sourceVersion: 2,
        sentences: [{ id: `${SOURCE}#1`, text: '12月3日までに申し込む。' }],
      }),
    ];
    for (const stated of [
      event(5, { type: 'itemConfirmed', itemId: ITEM }),
      event(5, { type: 'itemCorrected', itemId: ITEM, interpretation: { what: '申込' } }),
      event(5, { type: 'itemDismissed', itemId: ITEM, reason: 'misread' }),
    ]) {
      const events = [...changed, stated];
      expect(violations(report(events, shapedPlan(5)))).toContain('need_stale_confirmation');
    }
    const before = [
      ...model(),
      event(4, { type: 'itemConfirmed', itemId: ITEM }),
      event(5, {
        type: 'transcriptionCorrected',
        sourceId: SOURCE,
        sourceVersion: 2,
        sentences: [{ id: `${SOURCE}#1`, text: '12月3日までに申し込む。' }],
      }),
    ];
    expect(violations(report(before, shapedPlan(5)))).not.toContain('need_stale_confirmation');
  });
  it('読み取り自体に confirmed と書かれても、家族の確認事象にはならない', () => {
    const e = model();
    e[2] = read(3, { ...current(), evidence: 'confirmed' });
    expect(violations(report(e, shapedPlan(3, { requirements: [] })))).toContain(
      'need_confirmation_missing',
    );
  });
  it('事象列が欠けている時は確認が無かったと決めつけない', () => {
    const events = model().slice(1);
    const r = report(events, shapedPlan(3, { requirements: [] }));
    expect(violations(r)).not.toContain('need_confirmation_missing');
    expect(codes(r)).toContain('need_confirmation_unverified');
  });
  it('出典を取り下げた、または確かな別の事項に取り消された読み取りは確認を求めない', () => {
    const withdrawn = [...model(), event(4, { type: 'sourceWithdrawn', sourceId: SOURCE })];
    expect(violations(report(withdrawn, shapedPlan(4, { requirements: [] })))).not.toContain(
      'need_confirmation_missing',
    );
    const other = {
      ...source(),
      id: 'source-2',
      sentences: [{ id: 'source-2#1', text: '申し込みは取りやめです。' }],
    };
    const cancelled = [
      ...model(),
      event(4, { type: 'noticeReceived', source: other }),
      event(5, {
        type: 'modelOutputRecorded',
        actorId: 'system',
        call: 'extract',
        sourceId: 'source-2',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'source-2',
          items: [
            {
              id: 'source-2:i1',
              sourceId: 'source-2',
              sentenceIds: ['source-2#1'],
              kind: 'deadline',
              written: '申し込みは取りやめです。',
              interpretation: {},
              evidence: 'stated',
              effects: [{ type: 'cancel', itemId: ITEM }],
            },
          ],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }),
    ];
    expect(violations(report(cancelled, shapedPlan(5, { requirements: [] })))).not.toContain(
      'need_confirmation_missing',
    );
  });
  it('未確認の読み取りの作用で以前の答えを確定して上書きせず、確認後は作用を数える', () => {
    const first = {
      ...source(),
      id: 'source-0',
      sentences: [{ id: 'source-0#1', text: '参加の状態。' }],
    };
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source: first }),
      event(3, {
        type: 'modelOutputRecorded',
        actorId: 'system',
        call: 'extract',
        sourceId: 'source-0',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'source-0',
          items: [],
          unknowns: [
            { id: 'unknown-1', label: '参加するか', values: ['yes', 'no'], kind: 'other' },
          ],
          conditions: [],
          irrelevantSentenceIds: ['source-0#1'],
          ambiguities: [],
        },
      }),
      event(4, { type: 'answered', unknownId: 'unknown-1', value: 'yes' }),
      event(5, { type: 'noticeReceived', source: source() }),
      read(6, {
        ...current(),
        effects: [{ type: 'resolveUnknown', unknownId: 'unknown-1', value: 'no' }],
      }),
    ];
    const pendingFacts = collectFacts(
      events.map((e) => DomainEvent.parse(e)),
      new Collector(),
    );
    expect(pendingFacts.resolvedValues.has('unknown-1')).toBe(false);
    const confirmedFacts = collectFacts(
      [...events, event(7, { type: 'itemConfirmed', itemId: ITEM })].map((e) =>
        DomainEvent.parse(e),
      ),
      new Collector(),
    );
    expect(confirmedFacts.resolvedValues.get('unknown-1')).toBe('no');
  });
});
