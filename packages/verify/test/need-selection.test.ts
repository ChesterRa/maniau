// やり方の候補を、家族が選んだ事象とその時の内容から独立に確かめる。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement } from './fixtures';

const family = (name = '手順') =>
  Household.parse({
    ...household(),
    ways: [
      {
        id: 'way-1',
        name: '方法',
        steps: [{ id: 'step-1', name, durationMin: 30, segments: ['home'] }],
        cost: {},
        cancellable: true,
      },
    ],
  });

function check(
  change?:
    | 'recipient'
    | 'way'
    | 'missing'
    | 'invalidAbout'
    | 'differentWay'
    | 'aba'
    | 'abaReselect'
    | 'invalidArray',
) {
  const oldHome = family();
  const currentHome = change === 'way' ? family('別の手順') : oldHome;
  const item = {
    id: 'item-1',
    sourceId: 'source-1',
    sentenceIds: ['sentence-1'],
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
  const about = JSON.stringify({
    need: { ...item.interpretation, condition: 'true' },
    ways: change === 'invalidArray' ? {} : change === 'differentWay' ? [] : oldHome.ways,
  });
  const events = [
    event(1, { type: 'householdSet', household: oldHome }),
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
    event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] }),
  ];
  if (change !== 'missing')
    events.push(
      event(4, {
        type: 'needWaysSet',
        itemId: 'item-1',
        wayIds: change === 'differentWay' || change === 'invalidArray' ? [] : ['way-1'],
        about: change === 'invalidAbout' ? '{}' : about,
      }),
    );
  if (change === 'recipient' || change === 'aba' || change === 'abaReselect')
    events.push(
      event(5, { type: 'itemCorrected', itemId: 'item-1', interpretation: { forMemberId: 'b' } }),
    );
  if (change === 'way') events.push(event(5, { type: 'householdSet', household: currentHome }));
  if (change === 'abaReselect')
    events.push(
      event(6, {
        type: 'needWaysSet',
        itemId: 'item-1',
        wayIds: [],
        about: JSON.stringify({
          need: { ...item.interpretation, forMemberId: 'b', condition: 'true' },
          ways: [],
        }),
      }),
    );
  if (change === 'aba' || change === 'abaReselect')
    events.push(
      event(events.length + 1, {
        type: 'itemCorrected',
        itemId: 'item-1',
        interpretation: { forMemberId: 'a' },
      }),
    );
  return verifyPlan({
    household: currentHome,
    events,
    plan: plan({
      throughSeq: events.length,
      requirements: [
        requirement({
          kind: 'need',
          what: '架空の用件',
          by: '2026-12-07T18:00+09:00',
          basis: { itemIds: ['item-1'] },
        }),
      ],
      arrangements: [
        arrangement({
          kind: 'need',
          needShape: 'by',
          end: '2026-12-07T18:00+09:00',
          options: [option('option-1', { templateId: 'way-1' })],
        }),
      ],
    }),
  });
}

const codes = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('家族が選んだやり方', () => {
  it('家族が同じ内容に選んだやり方を案にできる', () => {
    expect(codes(check())).toEqual([]);
    expect(codes(check())).not.toContain('need_selection_basis_mismatch');
    expect(codes(check())).not.toContain('need_selection_missing');
  });

  it('選んでいない、または別のやり方を案にしない', () => {
    expect(codes(check('missing'))).toContain('need_selection_missing');
    expect(codes(check('differentWay'))).toContain('need_option_not_selected');
  });

  it('選んだ時の控えが事実と違う時は検出する', () => {
    expect(codes(check('invalidAbout'))).toContain('need_selection_basis_mismatch');
    expect(codes(check('invalidArray'))).toContain('need_selection_basis_mismatch');
  });

  it('選んだ後に対象またはやり方が変われば古い選びを当てない', () => {
    expect(codes(check('recipient'))).toContain('need_selection_stale');
    expect(codes(check('way'))).toContain('need_selection_stale');
  });

  it('元の内容に戻り、途中で選び直していなければ最後の選びを使える', () => {
    expect(codes(check('aba'))).not.toContain('need_selection_stale');
    expect(codes(check('aba'))).not.toContain('need_option_not_selected');
  });

  it('別の内容の間に選び直した後は、その最後の選びを照らす', () => {
    expect(codes(check('abaReselect'))).toContain('need_selection_stale');
    expect(codes(check('abaReselect'))).toContain('need_option_not_selected');
  });
});
