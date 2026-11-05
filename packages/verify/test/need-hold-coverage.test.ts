// 「覆った」を、選択・引き受け・外の返事の事象から独立に照らす。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const window = { start: '2026-12-07T08:00+09:00', end: '2026-12-07T10:00+09:00' };
const item = {
  id: 'item-1',
  sourceId: 'source-1',
  sentenceIds: ['sentence-1'],
  kind: 'need',
  written: '架空の用件',
  interpretation: {
    what: '架空の用件',
    shape: 'window',
    date: '2026-12-07',
    startTime: '08:00',
    endTime: '10:00',
  },
  evidence: 'stated',
  effects: [],
};
const basis = {
  itemIds: ['item-1'],
  requirementKey: 'requirement',
  arrangementKey: 'arrangement',
  optionKey: 'option-1',
};
const fullGap = [`${window.start}/${window.end}`];

function check(
  options: {
    accepted?: boolean;
    holdNeeded?: boolean;
    reconfirm?: boolean;
    external?: boolean;
    externalCover?: boolean;
    externalKind?: 'reply' | 'approval';
    reply?: 'yes' | 'no' | 'waiting';
    about?: boolean;
    missingTaskAbout?: boolean;
    inUseUnchosen?: boolean;
    place?: string;
    covers?: { start: string; end: string };
    gaps?: string[];
  } = {},
) {
  const external = options.external ?? false;
  const externalKind = options.externalKind ?? 'reply';
  const currentItem = {
    ...item,
    interpretation: {
      ...item.interpretation,
      ...(options.place === undefined ? {} : { place: options.place }),
      ...(options.holdNeeded === undefined ? {} : { holdNeeded: options.holdNeeded }),
    },
  };
  const home = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way-1',
        name: '方法',
        steps: [
          {
            id: 'step-1',
            name: '手順',
            durationMin: 30,
            segments: ['home'],
            ...(external
              ? {
                  external: { to: 'helper', kind: externalKind },
                  ...(options.externalCover === false ? {} : { cover: true }),
                }
              : { cover: true }),
          },
        ],
        ...(options.covers ? { covers: options.covers } : {}),
        cost: {},
        cancellable: true,
      },
    ],
  });
  const way = home.ways[0];
  if (!way) throw new Error('やり方がない');
  const about = JSON.stringify({
    need: { ...currentItem.interpretation, condition: 'true' },
    ways: [way],
  });
  const shown = {
    ...window,
    titleKey: 'task.cover',
    titleParams: {},
    travelBeforeMin: 0,
    travelAfterMin: 0,
    ...(options.missingTaskAbout ? {} : { about }),
  };
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
    event(3, { type: 'itemsStated', sourceId: 'source-1', items: [currentItem] }),
    event(4, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way-1'], about }),
    event(5, {
      type: 'optionChosen',
      arrangementKey: 'arrangement',
      optionKey: 'option-1',
      role: 'primary',
    }),
    event(6, { type: 'assignmentProposed', taskKey: 'task-1', assigneeId: 'a' }),
  ];
  let sentWindow: typeof window | undefined;
  if (external) {
    sentWindow = window;
    events.push(
      event(7, {
        type: 'externalRequestSent',
        taskKey: 'task-1',
        requestId: 'request-1',
        snapshot: {
          to: 'helper',
          kind: externalKind,
          basis,
          window,
          ...(options.about ? { about } : {}),
        },
      }),
    );
    if (options.reply && options.reply !== 'waiting')
      events.push(
        event(8, { type: 'externalReplyRecorded', requestId: 'request-1', reply: options.reply }),
      );
  } else if (options.accepted) {
    events.push(
      event(7, {
        type: 'commitmentChanged',
        taskKey: 'task-1',
        assigneeId: 'a',
        action: 'accept',
        shown,
        basisItemIds: ['item-1'],
        basisSourceIds: ['source-1'],
      }),
    );
  }
  const reasons = options.gaps === undefined ? [] : [{ code: 'notCovered', refs: options.gaps }];
  return verifyPlan({
    household: home,
    events,
    plan: plan({
      throughSeq: events.length,
      requirements: [
        requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item-1'] } }),
      ],
      arrangements: [
        arrangement({
          kind: 'need',
          needShape: 'window',
          ...window,
          chosenOptionKey: 'option-1',
          inUseOptionKey: options.inUseUnchosen ? 'option-2' : 'option-1',
          options: [
            option('option-1', { templateId: 'way-1', taskKeys: ['task-1'] }),
            ...(options.inUseUnchosen ? [option('option-2', { templateId: 'way-1' })] : []),
          ],
          reasons,
        }),
      ],
      tasks: [
        task(
          'task-1',
          external
            ? {
                titleKey: 'task.contact',
                durationMin: 30,
                basis,
                step: { templateId: 'way-1', stepId: 'step-1' },
                external: { to: 'helper', kind: externalKind },
                commitment: 'done',
                about,
              }
            : {
                titleKey: 'task.cover',
                durationMin: 120,
                ...window,
                basis,
                step: { templateId: 'way-1', stepId: 'step-1' },
                cover: true,
                ...(options.missingTaskAbout ? {} : { about }),
                commitment: options.accepted ? 'accepted' : 'proposed',
                ...(options.reconfirm ? { reconfirm: true } : {}),
              },
        ),
      ],
      requests: external
        ? [
            {
              requestId: 'request-1',
              taskKey: 'task-1',
              to: 'helper',
              kind: externalKind,
              sentAt: '2026-11-30T10:00+09:00',
              sentBy: 'a',
              state:
                options.reply === 'yes'
                  ? 'confirmed'
                  : options.reply === 'no'
                    ? 'turnedDown'
                    : 'awaitingReply',
              basis,
              live: true,
              window: sentWindow,
            },
          ]
        : [],
    }),
  });
}

const has = (
  report: ReturnType<typeof verifyPlan>,
  kind: 'violation' | 'undetermined',
  code: string,
) => report.issues.some((issue) => issue.kind === kind && issue.code === code);

describe('窓の受け持ち不要の事実', () => {
  it('受け持ち不要の時、まだ引き受けがなくても notCovered を要求しない', () => {
    const result = check({ holdNeeded: false });
    expect(has(result, 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(has(result, 'undetermined', 'need_coverage_unverified')).toBe(false);
  });
  it('受け持ち不要なのに notCovered を出すと違反', () => {
    expect(
      has(check({ holdNeeded: false, gaps: fullGap }), 'violation', 'need_coverage_shape_mismatch'),
    ).toBe(true);
  });
  it('省略された旧い事象は、未引受けなら以前どおり不足を要求する', () => {
    expect(has(check(), 'violation', 'need_coverage_gap_missing')).toBe(true);
  });
});
