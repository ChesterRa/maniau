// 見えた時刻だけでなく、何のための引き受けかを事象から照らす。
import { Household, Task } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { doneContentMatches } from '../src/history';
import { proposalMatches } from '../src/proposal';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const home = (name = '手順') =>
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

function check(change?: 'recipient' | 'way', reconfirm = false) {
  const oldHome = home();
  const currentHome = change === 'way' ? home('変わった手順') : oldHome;
  const interpretation = {
    what: '架空の用件',
    shape: 'by',
    deadline: '2026-12-07T18:00+09:00',
    forMemberId: 'a',
  };
  const oldAbout = JSON.stringify({
    need: { ...interpretation, condition: 'true' },
    ways: oldHome.ways,
  });
  const currentAbout = JSON.stringify({
    need: {
      ...interpretation,
      ...(change === 'recipient' ? { forMemberId: 'b' } : {}),
      condition: 'true',
    },
    ways: currentHome.ways,
  });
  const basis = {
    itemIds: ['item-1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'option-1',
  };
  const shown = {
    start: '2026-12-07T10:00+09:00',
    end: '2026-12-07T10:30+09:00',
    titleKey: 'task.generic',
    titleParams: {},
    travelBeforeMin: 0,
    travelAfterMin: 0,
    about: oldAbout,
  };
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
    event(4, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way-1'], about: oldAbout }),
    event(5, { type: 'assignmentProposed', taskKey: 'task-1', assigneeId: 'a' }),
    event(6, {
      type: 'commitmentChanged',
      taskKey: 'task-1',
      assigneeId: 'a',
      action: 'accept',
      shown,
      basisItemIds: ['item-1'],
      basisSourceIds: ['source-1'],
    }),
  ];
  if (change === 'recipient')
    events.push(
      event(7, { type: 'itemCorrected', itemId: 'item-1', interpretation: { forMemberId: 'b' } }),
    );
  if (change === 'way') events.push(event(7, { type: 'householdSet', household: currentHome }));
  if (change)
    events.push(
      event(8, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way-1'], about: currentAbout }),
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
          options: [option('option-1', { templateId: 'way-1', taskKeys: ['task-1'] })],
        }),
      ],
      tasks: [
        task('task-1', {
          titleKey: 'task.generic',
          about: currentAbout,
          basis,
          step: { templateId: 'way-1', stepId: 'step-1' },
          commitment: 'accepted',
          ...(reconfirm ? { reconfirm: true } : {}),
        }),
      ],
    }),
  });
}

const codes = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('通用のすることの引き受け', () => {
  it('見た控えと済んだ控えは、通用の用件とやり方の版も照らす', () => {
    const current = Task.parse(task('task-1', { about: 'new' }));
    const shown = {
      start: current.start,
      end: current.end,
      titleKey: current.titleKey,
      titleParams: current.titleParams,
      travelBeforeMin: 0,
      travelAfterMin: 0,
    };
    expect(proposalMatches(current, { ...shown, about: 'new' })).toBe(true);
    expect(proposalMatches(current, { ...shown, about: 'old' })).toBe(false);
    expect(proposalMatches(current, shown)).toBe(false);
    expect(
      doneContentMatches(current, {
        titleKey: current.titleKey,
        titleParams: current.titleParams,
        about: 'new',
      }),
    ).toBe(true);
    expect(
      doneContentMatches(current, {
        titleKey: current.titleKey,
        titleParams: current.titleParams,
        about: 'old',
      }),
    ).toBe(false);
    expect(
      doneContentMatches(current, { titleKey: current.titleKey, titleParams: current.titleParams }),
    ).toBe(false);
  });

  it('受益者とやり方が変わらない引き受けを、そのまま確かめる', () => {
    expect(codes(check())).toEqual([]);
    expect(codes(check())).not.toContain('need_acceptance_stale');
  });

  it('札の題と時刻が同じでも、受益者が替われば見せ直しが要る', () => {
    expect(codes(check('recipient'))).toContain('need_acceptance_stale');
    expect(codes(check('recipient', true))).not.toContain('need_acceptance_stale');
  });

  it('札の題と時刻が同じでも、やり方の中身が替われば見せ直しが要る', () => {
    expect(codes(check('way'))).toContain('need_acceptance_stale');
    expect(codes(check('way', true))).not.toContain('need_acceptance_stale');
  });
});
