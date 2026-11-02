// 新しい事象の操作者と順序を、求解のコードを読み込まずに確かめる。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>, kind?: 'violation' | 'undetermined') =>
  report.issues
    .filter((issue) => kind === undefined || issue.kind === kind)
    .map((issue) => issue.code);

const basis = { itemIds: [] };
const sent = [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
  event(3, {
    type: 'externalRequestSent',
    taskKey: 't',
    requestId: 'r',
    snapshot: { to: 'helper', kind: 'reply', basis },
  }),
];
const external = {
  requestId: 'r',
  taskKey: 't',
  to: 'helper',
  kind: 'reply',
  sentAt: '2026-11-30T10:00+09:00',
  sentBy: 'a',
  state: 'awaitingReply',
  basis,
  live: true,
};

describe('送った記録の誤り', () => {
  it('本人が返事の前に訂正した記録は、送信・取消し済みと数えない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, tasks: [task('t')] }),
      events: [...sent, event(4, { type: 'requestRecordCorrected', requestId: 'r' })],
    });
    expect(codes(report, 'violation')).not.toContain('active_request_missing');
    expect(codes(report, 'violation')).not.toContain('cancellation_missing');
    expect(codes(report, 'violation')).not.toContain('commitment_state_mismatch');
  });

  it('送信前に引き受けていれば、誤記を直した後もその引き受けに戻る', () => {
    const events = [
      ...sent.slice(0, 2),
      event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept' }),
      event(4, { ...sent[2], id: 'event-4', seq: 4 }),
      event(5, { type: 'requestRecordCorrected', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 5,
        tasks: [task('t', { commitment: 'accepted', reconfirm: true })],
      }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('commitment_state_mismatch');
  });

  it('送った後に担当を替えたら、誤記の訂正で前の担当に戻さない', () => {
    const events = [
      ...sent,
      event(4, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'b' }),
      event(5, { type: 'requestRecordCorrected', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, tasks: [task('t', { assigneeId: 'b' })] }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('commitment_state_mismatch');
  });

  it('送信の後に本人が記録した済みは、送信誤記の訂正で取り消さない', () => {
    const events = [
      ...sent,
      event(4, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'done' }),
      event(5, { type: 'requestRecordCorrected', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, tasks: [task('t', { commitment: 'done' })] }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('commitment_state_mismatch');
    const wrong = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, tasks: [task('t')] }),
      events,
    });
    expect(codes(wrong, 'violation')).toContain('commitment_state_mismatch');
  });

  it('同じ作業のもう一つの送信が残る限り、送信前の状態に戻さない', () => {
    const events = [
      ...sent,
      event(4, { ...sent[2], id: 'event-4', seq: 4, requestId: 'r2' }),
      event(5, { type: 'requestRecordCorrected', requestId: 'r' }),
    ];
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5, tasks: [task('t', { commitment: 'done' })] }),
      events,
    });
    expect(codes(report, 'violation')).not.toContain('commitment_state_mismatch');
    const corrected = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, tasks: [task('t')] }),
      events: [...events, event(6, { type: 'requestRecordCorrected', requestId: 'r2' })],
    });
    expect(codes(corrected, 'violation')).not.toContain('commitment_state_mismatch');
  });

  it('本人以外の訂正は違反であり、実際の依頼を消さない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 4, requests: [external] }),
      events: [...sent, event(4, { type: 'requestRecordCorrected', requestId: 'r', actorId: 'b' })],
    });
    expect(codes(report, 'violation')).toContain('request_correction_actor_mismatch');
    expect(codes(report, 'violation')).not.toContain('request_without_send');
  });

  it('返事または取消しを記録した後は、送っていない事にできない', () => {
    for (const prior of [
      { type: 'externalReplyRecorded', requestId: 'r', reply: 'yes' },
      { type: 'externalReplyRecorded', requestId: 'r', reply: 'no' },
      { type: 'cancellationSent', requestId: 'r' },
    ]) {
      const report = verifyPlan({
        household: household(),
        plan: plan({ throughSeq: 5 }),
        events: [
          ...sent,
          event(4, prior),
          event(5, { type: 'requestRecordCorrected', requestId: 'r' }),
        ],
      });
      expect(codes(report, 'violation')).toContain('request_correction_not_allowed');
    }
  });

  it('誤記として無効にした後の返事は、そのまま正しい送信の証拠にしない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 5 }),
      events: [
        ...sent,
        event(4, { type: 'requestRecordCorrected', requestId: 'r' }),
        event(5, { type: 'externalReplyRecorded', requestId: 'r', reply: 'yes' }),
      ],
    });
    expect(codes(report, 'violation')).toContain('request_event_without_send');
  });
});

describe('仕組みが書く事象と事象の版', () => {
  const notification = {
    type: 'notified',
    notificationKey: 'notification-1',
    toMemberId: 'a',
    channel: 'webPush',
    result: 'accepted',
    kind: 'question',
    content: { titleKey: 'question.title', params: {} },
    appVersion: 'fixture',
  };

  it('notified は system だけが書き、受理された事だけを表す', () => {
    const valid = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [sent[0], event(2, { ...notification, actorId: 'system' })],
    });
    expect(codes(valid, 'violation')).not.toContain('system_event_actor_invalid');
    const forged = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [sent[0], event(2, notification)],
    });
    expect(codes(forged, 'violation')).toContain('system_event_actor_invalid');
    const failed = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [sent[0], event(2, { ...notification, actorId: 'system', result: 'failed' })],
    });
    expect(codes(failed, 'violation')).toContain('invalid_event');
  });

  it('sourceContentPurged も system だけが書く', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [sent[0], event(2, { type: 'sourceContentPurged', sourceId: 'n1', scope: 'all' })],
    });
    expect(codes(report, 'violation')).toContain('system_event_actor_invalid');
  });

  it('事象の版と、書き起こした文の版は別である', () => {
    const body = {
      type: 'transcriptionCorrected',
      sourceId: 'n1',
      sourceVersion: 2,
      sentences: [{ id: 'n1-s1', text: '架空' }],
    };
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2 }),
      events: [sent[0], event(2, { ...body, version: 2 })],
    });
    expect(codes(report, 'violation')).toContain('invalid_event');
  });
});

describe('本命と予備の選び替え', () => {
  const initial = event(1, { type: 'householdSet', household: household() });
  const choose = (seq: number, role: 'primary' | 'backup') =>
    event(seq, { type: 'optionChosen', arrangementKey: 'arrangement', optionKey: 'one', role });

  it('予備を本命に上げたら、同じ案を予備に残さない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 3,
        arrangements: [
          arrangement({ chosenOptionKey: 'one', backupOptionKeys: [], options: [option('one')] }),
        ],
      }),
      events: [initial, choose(2, 'backup'), choose(3, 'primary')],
    });
    expect(codes(report, 'violation')).not.toContain('option_selection_mismatch');
    expect(codes(report, 'violation')).not.toContain('duplicate_selected_option');
  });

  it('本命を同時に予備として選ぶ記録は違反', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({
        throughSeq: 3,
        arrangements: [
          arrangement({
            chosenOptionKey: 'one',
            backupOptionKeys: ['one'],
            options: [option('one')],
          }),
        ],
      }),
      events: [initial, choose(2, 'primary'), choose(3, 'backup')],
    });
    expect(codes(report, 'violation')).toContain('backup_is_primary');
    expect(codes(report, 'violation')).toContain('duplicate_selected_option');
  });
});
