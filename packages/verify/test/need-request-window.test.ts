// 締切型の手配開始は現在時刻であり、受け持ち窓ではない。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { matchesArrangementDay } from '../src/time';
import { event, household, arrangement as makeArrangement, plan, requirement } from './fixtures';

const arrangement = {
  kind: 'need',
  start: '2026-12-07T08:00+09:00',
  end: '2026-12-07T10:00+09:00',
};
const window = { start: '2026-12-07T08:00+09:00', end: '2026-12-07T10:00+09:00' };

function checkRequest(
  shape: 'by' | 'window',
  sentWindow?: typeof window,
  correction?: Record<string, unknown>,
  needsCheck = false,
) {
  const home = household();
  const basis = {
    itemIds: ['item-1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
  };
  const interpretation =
    shape === 'window'
      ? { what: '架空の用件', shape, date: '2026-12-07', startTime: '08:00', endTime: '10:00' }
      : { what: '架空の用件', shape, deadline: '2026-12-07T18:00+09:00' };
  const events = [
    event(1, { type: 'householdSet', household: home }),
    event(2, {
      type: 'noticeReceived',
      source: {
        id: 'source-1',
        version: 1,
        receivedAt: '2026-11-30T10:00+09:00',
        sender: 'family',
        language: 'ja',
        sentences: [{ id: 'sentence-1', text: '架空の用件' }],
      },
    }),
    event(3, {
      type: 'itemsStated',
      sourceId: 'source-1',
      items: [
        {
          id: 'item-1',
          sourceId: 'source-1',
          sentenceIds: ['sentence-1'],
          kind: 'need',
          written: '架空の用件',
          interpretation,
          evidence: 'stated',
          effects: [],
        },
      ],
    }),
    event(4, { type: 'assignmentProposed', taskKey: 'send', assigneeId: 'a' }),
    event(5, {
      type: 'externalRequestSent',
      taskKey: 'send',
      requestId: 'request-1',
      snapshot: {
        to: 'helper',
        kind: 'reply',
        basis,
        ...(sentWindow ? { window: sentWindow } : {}),
      },
    }),
    event(6, { type: 'externalReplyRecorded', requestId: 'request-1', reply: 'yes' }),
  ];
  if (correction)
    events.push(event(7, { type: 'itemCorrected', itemId: 'item-1', interpretation: correction }));
  return verifyPlan({
    household: home,
    events,
    plan: plan({
      throughSeq: events.length,
      requirements: [
        requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item-1'] } }),
      ],
      arrangements: [makeArrangement({ ...arrangement })],
      requests: [
        {
          requestId: 'request-1',
          taskKey: 'send',
          to: 'helper',
          kind: 'reply',
          sentAt: '2026-11-30T10:00+09:00',
          sentBy: 'a',
          state: 'confirmed',
          basis,
          live: true,
          ...(sentWindow ? { window: sentWindow } : {}),
          ...(needsCheck ? { needsCheck: true } : {}),
        },
      ],
    }),
  });
}

describe('通用の依頼の窓', () => {
  it('同じ日だけでなく、窓全体の一致を確かめる', () => {
    expect(matchesArrangementDay(window, arrangement, 'Asia/Tokyo', 'window')).toBe(true);
    expect(
      matchesArrangementDay(
        { ...window, end: '2026-12-07T09:00+09:00' },
        arrangement,
        'Asia/Tokyo',
        'window',
      ),
    ).toBe(false);
    expect(matchesArrangementDay(undefined, arrangement, 'Asia/Tokyo', 'window')).toBeUndefined();
  });

  it('締切型の窓なしを、現在時刻と照らさない', () => {
    expect(matchesArrangementDay(undefined, arrangement, 'Asia/Tokyo', 'by')).toBe(true);
    expect(matchesArrangementDay(window, arrangement, 'Asia/Tokyo', 'by')).toBeUndefined();
  });

  it('形の根拠が無ければ一致を決めない', () => {
    expect(matchesArrangementDay(window, arrangement, 'Asia/Tokyo')).toBeUndefined();
    expect(matchesArrangementDay(undefined, arrangement, 'Asia/Tokyo')).toBeUndefined();
  });

  it('送った窓と今の窓が違えば、確認なしの依頼として扱わない', () => {
    const valid = checkRequest('window', window);
    expect(valid.issues.map((issue) => issue.code)).not.toContain('request_uncertainty_unmarked');
    const shortened = checkRequest('window', { ...window, end: '2026-12-07T09:00+09:00' });
    expect(shortened.issues.map((issue) => issue.code)).toContain('request_uncertainty_unmarked');
  });

  it('締切型の窓なしの送信は、窓が欠けた子の居場所の依頼と混同しない', () => {
    const result = checkRequest('by');
    expect(result.issues.map((issue) => issue.code)).not.toContain('request_window_unverified');
    expect(result.issues.map((issue) => issue.code)).not.toContain('request_uncertainty_unmarked');
  });

  it('締切型でも、送信後に用件や対象が変われば以前の返事をそのまま使わない', () => {
    for (const correction of [{ what: '別の用件' }, { forMemberId: 'b' }]) {
      const changed = checkRequest('by', undefined, correction);
      expect(changed.issues.map((issue) => issue.code)).toContain('request_uncertainty_unmarked');
      const checked = checkRequest('by', undefined, correction, true);
      expect(checked.issues.map((issue) => issue.code)).not.toContain(
        'request_uncertainty_unmarked',
      );
    }
  });
});
