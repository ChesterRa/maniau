// 候補の決定を独立にたどる時間の見方。計画の時刻だけを根拠にしない。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { needWindows, timedNeedItem } from '../src/need-window';
import { event, plan, requirement } from './fixtures';

const stated = DomainEvent.parse(
  event(1, {
    type: 'itemsStated',
    sourceId: 'source-1',
    items: [
      {
        id: 'item-1',
        sourceId: 'source-1',
        sentenceIds: ['s1'],
        kind: 'need',
        written: '架空の用件',
        interpretation: {
          what: '架空の用件',
          shape: 'window',
          date: '2026-12-09',
          startTime: '13:00',
          endTime: '15:00',
        },
        evidence: 'stated',
        effects: [],
      },
    ],
  }),
);
if (stated.type !== 'itemsStated' || !stated.items[0]) throw new Error('fixture missing');
const item = stated.items[0];
const candidate = { id: 'c1', rev: 1, date: '2026-12-11', startTime: '14:00', endTime: '16:00' };
const put = DomainEvent.parse(
  event(2, {
    type: 'needCandidatesSet',
    itemId: item.id,
    candidates: [
      candidate,
      { id: 'c2', rev: 1, date: '2026-12-12', startTime: '14:00', endTime: '16:00' },
    ],
  }),
);
const oldPlan = plan();

describe('候補のある用件の時間を検証する根拠', () => {
  it('事象から確かめた決定があれば、旧い窓ではなくその日を照らす。事項自体は変えない', () => {
    const original = structuredClone(item);
    const windows = needWindows([stated, put], oldPlan, new Map([[item.id, candidate]]));
    expect(timedNeedItem(item, windows)?.interpretation).toMatchObject({
      date: '2026-12-11',
      startTime: '14:00',
      endTime: '16:00',
    });
    expect(item).toEqual(original);
  });
  it('候補はあるが決定を照らせない時、旧い窓を今の日時として当てない', () => {
    const windows = needWindows([stated, put], oldPlan, new Map());
    const effective = timedNeedItem(item, windows);
    expect(effective?.interpretation.date).toBeUndefined();
    expect(effective?.interpretation.startTime).toBeUndefined();
    expect(effective?.interpretation.endTime).toBeUndefined();
  });
  it('候補の記録と表示がなければ、以前の窓を使う', () => {
    const windows = needWindows([stated], oldPlan, new Map());
    expect(timedNeedItem(item, windows)?.interpretation.date).toBe('2026-12-09');
  });
  it('事象が欠けても計画に候補がある時は、旧い窓へ黙って戻さない', () => {
    const current = plan({
      requirements: [
        requirement({
          kind: 'need',
          basis: { itemIds: [item.id] },
          when: {
            candidates: [],
            people: [],
            required: [],
            minCount: 0,
            answers: [],
            links: [],
            inUse: false,
          },
        }),
      ],
    });
    const windows = needWindows([stated], current, new Map());
    expect(timedNeedItem(item, windows)?.interpretation.date).toBeUndefined();
  });
});
