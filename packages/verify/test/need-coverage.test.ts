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
  const currentItem =
    options.place === undefined
      ? item
      : {
          ...item,
          interpretation: { ...item.interpretation, place: options.place },
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

describe('窓を覆う事実', () => {
  it('場所が書かれた時は家族の受け持ちだけでは覆えず、外の相手の確かな受け持ちは数える', () => {
    const home = { accepted: true, place: '地区センター' };
    expect(has(check(home), 'violation', 'need_coverage_gap_missing')).toBe(true);
    const gap = check({ ...home, gaps: fullGap });
    expect(has(gap, 'violation', 'need_coverage_gap_unfounded')).toBe(false);
    expect(has(gap, 'violation', 'need_coverage_gap_missing')).toBe(false);

    const external = { place: '地区センター', external: true, reply: 'yes' as const, about: true };
    expect(has(check(external), 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(
      has(check({ ...external, gaps: fullGap }), 'violation', 'need_coverage_gap_unfounded'),
    ).toBe(true);
  });

  it('選んだだけでは覆わず、受け持ちを引き受けて初めて覆う', () => {
    expect(has(check(), 'violation', 'need_coverage_gap_missing')).toBe(true);
    expect(has(check({ gaps: fullGap }), 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(has(check({ accepted: true }), 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(check({ accepted: true }).issues.filter((issue) => issue.kind === 'violation')).toEqual(
      [],
    );
    expect(
      has(check({ accepted: true, gaps: fullGap }), 'violation', 'need_coverage_gap_unfounded'),
    ).toBe(true);
  });

  it('見せ直し中の古い引き受けを、今の窓を受け持つ証拠にしない', () => {
    expect(
      has(check({ accepted: true, reconfirm: true }), 'violation', 'need_coverage_gap_missing'),
    ).toBe(true);
  });

  it('家族が選んでいない案を、今使う案にしない', () => {
    expect(
      has(
        check({ inUseUnchosen: true, gaps: fullGap }),
        'violation',
        'need_coverage_option_not_selected',
      ),
    ).toBe(true);
  });

  it('古い受け持ちの控えに内容とやり方の版がなければ未判定', () => {
    expect(
      has(
        check({ accepted: true, missingTaskAbout: true }),
        'undetermined',
        'need_coverage_unverified',
      ),
    ).toBe(true);
  });

  it('外からの yes に内容の控えがなければ、覆えたか未判定', () => {
    const result = check({ external: true, reply: 'yes' });
    expect(has(result, 'undetermined', 'need_coverage_unverified')).toBe(true);
    expect(has(result, 'violation', 'need_coverage_gap_missing')).toBe(false);
  });

  it('受け持つ印のない承認は、同じ窓への yes でも窓を覆わない', () => {
    const approval = {
      external: true,
      externalCover: false,
      externalKind: 'approval' as const,
      reply: 'yes' as const,
      about: true,
    };
    expect(has(check(approval), 'violation', 'need_coverage_gap_missing')).toBe(true);
    const withGap = check({ ...approval, gaps: fullGap });
    expect(has(withGap, 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(has(withGap, 'violation', 'need_coverage_gap_unfounded')).toBe(false);
  });

  it('覆える時間が一部のやり方は、外の返事があっても足りない両端を示す', () => {
    const gaps = [
      '2026-12-07T08:00+09:00/2026-12-07T08:30+09:00',
      '2026-12-07T09:30+09:00/2026-12-07T10:00+09:00',
    ];
    const args = {
      external: true,
      reply: 'yes' as const,
      about: true,
      covers: { start: '08:30', end: '09:30' },
    };
    expect(has(check(args), 'violation', 'need_coverage_gap_missing')).toBe(true);
    expect(has(check({ ...args, gaps }), 'violation', 'need_coverage_gap_missing')).toBe(false);
  });

  it('覆える時間の登録がなくても、同じ窓への確かな yes は全部を覆う', () => {
    const result = check({ external: true, reply: 'yes', about: true });
    expect(has(result, 'violation', 'need_coverage_gap_missing')).toBe(false);
    expect(has(result, 'undetermined', 'need_coverage_unverified')).toBe(false);
  });
});
