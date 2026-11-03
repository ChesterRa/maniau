// 担当のいない作業への知らせを、生成側の関数を使わずに照らす。
import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { arrangement, household, option, plan, task } from './fixtures';

const due = '2026-12-07T10:00+09:00';
const taskDeadline = '2026-12-07T18:15+09:00';
const now = '2026-12-06T09:00+09:00';
const unowned = task('work', {
  assigneeId: undefined,
  start: undefined,
  end: undefined,
  deadline: due,
});
const intent = {
  key: 'unowned:work:a',
  toMemberId: 'a',
  kind: 'assignment',
  titleKey: 'notify.unowned',
  subject: { type: 'task', id: 'work' },
  until: due,
};
const check = (intents: unknown, current = plan({ now, tasks: [unowned] })) =>
  verifyNotifications({ household: household(), plan: current, events: [], intents });
const violations = (result: ReturnType<typeof check>) =>
  result.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('担当のいない作業への知らせ', () => {
  it('期限が近い未担当の作業は、有効な大人それぞれに出せる', () => {
    expect(
      violations(check([intent, { ...intent, toMemberId: 'b', key: 'unowned:work:b' }])),
    ).toEqual([]);
    expect(
      violations(check([{ ...intent, toMemberId: 'helper', key: 'unowned:work:helper' }])),
    ).toContain('notification_recipient_invalid');
    for (const commitment of ['declined', 'withdrawn']) {
      const current = plan({ now, tasks: [task('work', { deadline: due, commitment })] });
      expect(violations(check([intent], current))).toEqual([]);
    }
  });

  it('担当が決まった・済んだ・不要・取消しの連絡は、未担当とは知らせない', () => {
    for (const changed of [
      { assigneeId: 'a', commitment: 'proposed' },
      { assigneeId: 'b', commitment: 'accepted' },
      { commitment: 'done' },
      { commitment: 'cancelled' },
      { live: false },
      { cancels: 'request' },
    ]) {
      const current = plan({ now, tasks: [{ ...unowned, ...changed }] });
      expect(violations(check([intent], current))).toContain('notification_subject_mismatch');
    }
    expect(violations(check([intent], plan({ now, tasks: [] })))).toContain(
      'notification_subject_mismatch',
    );
    expect(violations(check([{ ...intent, key: 'unowned:other:a' }]))).toContain(
      'notification_key_mismatch',
    );
    expect(violations(check([{ ...intent, kind: 'question' }]))).toContain(
      'notification_kind_mismatch',
    );
  });

  it('締切前26時間以内だけに出し、根拠と異なる期限や actBy は拒む', () => {
    expect(
      violations(check([intent], plan({ now: '2026-12-06T08:00+09:00', tasks: [unowned] }))),
    ).toEqual([]);
    expect(
      violations(check([intent], plan({ now: '2026-12-06T07:59+09:00', tasks: [unowned] }))),
    ).toContain('notification_wrong_time');
    expect(violations(check([intent], plan({ now: due, tasks: [unowned] })))).toContain(
      'notification_expired',
    );
    expect(violations(check([{ ...intent, until: taskDeadline }]))).toContain(
      'notification_deadline_mismatch',
    );
    expect(violations(check([{ ...intent, actBy: now }]))).toContain(
      'notification_deadline_mismatch',
    );
    expect(violations(check([{ ...intent, until: undefined }]))).toContain(
      'notification_wrong_time',
    );
  });

  it('案の手順は未経過の決め時を使い、始めた後に決め時を過ぎたら作業の締切を使う', () => {
    const work = {
      ...unowned,
      deadline: taskDeadline,
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
    };
    const chosen = option('one', {
      decisionDeadline: due,
      deadlineCertainty: 'estimate',
      taskKeys: ['work'],
    });
    const setup = { chosenOptionKey: 'one', inUseOptionKey: 'one', options: [chosen] };
    const current = plan({ now, tasks: [work], arrangements: [arrangement(setup)] });
    expect(violations(check([intent], current))).toEqual([]);
    expect(violations(check([{ ...intent, until: taskDeadline }], current))).toContain(
      'notification_deadline_mismatch',
    );
    const after = '2026-12-07T11:00+09:00';
    const expired = { ...chosen, expired: true };
    const notStarted = plan({
      now: after,
      tasks: [work],
      arrangements: [arrangement({ ...setup, options: [expired] })],
    });
    expect(violations(check([{ ...intent, until: taskDeadline }], notStarted))).toContain(
      'notification_subject_mismatch',
    );
    const finished = task('earlier', { basis: work.basis, commitment: 'done' });
    const started = plan({
      now: after,
      tasks: [work, finished],
      arrangements: [arrangement({ ...setup, options: [expired] })],
    });
    expect(violations(check([{ ...intent, until: taskDeadline }], started))).toEqual([]);
  });

  it('前の日の依頼では、期限を過ぎた新しい日の案を始めたことにはしない', () => {
    const work = {
      ...unowned,
      deadline: taskDeadline,
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
    };
    const chosen = option('one', {
      decisionDeadline: due,
      deadlineCertainty: 'estimate',
      expired: true,
      taskKeys: ['work'],
    });
    const request = {
      requestId: 'r',
      taskKey: 'other',
      to: 'helper',
      kind: 'reply',
      sentAt: now,
      sentBy: 'a',
      state: 'awaitingReply',
      live: true,
      basis: work.basis,
      window: { start: '2026-11-30T08:10+09:00', end: '2026-11-30T18:15+09:00' },
    };
    const current = (entry: object) =>
      plan({
        now: '2026-12-07T11:00+09:00',
        tasks: [work],
        arrangements: [
          arrangement({ chosenOptionKey: 'one', inUseOptionKey: 'one', options: [chosen] }),
        ],
        requests: [{ ...request, ...entry }],
      });
    const sent = { ...intent, until: taskDeadline };
    expect(violations(check([sent], current({})))).toContain('notification_subject_mismatch');
    expect(
      violations(
        check(
          [sent],
          current({
            window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
          }),
        ),
      ),
    ).toEqual([]);
    const cancelled = current({
      state: 'cancelled',
      window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
    });
    expect(violations(check([sent], cancelled))).toContain('notification_subject_mismatch');
    const uncertain = check([sent], current({ window: undefined }));
    expect(violations(uncertain)).toEqual([]);
    expect(uncertain.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'notification_started_unverified',
      }),
    );
  });

  it('本命の確定後に使っていない予備と、出番のない当日準備は知らせない', () => {
    const work = {
      ...unowned,
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'two' },
    };
    const primary = option('one', { decisionDeadline: due, deadlineCertainty: 'estimate' });
    const backup = option('two', {
      decisionDeadline: due,
      deadlineCertainty: 'estimate',
      taskKeys: ['work'],
    });
    const setup = arrangement({
      chosenOptionKey: 'one',
      backupOptionKeys: ['two'],
      inUseOptionKey: 'one',
      options: [primary, backup],
    });
    const request = {
      requestId: 'r',
      taskKey: 'sent',
      to: 'helper',
      kind: 'reply',
      sentAt: now,
      sentBy: 'a',
      state: 'confirmed',
      live: true,
      window: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
    };
    const confirmed = plan({ now, tasks: [work], arrangements: [setup], requests: [request] });
    expect(violations(check([intent], confirmed))).toContain('notification_subject_mismatch');
    const waiting = plan({
      now,
      tasks: [work],
      arrangements: [setup],
      requests: [{ ...request, state: 'awaitingReply' }],
    });
    expect(violations(check([intent], waiting))).toEqual([]);
    const extra = plan({
      now,
      tasks: [{ ...work, extra: true }],
      arrangements: [setup],
      requests: [{ ...request, state: 'awaitingReply' }],
    });
    expect(violations(check([intent], extra))).toContain('notification_subject_mismatch');
    const switched = plan({
      now,
      tasks: [{ ...work, extra: true }],
      arrangements: [{ ...setup, inUseOptionKey: 'two' }],
      requests: [{ ...request, state: 'turnedDown' }],
    });
    expect(violations(check([intent], switched))).toEqual([]);

    // 旧日の肯定と見せた時刻が変わった肯定は、現在の予備を不要にしない。
    const old = { start: '2026-11-30T08:10+09:00', end: '2026-11-30T18:15+09:00' };
    const changedTime = { start: '2026-12-07T09:10+09:00', end: '2026-12-07T18:15+09:00' };
    const same = { start: '2026-12-06T23:10+00:00', end: '2026-12-07T09:15+00:00' };
    const withRequest = (extra: object) =>
      plan({ now, tasks: [work], arrangements: [setup], requests: [{ ...request, ...extra }] });
    expect(violations(check([intent], withRequest({ window: old })))).toEqual([]);
    expect(violations(check([intent], withRequest({ window: changedTime })))).toEqual([]);
    expect(violations(check([intent], withRequest({ window: same, needsCheck: true })))).toEqual(
      [],
    );
    expect(violations(check([intent], withRequest({ window: undefined })))).toEqual([]);
    const uncertainAndNew = plan({
      now,
      tasks: [work],
      arrangements: [setup],
      requests: [
        { ...request, window: undefined },
        { ...request, requestId: 'r2', window: same },
      ],
    });
    expect(violations(check([intent], uncertainAndNew))).toEqual([]);
    const cancelledAndNew = plan({
      now,
      tasks: [work],
      arrangements: [setup],
      requests: [
        { ...request, state: 'cancelled', needsCheck: true },
        { ...request, requestId: 'r2', window: same },
      ],
    });
    expect(violations(check([intent], cancelledAndNew))).toContain('notification_subject_mismatch');
    expect(violations(check([intent], withRequest({ window: same })))).toContain(
      'notification_subject_mismatch',
    );

    // 同じ範囲の判定を、以前からある本人への提案にも適用する。
    const assigned = { ...work, assigneeId: 'a', start: due, end: '2026-12-07T10:30+09:00' };
    const proposal = { ...intent, key: 'proposal:work:a', titleKey: 'notify.proposal' };
    const confirmedProposal = plan({
      now,
      tasks: [assigned],
      arrangements: [setup],
      requests: [request],
    });
    expect(violations(check([proposal], confirmedProposal))).toContain(
      'notification_subject_mismatch',
    );
    const waitingProposal = plan({
      now,
      tasks: [assigned],
      arrangements: [setup],
      requests: [{ ...request, state: 'awaitingReply' }],
    });
    expect(violations(check([proposal], waitingProposal))).toEqual([]);
  });
});

describe('担当のいない作業の通知文', () => {
  it('日英の固定文だけを許し、名前等を足した文は拒む', () => {
    const messages = [
      {
        language: 'ja',
        title: 'まにあう',
        body: 'まだだれもやると決めていないことがあります。期限が近づいています。',
      },
      {
        language: 'en',
        title: 'Maniau',
        body: 'Something still has no one to do it, and its deadline is coming up.',
      },
    ];
    for (const { language, title, body } of messages) {
      const message = { title, body, titleKey: 'notify.unowned', count: 1 };
      expect(verifyNotificationMessage({ language, message, intents: [intent] }).status).toBe(
        'pass',
      );
      expect(
        verifyNotificationMessage({
          language,
          message: { ...message, body: `${body} 親A` },
          intents: [intent],
        }).status,
      ).toBe('violation');
    }
  });
});
