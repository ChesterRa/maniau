// 候補の作業は live のまま残る。実際に進めているかは、選択事象から独立に照らす。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { checkHistory } from '../src/history';
import { Collector } from '../src/report';
import { executionScope } from '../src/scope';
import { arrangement, event, household, option, plan, task } from './fixtures';

const currentTask = task('work', {
  basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
  commitment: 'accepted',
  live: true,
});
const events = [
  event(1, { type: 'householdSet', household: household() }),
  event(2, {
    type: 'optionChosen',
    arrangementKey: 'arrangement',
    optionKey: 'one',
    role: 'primary',
  }),
  event(3, { type: 'assignmentProposed', taskKey: 'work', assigneeId: 'a' }),
  event(4, {
    type: 'commitmentChanged',
    taskKey: 'work',
    assigneeId: 'a',
    action: 'accept',
    shown: {
      titleKey: 'task.work',
      titleParams: {},
      start: '2026-12-07T10:00+09:00',
      end: '2026-12-07T10:30+09:00',
      travelBeforeMin: 0,
      travelAfterMin: 0,
    },
  }),
  event(5, {
    type: 'optionChosen',
    arrangementKey: 'arrangement',
    optionKey: 'two',
    role: 'primary',
  }),
];
const current = plan({
  throughSeq: events.length,
  tasks: [currentTask],
  arrangements: [arrangement({ chosenOptionKey: 'two', options: [option('one'), option('two')] })],
});

describe('引き受けた案の進行範囲', () => {
  it('別の案を選んだ後も残る live の作業を、進行中とは数えない', () => {
    const report = new Collector();
    const history = checkHistory(
      household(),
      current,
      events.map((value) => DomainEvent.parse(value)),
      report,
    );
    expect(current.tasks[0]?.live).toBe(true);
    if (!current.tasks[0]) throw new Error('作業が無い');
    expect(executionScope(current.tasks[0], current, household(), history)).toBe('candidate');
  });
  it('進行から外れた引き受けも本人に示し、根拠のある札を誤って拒まない', () => {
    const release = {
      taskKey: 'work',
      assigneeId: 'a',
      reason: 'inactive',
      content: { titleKey: 'task.work', titleParams: {} },
      start: '2026-12-07T10:00+09:00',
      end: '2026-12-07T10:30+09:00',
    };
    const ready = plan({ ...current, released: [release] });
    const check = (result: typeof current) =>
      verifyPlan({ household: household(), plan: result, events });
    expect(
      check(ready).issues.some(
        (issue) => issue.kind === 'violation' && issue.code.startsWith('released_'),
      ),
    ).toBe(false);
    expect(check(current).issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'released_missing',
        subject: 'work',
      }),
    );
  });

  it('送った後で依頼を取り消し作業が開き直っただけでは、古い承諾の取消し札を要求しない', () => {
    const sent = [
      ...events.slice(0, 4),
      event(5, { type: 'externalRequestSent', taskKey: 'work', requestId: 'r' }),
      event(6, { type: 'cancellationSent', requestId: 'r' }),
      event(7, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: 'two',
        role: 'primary',
      }),
    ];
    const reopened = plan({ ...current, throughSeq: 7 });
    const history = checkHistory(
      household(),
      reopened,
      sent.map((value) => DomainEvent.parse(value)),
      new Collector(),
    );
    expect(history.commitments.get('work')).toBe('accepted');
    expect(history.requestBasedDone.has('work')).toBe(true);
    const report = verifyPlan({ household: household(), plan: reopened, events: sent });
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: 'released_missing', subject: 'work' }),
    );
  });
});
