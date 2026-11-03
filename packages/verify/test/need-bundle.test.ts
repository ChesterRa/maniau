// 一つのやり方にある受け持ちと複数の外の承諾は、全部そろって初めて覆う。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

function check(accepted: boolean, replies: readonly ('yes' | 'waiting')[], showGap: boolean) {
  const home = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way-1',
        name: '架空の方法',
        cost: {},
        cancellable: true,
        steps: [
          { id: 'hold', name: '受け持つ', durationMin: 30, segments: ['home'], cover: true },
          {
            id: 'ask-1',
            name: '一つ目の許可',
            durationMin: 10,
            segments: ['home'],
            external: { to: 'helper', kind: 'approval' },
          },
          {
            id: 'ask-2',
            name: '外の人に受け持ってもらう',
            durationMin: 10,
            segments: ['home'],
            external: { to: 'helper', kind: 'reply' },
            cover: true,
          },
        ],
      },
    ],
  });
  const way = home.ways[0];
  if (!way) throw new Error('やり方がない');
  const need = {
    what: '架空の用件',
    shape: 'window',
    date: '2026-12-07',
    startTime: '08:00',
    endTime: '10:00',
  };
  const about = JSON.stringify({ need: { ...need, condition: 'true' }, ways: [way] });
  const window = { start: '2026-12-07T08:00+09:00', end: '2026-12-07T10:00+09:00' };
  const basis = {
    itemIds: ['item-1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'option-1',
  };
  const events: ReturnType<typeof event>[] = [];
  const add = (body: Record<string, unknown>) => events.push(event(events.length + 1, body));
  add({ type: 'householdSet', household: home });
  add({
    type: 'noticeReceived',
    source: {
      id: 'source-1',
      version: 1,
      receivedAt: '2026-11-30T10:00+09:00',
      sender: 'family',
      language: 'ja',
      sentences: [{ id: 'sentence-1', text: '架空の用件' }],
    },
  });
  add({
    type: 'itemsStated',
    sourceId: 'source-1',
    items: [
      {
        id: 'item-1',
        sourceId: 'source-1',
        sentenceIds: ['sentence-1'],
        kind: 'need',
        written: '架空の用件',
        interpretation: need,
        evidence: 'stated',
        effects: [],
      },
    ],
  });
  add({ type: 'needWaysSet', itemId: 'item-1', wayIds: ['way-1'], about });
  add({
    type: 'optionChosen',
    arrangementKey: 'arrangement',
    optionKey: 'option-1',
    role: 'primary',
  });
  add({ type: 'assignmentProposed', taskKey: 'hold-task', assigneeId: 'a' });
  if (accepted)
    add({
      type: 'commitmentChanged',
      taskKey: 'hold-task',
      assigneeId: 'a',
      action: 'accept',
      shown: {
        ...window,
        titleKey: 'task.hold',
        titleParams: {},
        travelBeforeMin: 0,
        travelAfterMin: 0,
        about,
      },
      basisItemIds: ['item-1'],
      basisSourceIds: ['source-1'],
    });
  const requests = [];
  for (let index = 0; index < 2; index++) {
    const taskKey = `ask-task-${index + 1}`;
    const requestId = `request-${index + 1}`;
    const kind = index === 0 ? 'approval' : 'reply';
    add({ type: 'assignmentProposed', taskKey, assigneeId: 'a' });
    if (replies[index] === undefined) continue;
    add({
      type: 'externalRequestSent',
      taskKey,
      requestId,
      snapshot: { to: 'helper', kind, basis, window, about },
    });
    if (replies[index] === 'yes') add({ type: 'externalReplyRecorded', requestId, reply: 'yes' });
    requests.push({
      requestId,
      taskKey,
      to: 'helper',
      kind,
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: replies[index] === 'yes' ? 'confirmed' : 'awaitingReply',
      basis,
      window,
      live: true,
    });
  }
  const tasks = [
    task('hold-task', {
      titleKey: 'task.hold',
      durationMin: 120,
      ...window,
      basis,
      step: { templateId: 'way-1', stepId: 'hold' },
      cover: true,
      about,
      commitment: accepted ? 'accepted' : 'proposed',
    }),
    ...[0, 1].map((index) =>
      task(`ask-task-${index + 1}`, {
        titleKey: 'task.ask',
        durationMin: 10,
        start: undefined,
        end: undefined,
        ...(index === 1 ? { after: [{ taskKey: 'ask-task-1', waitMin: 0 }] } : {}),
        basis,
        step: { templateId: 'way-1', stepId: `ask-${index + 1}` },
        external: { to: 'helper', kind: index === 0 ? 'approval' : 'reply' },
        about,
        commitment: replies[index] === undefined ? 'proposed' : 'done',
      }),
    ),
  ];
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
          inUseOptionKey: 'option-1',
          options: [
            option('option-1', { templateId: 'way-1', taskKeys: tasks.map((entry) => entry.key) }),
          ],
          reasons: showGap ? [{ code: 'notCovered', refs: [`${window.start}/${window.end}`] }] : [],
        }),
      ],
      tasks,
      requests,
    }),
  });
}

const codes = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('やり方全体の約束', () => {
  it('受け持ちだけでは足りず、外の承諾がどれも必要', () => {
    expect(codes(check(true, [], true))).not.toContain('need_coverage_gap_unfounded');
    expect(codes(check(true, [], false))).toContain('need_coverage_gap_missing');
    expect(codes(check(true, ['yes', 'waiting'], false))).toContain('need_coverage_gap_missing');
    expect(codes(check(true, ['yes', 'yes'], false))).not.toContain('need_coverage_gap_missing');
    expect(codes(check(true, ['yes', 'yes'], false))).toEqual([]);
  });

  it('外の承諾が全部あっても、受け持ちを引き受けなければ覆わない', () => {
    expect(codes(check(false, ['yes', 'yes'], false))).toContain('need_coverage_gap_missing');
    expect(codes(check(false, ['yes', 'yes'], true))).not.toContain('need_coverage_gap_unfounded');
  });
});
