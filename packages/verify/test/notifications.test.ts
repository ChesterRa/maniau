import { notificationMessage } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { arrangement, event, household, option, plan, task } from './fixtures';

const at = '2026-12-07T10:00+09:00';
const later = '2026-12-07T18:15+09:00';
const near = '2026-12-06T09:00+09:00';
const proposal = {
  key: 'proposal:work:a',
  toMemberId: 'a',
  kind: 'assignment',
  titleKey: 'notify.proposal' as const,
  subject: { type: 'task', id: 'work' },
  until: at,
};
const proposalPlan = () => plan({ tasks: [task('work')] });
const check = (intents: unknown, current = proposalPlan(), events: unknown = []) =>
  verifyNotifications({ household: household(), plan: { ...current, now: near }, events, intents });
const codes = (result: ReturnType<typeof check>) => result.issues.map((issue) => issue.code);

describe('知らせの意図の検証', () => {
  it('本人の有効な提案は通し、他の大人や無効な成員には出さない', () => {
    expect(check([proposal]).status).toBe('undetermined');
    expect(codes(check([{ ...proposal, toMemberId: 'b' }]))).toContain(
      'notification_subject_mismatch',
    );
    expect(codes(check([{ ...proposal, toMemberId: 'helper' }]))).toContain(
      'notification_recipient_invalid',
    );
    const family = household();
    const first = family.members[0];
    if (!first) throw new Error('成員がいない');
    first.active = false;
    const result = verifyNotifications({
      household: family,
      plan: proposalPlan(),
      events: [],
      intents: [proposal],
    });
    expect(codes(result)).toContain('notification_recipient_invalid');
  });

  it('消えた作業、済んだ作業、候補だけの作業、偽の再確認は出さない', () => {
    expect(codes(check([proposal], plan({ tasks: [] })))).toContain(
      'notification_subject_mismatch',
    );
    expect(
      codes(check([proposal], plan({ tasks: [task('work', { commitment: 'done' })] }))),
    ).toContain('notification_subject_mismatch');
    const candidate = task('work', {
      basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'candidate' },
    });
    expect(
      codes(check([proposal], plan({ tasks: [candidate], arrangements: [arrangement()] }))),
    ).toContain('notification_subject_mismatch');
    const changed = { ...proposal, titleKey: 'notify.changed', key: 'changed:work:a' };
    expect(codes(check([changed]))).toContain('notification_subject_mismatch');
    expect(
      check([changed], plan({ tasks: [task('work', { commitment: 'accepted', reconfirm: true })] }))
        .status,
    ).toBe('undetermined');
  });

  it('期限の過ぎた意図、根拠と違う期限、壊れた時刻を拒む', () => {
    expect(codes(check([{ ...proposal, until: '2026-12-01T08:00+09:00' }]))).toContain(
      'notification_expired',
    );
    expect(codes(check([{ ...proposal, until: later }]))).toContain(
      'notification_deadline_mismatch',
    );
    expect(codes(check([{ ...proposal, until: 'invalid' }]))).toContain('notification_invalid');
    // 同じ瞬間の異なる時差は、同じ時刻として扱う。
    expect(check([{ ...proposal, until: '2026-12-07T01:00+00:00' }]).status).toBe('undetermined');
  });

  it('仕組みからの遠い提案や自分自身への提案を知らせず、他の大人からはすぐ知らせる', () => {
    const distant = verifyNotifications({
      household: household(),
      plan: proposalPlan(),
      events: [],
      intents: [proposal],
    });
    expect(codes(distant)).toContain('notification_wrong_time');
    const set = event(1, { type: 'householdSet', household: household() });
    const own = event(2, { type: 'assignmentProposed', taskKey: 'work', assigneeId: 'a' });
    const current = plan({ now: near, throughSeq: 2, tasks: [task('work')] });
    expect(codes(check([proposal], current, [set, own]))).toContain('notification_self_proposal');
    const other = { ...own, actorId: 'b' };
    expect(check([proposal], current, [set, other]).status).toBe('undetermined');
    const system = { ...own, actorId: 'system' };
    const systemDistant = verifyNotifications({
      household: household(),
      plan: { ...current, now: '2026-12-01T09:00+09:00' },
      events: [set, system],
      intents: [proposal],
    });
    expect(codes(systemDistant)).toContain('notification_wrong_time');
  });

  it('不正な事象、他家庭、古い計画、重複キーは受け入れない', () => {
    expect(codes(check([proposal], proposalPlan(), [{}]))).toContain('notification_events_invalid');
    expect(
      codes(
        check([proposal], proposalPlan(), [
          event(1, { type: 'householdSet', household: household() }),
        ]),
      ),
    ).toContain('notification_plan_stale');
    expect(codes(check([proposal, proposal]))).toContain('notification_duplicate_key');
    const other = household();
    other.id = 'another';
    expect(
      codes(
        verifyNotifications({
          household: other,
          plan: proposalPlan(),
          events: [],
          intents: [proposal],
        }),
      ),
    ).toContain('notification_household_mismatch');
    const skipped = [
      event(1, { type: 'householdSet', household: household() }),
      event(3, { type: 'answered', unknownId: 'u', value: 'yes' }),
    ];
    expect(
      codes(check([proposal], plan({ throughSeq: 3, tasks: [task('work')] }), skipped)),
    ).toContain('notification_events_invalid');
    expect(codes(check([{ ...proposal, key: 'proposal:other:a' }]))).toContain(
      'notification_key_mismatch',
    );
    expect(check([proposal]).issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'notification_round_unverified',
        subject: proposal.key,
      }),
    );
    const invalid = check([{ ...proposal, key: '', subject: undefined }]);
    expect(invalid.issues).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'notification_invalid', subject: '$all' }),
    );
  });

  it('家庭の名前、呼び名、地点名を直接含むキーを報告し、中身を detail に書かない', () => {
    const family = household();
    const first = family.members[0];
    if (!first) throw new Error('成員がいない');
    first.addressAs = '架空の呼称';
    const leaking = ['親A', '架空の呼称', '店'].map((name) => ({
      ...proposal,
      key: `work:${name}`,
    }));
    const result = verifyNotifications({
      household: family,
      plan: proposalPlan(),
      events: [],
      intents: leaking,
    });
    expect(
      result.issues.filter((issue) => issue.code === 'notification_key_personal_text'),
    ).toHaveLength(3);
    expect(result.issues.every((issue) => !issue.detail.includes('架空の呼称'))).toBe(true);
  });

  it('英字名が別の英単語の一部に偶然含まれるだけでは止めない', () => {
    const family = household();
    const first = family.members[0];
    if (!first) throw new Error('成員がいない');
    first.name = 'Ann';
    const unrelated = {
      ...proposal,
      key: 'proposal:planning:a',
      subject: { type: 'task', id: 'planning' },
    };
    const clean = verifyNotifications({
      household: family,
      plan: plan({ tasks: [task('planning')] }),
      events: [],
      intents: [unrelated],
    });
    expect(codes(clean)).not.toContain('notification_key_personal_text');
    const named = {
      ...proposal,
      key: 'proposal:user-Ann-task:a',
      subject: { type: 'task', id: 'user-Ann-task' },
    };
    const leaked = verifyNotifications({
      household: family,
      plan: plan({ tasks: [task('user-Ann-task')] }),
      events: [],
      intents: [named],
    });
    expect(codes(leaked)).toContain('notification_key_personal_text');
  });

  it('取り消しは発出した本人、期限は最初ではなく終了と照合する', () => {
    const request = {
      requestId: 'r',
      taskKey: 'sent',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'confirmed',
      basis: { itemIds: [] },
      live: false,
      window: { start: at, end: later },
    };
    const cancel = {
      key: 'cancel:r:a',
      toMemberId: 'a',
      kind: 'cancellation',
      titleKey: 'notify.cancel',
      subject: { type: 'request', id: 'r' },
      until: later,
      actBy: at,
    };
    const current = plan({ requests: [request], tasks: [task('cancel', { cancels: 'r' })] });
    expect(check([cancel], current).status).toBe('undetermined');
    const during = verifyNotifications({
      household: household(),
      plan: { ...current, now: '2026-12-07T12:00+09:00' },
      events: [],
      intents: [cancel],
    });
    expect(during.status).toBe('undetermined');
    const past = verifyNotifications({
      household: household(),
      plan: { ...current, now: later },
      events: [],
      intents: [cancel],
    });
    expect(codes(past)).toContain('notification_expired');
    expect(codes(check([{ ...cancel, toMemberId: 'b' }], current))).toContain(
      'notification_subject_mismatch',
    );
    expect(codes(check([{ ...cancel, until: at }], current))).toContain(
      'notification_deadline_mismatch',
    );
    expect(codes(check([{ ...cancel, actBy: undefined }], current))).toContain(
      'notification_deadline_mismatch',
    );
    const alreadySent = plan({
      requests: [{ ...request, state: 'cancelled' }],
      tasks: [task('cancel', { cancels: 'r' })],
    });
    expect(codes(check([cancel], alreadySent))).toContain('notification_subject_mismatch');
    const declined = plan({
      requests: [{ ...request, state: 'turnedDown' }],
      tasks: [task('cancel', { cancels: 'r' })],
    });
    expect(codes(check([cancel], declined))).toContain('notification_subject_mismatch');
    const stillNeeded = plan({
      requests: [{ ...request, live: true }],
      tasks: [task('cancel', { cancels: 'r' })],
    });
    expect(codes(check([cancel], stillNeeded))).toContain('notification_subject_mismatch');
  });

  it('依頼の確認は送った本人に限り、必要な場合だけ出す', () => {
    const request = {
      requestId: 'r',
      taskKey: 'sent',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'awaitingReply',
      basis: { itemIds: [] },
      live: true,
      needsCheck: true,
    };
    const intent = {
      key: 'check:r:a',
      toMemberId: 'a',
      kind: 'question',
      titleKey: 'notify.check',
      subject: { type: 'request', id: 'r' },
    };
    expect(check([intent], plan({ requests: [request] })).status).toBe('undetermined');
    expect(
      codes(check([intent], plan({ requests: [{ ...request, needsCheck: false }] }))),
    ).toContain('notification_subject_mismatch');
  });

  it('決定と予備の根拠には、生きている手配と有効な案が必要', () => {
    const choice = option('one', { decisionDeadline: at, deadlineCertainty: 'estimate' });
    const intent = {
      key: 'decide:arrangement:one:a',
      toMemberId: 'a',
      kind: 'decisionApproaching',
      titleKey: 'notify.decide',
      subject: { type: 'arrangement', id: 'arrangement', optionId: 'one' },
      until: at,
    };
    expect(
      check([intent], plan({ arrangements: [arrangement({ options: [choice] })] })).status,
    ).toBe('undetermined');
    expect(
      codes(
        check(
          [intent],
          plan({ arrangements: [arrangement({ options: [{ ...choice, expired: true }] })] }),
        ),
      ),
    ).toContain('notification_subject_mismatch');
    const request = {
      requestId: 'r',
      taskKey: 'sent',
      to: 'helper',
      kind: 'reply',
      sentAt: '2026-11-30T10:00+09:00',
      sentBy: 'a',
      state: 'awaitingReply',
      basis: { itemIds: [], arrangementKey: 'arrangement' },
      live: true,
    };
    const backup = {
      ...intent,
      key: 'backup:arrangement:one:a',
      titleKey: 'notify.backup',
      subject: { ...intent.subject, requestId: 'r' },
    };
    expect(
      check(
        [backup],
        plan({
          arrangements: [arrangement({ status: 'dependsOnReply', options: [choice] })],
          requests: [request],
        }),
      ).status,
    ).toBe('undetermined');
    expect(
      codes(
        check(
          [{ ...backup, toMemberId: 'b' }],
          plan({
            arrangements: [arrangement({ status: 'dependsOnReply', options: [choice] })],
            requests: [request],
          }),
        ),
      ),
    ).toContain('notification_subject_mismatch');
  });

  it('子の居場所の選び直しは、推薦が無くても開いた案の期限を知らせる', () => {
    const choice = option('one', { decisionDeadline: at, deadlineCertainty: 'estimate' });
    const intent = {
      key: 'decide:arrangement:one:a',
      toMemberId: 'a',
      kind: 'decisionApproaching',
      titleKey: 'notify.decide',
      subject: { type: 'arrangement', id: 'arrangement', optionId: 'one' },
      until: at,
    };
    const retry = {
      chosenOptionKey: 'two',
      options: [choice, option('two', { expired: true })],
    };
    expect(codes(check([intent], plan({ arrangements: [arrangement(retry)] })))).not.toContain(
      'notification_subject_mismatch',
    );
    expect(
      codes(
        check([intent], plan({ arrangements: [arrangement({ ...retry, inUseOptionKey: 'two' })] })),
      ),
    ).toContain('notification_subject_mismatch');
  });

  it('指定された問いはその本人だけに出す', () => {
    const question = {
      key: 'q',
      unknownId: 'u',
      toMemberId: 'a',
      askBy: at,
      fallbackValue: 'no',
      affects: [],
    };
    const intent = {
      key: 'question:u:a',
      toMemberId: 'a',
      kind: 'question',
      titleKey: 'notify.question',
      subject: { type: 'question', id: 'u' },
      until: at,
    };
    expect(check([intent], plan({ questions: [question] })).status).toBe('undetermined');
    const distant = verifyNotifications({
      household: household(),
      plan: plan({ questions: [question] }),
      events: [],
      intents: [intent],
    });
    expect(codes(distant)).toContain('notification_wrong_time');
    expect(
      codes(check([{ ...intent, toMemberId: 'b' }], plan({ questions: [question] }))),
    ).toContain('notification_subject_mismatch');
    const second = { ...question, key: 'q2', toMemberId: 'b' };
    expect(
      check(
        [{ ...intent, toMemberId: 'b', key: 'question:u:b' }],
        plan({ questions: [question, second] }),
      ).status,
    ).toBe('undetermined');
  });
});

describe('実際に送る知らせの文', () => {
  it('日本語と英語の固定文・件数を受け入れる', () => {
    for (const language of ['ja', 'en'] as const) {
      const message = notificationMessage(language, [proposal, proposal]);
      expect(
        verifyNotificationMessage({ message, language, intents: [proposal, proposal] }).status,
      ).toBe('pass');
      const one = notificationMessage(language, [proposal]);
      expect(
        verifyNotificationMessage({ message: one, language, intents: [proposal] }).status,
      ).toBe('pass');
    }
  });

  it('名前などを差し込んだ文、別の人を混ぜた束、空の束を拒む', () => {
    const message = { ...notificationMessage('ja', [proposal]), body: '架空の個人名' };
    expect(verifyNotificationMessage({ message, language: 'ja', intents: [proposal] }).status).toBe(
      'violation',
    );
    expect(
      verifyNotificationMessage({
        message,
        language: 'ja',
        intents: [proposal, { ...proposal, toMemberId: 'b' }],
      }).status,
    ).toBe('violation');
    expect(verifyNotificationMessage({ message, language: 'ja', intents: [] }).status).toBe(
      'violation',
    );
  });
});
