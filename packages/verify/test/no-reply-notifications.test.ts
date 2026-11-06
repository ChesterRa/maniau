// 返事がまだ記録されていない頼み事の知らせ（notify.noReply）を、計画の欄だけから照らす。
import { notificationMessage } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { arrangement, household, option, plan, task } from './fixtures';

const start = '2026-12-07T08:10+09:00';
const end = '2026-12-07T18:15+09:00';
/** 窓の始まりの 26 時間前。 */
const from = '2026-12-06T06:10+09:00';
const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'r',
  taskKey: 'ask',
  to: 'helper',
  kind: 'reply',
  sentAt: '2026-11-30T10:00+09:00',
  sentBy: 'a',
  state: 'awaitingReply',
  basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' },
  window: { start, end },
  live: true,
  ...overrides,
});
const waiting = (overrides: Record<string, unknown> = {}) =>
  arrangement({
    status: 'dependsOnReply',
    chosenOptionKey: 'one',
    inUseOptionKey: 'one',
    options: [option('one', { decisionDeadline: '2026-12-04T21:00+09:00', expired: true })],
    ...overrides,
  });
const intent = {
  key: 'noReply:r:a',
  toMemberId: 'a',
  kind: 'decisionApproaching',
  titleKey: 'notify.noReply' as const,
  subject: { type: 'request', id: 'r' },
  until: start,
};
const check = (
  intents: unknown[],
  {
    now = '2026-12-06T09:00+09:00',
    arrangements = [waiting()],
    requests = [request()],
    tasks = [] as unknown[],
  }: { now?: string; arrangements?: unknown[]; requests?: unknown[]; tasks?: unknown[] } = {},
) =>
  verifyNotifications({
    household: household(),
    plan: plan({ now, arrangements, requests, tasks }),
    events: [],
    intents,
  });
const codes = (result: ReturnType<typeof check>) => result.issues.map((issue) => issue.code);
const violations = (result: ReturnType<typeof check>) =>
  result.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('返事がまだ記録されていない頼み事の知らせ', () => {
  it('送った本人に、窓の始まりの 26 時間前から始まりまで、窓の始まりを期限に一度通す', () => {
    expect(violations(check([intent]))).toEqual([]);
    expect(violations(check([intent], { now: from }))).toEqual([]);
    expect(codes(check([intent], { now: '2026-12-06T06:09+09:00' }))).toContain(
      'notification_wrong_time',
    );
    expect(codes(check([intent], { now: start }))).toContain('notification_expired');
  });

  it('宛先・キー・種類・期限が根拠と違えば止める', () => {
    expect(codes(check([{ ...intent, key: 'noReply:r:b', toMemberId: 'b' }]))).toContain(
      'notification_subject_mismatch',
    );
    expect(codes(check([{ ...intent, key: 'noReply:r' }]))).toContain('notification_key_mismatch');
    expect(codes(check([{ ...intent, kind: 'assignment' }]))).toContain(
      'notification_kind_mismatch',
    );
    expect(codes(check([{ ...intent, until: end }]))).toContain('notification_deadline_mismatch');
    expect(
      codes(check([{ ...intent, subject: { type: 'arrangement', id: 'arrangement' } }])),
    ).toContain('notification_subject_mismatch');
  });

  it('上げ始める時以降に送った頼み事（遅く頼んだ物）は知らせない', () => {
    expect(codes(check([intent], { requests: [request({ sentAt: from })] }))).toContain(
      'notification_wrong_time',
    );
    expect(
      violations(check([intent], { requests: [request({ sentAt: '2026-12-06T06:09+09:00' })] })),
    ).toEqual([]);
  });

  it('返事を記録した・確かめの要る・生きていない・窓の無い頼み事には出さない', () => {
    for (const changed of [
      { state: 'confirmed' },
      { state: 'turnedDown' },
      { needsCheck: true },
      { live: false },
      { window: undefined },
    ]) {
      expect(codes(check([intent], { requests: [request(changed)] }))).toContain(
        'notification_subject_mismatch',
      );
    }
  });

  it('子の居場所の手配が、今使う手のその日の頼み事の返事を待っている時だけ', () => {
    for (const changed of [
      { kind: 'need' },
      { status: 'decidable' },
      { inUseOptionKey: 'two' },
      { live: false },
    ]) {
      expect(codes(check([intent], { arrangements: [waiting(changed)] }))).toContain(
        'notification_subject_mismatch',
      );
    }
    const otherDay = request({
      window: { start: '2026-12-08T08:10+09:00', end: '2026-12-08T18:15+09:00' },
    });
    expect(
      codes(check([{ ...intent, until: otherDay.window.start }], { requests: [otherDay] })),
    ).toContain('notification_subject_mismatch');
  });

  it('予備を押さえるかの札が同じ返事を追う間（次の手の決め時が 26 時間以内）は出さない', () => {
    const next = (decisionDeadline: string) =>
      waiting({
        options: [
          option('one', { decisionDeadline: '2026-12-04T21:00+09:00', expired: true }),
          option('two', { decisionDeadline }),
        ],
      });
    expect(codes(check([intent], { arrangements: [next('2026-12-06T20:00+09:00')] }))).toContain(
      'notification_subject_mismatch',
    );
    expect(
      violations(check([intent], { now: from, arrangements: [next('2026-12-07T08:11+09:00')] })),
    ).toEqual([]);
  });

  it('確保できた予備がある手配には出さない（断られても移れる）', () => {
    const backup = (commitment: string) => ({
      arrangements: [
        waiting({
          backupOptionKeys: ['two'],
          options: [
            option('one', { decisionDeadline: '2026-12-04T21:00+09:00', expired: true }),
            option('two', { taskKeys: ['prepare'] }),
          ],
        }),
      ],
      tasks: [task('prepare', { commitment, basis: { itemIds: [], optionKey: 'two' } })],
    });
    expect(codes(check([intent], backup('done')))).toContain('notification_subject_mismatch');
    expect(violations(check([intent], backup('accepted')))).toEqual([]);
  });

  it('送る文は名前の入らない固定文（日英）', () => {
    for (const language of ['ja', 'en'] as const) {
      const message = notificationMessage(language, [intent]);
      expect(verifyNotificationMessage({ message, language, intents: [intent] }).status).toBe(
        'pass',
      );
      const named = { ...message, body: `${message.body}（頼める人）` };
      expect(
        verifyNotificationMessage({ message: named, language, intents: [intent] }).status,
      ).toBe('violation');
    }
  });
});
