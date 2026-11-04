// 家族が登録したやり方の選びと推薦を、手書きの事象と期待で照らす。求解器は使わない。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement } from './fixtures';

const home = () =>
  Household.parse({
    ...household(),
    ways: ['a', 'b'].map((id) => ({
      id: `way-${id}`,
      name: `方法 ${id}`,
      steps: [{ id: 'ask', name: '尋ねる', durationMin: 5, segments: ['home'] }],
      cost: {},
    })),
  });

const check = (family: ReturnType<typeof home>, entries: unknown[], events: unknown[] = []) =>
  verifyPlan({
    household: family,
    events,
    plan: plan({
      throughSeq: events.length,
      requirements: [requirement({ kind: 'need' })],
      arrangements: [
        arrangement({
          kind: 'need',
          options: entries,
          recommendedOptionKey: (entries[0] as { key?: string } | undefined)?.key,
        }),
      ],
    }),
  });
const codes = (result: ReturnType<typeof verifyPlan>) => result.issues.map((issue) => issue.code);
const available = (id: 'a' | 'b', cost: object = {}) =>
  option(id, {
    templateId: `way-${id}`,
    decisionDeadline: '2026-12-03T18:00+09:00',
    deadlineCertainty: 'estimate',
    cost,
  });

describe('やり方の登録と推薦', () => {
  it('やめた案が開いていれば推薦せず、やめる前の履歴自体は無効にしない', () => {
    const family = home();
    family.stoppedWayIds = ['way-b'];
    const result = check(family, [available('a'), available('b')]);
    expect(codes(result)).toContain('stopped_way_recommended');
    const only = check(family, [available('a')]);
    expect(codes(only)).not.toContain('stopped_way_recommended');
  });

  it('計画の停止印を家庭の記録と照らす', () => {
    const family = home();
    family.stoppedWayIds = ['way-b'];
    expect(codes(check(family, [available('b')]))).toContain('stopped_way_flag_mismatch');
    expect(codes(check(family, [{ ...available('b'), stopped: true }]))).not.toContain(
      'stopped_way_flag_mismatch',
    );
    expect(codes(check(family, [{ ...available('a'), stopped: true }]))).toContain(
      'stopped_way_flag_mismatch',
    );
  });

  it('複数の開いた案で分からない代償をゼロとして比べない', () => {
    const family = home();
    const way = family.ways[1];
    if (!way) throw new Error('やり方が無い');
    way.cost.unknown = ['yen'];
    const both = check(family, [available('a'), available('b', way.cost)]);
    expect(codes(both)).toContain('unknown_cost_recommended');
    const alone = check(family, [available('b', way.cost)]);
    expect(codes(alone)).not.toContain('unknown_cost_recommended');
    const lost = check(family, [available('b')]);
    expect(codes(lost)).toContain('option_cost_mismatch');
  });

  it.each(['missing', 'googlePlaces', 'ambiguous'] as const)(
    '場所の行ける時間が %s なら、確かめた事として勧めない',
    (kind) => {
      const family = home();
      const way = family.ways[0];
      const step = way?.steps[0];
      if (!step) throw new Error('手順が無い');
      step.placeId = 'counter';
      family.places.push({
        id: 'counter',
        kind: 'other',
        name: '架空の窓口',
        goods: [],
        ...(kind === 'missing'
          ? {}
          : {
              hours: {
                source: kind === 'googlePlaces' ? 'googlePlaces' : 'family',
                periods: [{ weekday: 1, open: '09:00', close: '09:00' }],
                closedDates: [],
              },
            }),
      });
      expect(codes(check(family, [available('a')]))).toContain('unverified_hours_recommended');
      if (kind !== 'missing') {
        const place = family.places.find((entry) => entry.id === 'counter');
        if (!place?.hours) throw new Error('場所が無い');
        place.hours.source = 'family';
        place.hours.periods = [{ weekday: 1, open: '09:00', close: '17:00' }];
        expect(codes(check(family, [available('a')]))).not.toContain(
          'unverified_hours_recommended',
        );
      }
    },
  );

  it('最初の登録の後、やり方を有効な大人以外が変更した記録を見つける', () => {
    const before = home();
    const after = structuredClone(before);
    after.stoppedWayIds = ['way-a'];
    const events = [
      event(1, { type: 'householdSet', household: before, actorId: 'system' }),
      event(2, { type: 'householdSet', household: after, actorId: 'helper' }),
    ];
    expect(codes(check(after, [], events))).toContain('way_edit_actor_invalid');
    events[1] = event(2, { type: 'householdSet', household: after, actorId: 'a' });
    expect(codes(check(after, [], events))).not.toContain('way_edit_actor_invalid');
  });

  it('新たに直した分からない代償には、値と重複を置かない', () => {
    const before = home();
    const after = structuredClone(before);
    const way = after.ways[0];
    if (!way) throw new Error('やり方が無い');
    way.cost.yen = 100;
    way.cost.unknown = ['yen', 'yen'];
    const events = [
      event(1, { type: 'householdSet', household: before }),
      event(2, { type: 'householdSet', household: after }),
    ];
    expect(codes(check(after, [], events))).toContain('way_unknown_cost_invalid');
    way.cost.yen = 0;
    way.cost.unknown = ['yen'];
    expect(codes(check(after, [], events))).not.toContain('way_unknown_cost_invalid');
  });

  it('やめた後の新しい選びは拒み、既存の本命の役を替える操作は認める', () => {
    const family = home();
    family.stoppedWayIds = ['way-a'];
    const arrangementKey = 'arr:need:item';
    const optionKey = `opt:${arrangementKey}:way-a`;
    const initial = event(1, { type: 'householdSet', household: family });
    const choice = event(2, { type: 'optionChosen', arrangementKey, optionKey, role: 'primary' });
    expect(codes(check(family, [], [initial, choice]))).toContain('stopped_way_new_option');
    const before = structuredClone(family);
    delete before.stoppedWayIds;
    const events = [
      event(1, { type: 'householdSet', household: before }),
      event(2, { type: 'optionChosen', arrangementKey, optionKey, role: 'primary' }),
      event(3, { type: 'householdSet', household: family }),
      event(4, { type: 'optionChosen', arrangementKey, optionKey, role: 'backup' }),
    ];
    expect(codes(check(family, [], events))).not.toContain('stopped_way_new_option');
  });

  it('やめたやり方を、新たな「すること」の選びには含めない', () => {
    const family = home();
    family.stoppedWayIds = ['way-a'];
    const events = [
      event(1, { type: 'householdSet', household: family }),
      event(2, { type: 'needWaysSet', itemId: 'item', wayIds: ['way-a'], about: '{}' }),
    ];
    expect(codes(check(family, [], events))).toContain('stopped_way_new_choice');
  });

  it('断られた本命の後、推薦が無くても選び直せるが、断られた案は使わない', () => {
    const family = home();
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const window = { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
    const events = [
      event(1, { type: 'householdSet', household: family }),
      event(2, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'one',
        role: 'primary',
      }),
      event(3, { type: 'assignmentProposed', taskKey: 'ask', assigneeId: 'a' }),
      event(4, {
        type: 'externalRequestSent',
        taskKey: 'ask',
        requestId: 'request',
        snapshot: { to: 'helper', kind: 'reply', basis, window },
      }),
      event(5, { type: 'externalReplyRecorded', requestId: 'request', reply: 'no' }),
    ];
    const inspect = (inUseOptionKey?: string) =>
      verifyPlan({
        household: family,
        events,
        plan: plan({
          throughSeq: events.length,
          requirements: [requirement()],
          arrangements: [
            arrangement({
              chosenOptionKey: 'one',
              ...(inUseOptionKey ? { inUseOptionKey } : {}),
              reasons: [{ code: 'turnedDown', refs: ['request'] }],
              options: [
                option('one', {
                  taskKeys: ['ask'],
                  decisionDeadline: '2026-12-03T18:00+09:00',
                  deadlineCertainty: 'estimate',
                }),
                option('two', {
                  decisionDeadline: '2026-12-03T18:00+09:00',
                  deadlineCertainty: 'estimate',
                }),
              ],
            }),
          ],
          tasks: [
            {
              key: 'ask',
              titleKey: 'ask',
              basis,
              durationMin: 5,
              segments: ['home'],
              assigneeId: 'a',
              commitment: 'done',
              live: true,
              external: { to: 'helper', kind: 'reply' },
            },
          ],
          requests: [
            {
              requestId: 'request',
              taskKey: 'ask',
              to: 'helper',
              kind: 'reply',
              sentAt: '2026-11-30T10:00+09:00',
              sentBy: 'a',
              state: 'turnedDown',
              basis,
              window,
              live: true,
            },
          ],
        }),
      });
    expect(codes(inspect())).not.toContain('failed_option_treated_as_valid');
    expect(codes(inspect('one'))).toContain('failed_option_treated_as_valid');
  });

  it('やめる前の有効な選びは残せるが、用件が変わった後は再び選べない', () => {
    const before = home();
    const after = structuredClone(before);
    after.stoppedWayIds = ['way-a'];
    const interpretation = {
      what: '架空の用件',
      shape: 'by',
      deadline: '2026-12-07T18:00+09:00',
    };
    const item = {
      id: 'item',
      sourceId: 'source',
      sentenceIds: ['sentence'],
      kind: 'need',
      written: '架空の用件',
      interpretation,
      evidence: 'stated',
      effects: [],
    };
    const source = {
      id: 'source',
      version: 1,
      receivedAt: '2026-11-30T10:00+09:00',
      sender: 'family',
      language: 'ja',
      sentences: [{ id: 'sentence', text: '架空の用件' }],
    };
    const about = JSON.stringify({
      need: { ...interpretation, condition: 'true' },
      ways: [before.ways[0]],
    });
    const events = [
      event(1, { type: 'householdSet', household: before }),
      event(2, { type: 'noticeReceived', source }),
      event(3, { type: 'itemsStated', sourceId: 'source', items: [item] }),
      event(4, { type: 'needWaysSet', itemId: 'item', wayIds: ['way-a'], about }),
      event(5, { type: 'householdSet', household: after }),
      event(6, { type: 'needWaysSet', itemId: 'item', wayIds: ['way-a', 'way-b'], about: '{}' }),
    ];
    expect(codes(check(after, [], events))).not.toContain('stopped_way_new_choice');
    events[5] = event(6, {
      type: 'itemCorrected',
      itemId: 'item',
      interpretation: { what: '別の用件' },
    });
    events.push(event(7, { type: 'needWaysSet', itemId: 'item', wayIds: ['way-a'], about: '{}' }));
    expect(codes(check(after, [], events))).toContain('stopped_way_new_choice');
  });
});
