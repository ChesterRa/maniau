// 通用の本命の返事を、控えのない別の用件の返事として扱わない。
import { DomainEvent, Household, Task } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyNotifications } from '../src';
import { checkHistory } from '../src/history';
import { Collector } from '../src/report';
import { executionScope } from '../src/scope';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

function backupScope(about: 'current' | 'missing' | 'other') {
  const home = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way-1',
        name: '本命',
        steps: [
          {
            id: 'step-1',
            name: '頼む',
            durationMin: 30,
            segments: ['home'],
            external: { to: 'helper', kind: 'reply' },
          },
        ],
        cost: {},
        cancellable: true,
      },
      {
        id: 'way-2',
        name: '予備',
        steps: [{ id: 'step-2', name: '準備', durationMin: 30, segments: ['home'] }],
        cost: {},
        cancellable: true,
      },
    ],
  });
  const need = { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' };
  const basis = {
    itemIds: ['item-1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: 'one',
  };
  const saved = JSON.stringify({
    need: { ...need, ...(about === 'other' ? { what: '別の用件' } : {}), condition: 'true' },
    ways: [home.ways[0]],
  });
  const rawEvents = [
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
          interpretation: need,
          evidence: 'stated',
          effects: [],
        },
      ],
    }),
    event(4, {
      type: 'optionChosen',
      arrangementKey: 'arrangement',
      optionKey: 'one',
      role: 'primary',
    }),
    event(5, {
      type: 'optionChosen',
      arrangementKey: 'arrangement',
      optionKey: 'two',
      role: 'backup',
    }),
    event(6, { type: 'assignmentProposed', taskKey: 'send', assigneeId: 'a' }),
    event(7, {
      type: 'externalRequestSent',
      taskKey: 'send',
      requestId: 'request-1',
      snapshot: {
        to: 'helper',
        kind: 'reply',
        basis,
        ...(about === 'missing' ? {} : { about: saved }),
      },
    }),
    event(8, { type: 'externalReplyRecorded', requestId: 'request-1', reply: 'yes' }),
  ];
  const candidate = Task.parse(
    task('backup', {
      basis: { ...basis, optionKey: 'two' },
      step: { templateId: 'way-2', stepId: 'step-2' },
    }),
  );
  const current = plan({
    throughSeq: rawEvents.length,
    requirements: [
      requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item-1'] } }),
    ],
    arrangements: [
      arrangement({
        kind: 'need',
        needShape: 'by',
        chosenOptionKey: 'one',
        inUseOptionKey: 'one',
        backupOptionKeys: ['two'],
        options: [
          option('one', { templateId: 'way-1', taskKeys: ['send'] }),
          option('two', { templateId: 'way-2', taskKeys: ['backup'] }),
        ],
      }),
    ],
    tasks: [
      candidate,
      task('send', {
        basis,
        commitment: 'done',
        start: undefined,
        end: undefined,
        external: { to: 'helper', kind: 'reply' },
      }),
    ],
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
      },
    ],
  });
  const events = rawEvents.map((entry) => DomainEvent.parse(entry));
  const history = checkHistory(home, current, events, new Collector());
  return {
    scope: executionScope(candidate, current, home, history),
    primaryState: history.commitments.get('send'),
    notification: verifyNotifications({
      household: home,
      plan: current,
      events,
      intents: [
        {
          key: 'proposal:backup:a',
          toMemberId: 'a',
          kind: 'assignment',
          titleKey: 'notify.proposal',
          subject: { type: 'task', id: 'backup' },
        },
      ],
    }),
  };
}

describe('通用の本命と予備', () => {
  it('同じ内容の yes だけで、予備を不要とする', () => {
    expect(backupScope('current').scope).toBe('inactive');
    expect(backupScope('missing').scope).toBe('unknown');
    expect(backupScope('other').scope).toBe('active');
  });

  it('以前の別の用件への送信を、今の用件の済みとして扱わない', () => {
    expect(backupScope('current').primaryState).toBe('done');
    expect(backupScope('other').primaryState).toBe('accepted');
  });

  it('根拠が無い本命の返事だけで、予備の知らせを不要としない', () => {
    const codes = (about: 'current' | 'missing' | 'other') =>
      backupScope(about).notification.issues.map((issue) => issue.code);
    expect(codes('current')).toContain('notification_subject_mismatch');
    expect(codes('missing')).not.toContain('notification_subject_mismatch');
    expect(codes('other')).not.toContain('notification_subject_mismatch');
  });
});
