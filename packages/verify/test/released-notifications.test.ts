import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { household, plan } from './fixtures';

const start = '2026-12-06T08:30+09:00';
const end = '2026-12-06T09:30+09:00';
const release = {
  taskKey: 'work',
  assigneeId: 'a',
  content: {
    titleKey: 'task.escortTo',
    titleParams: { what: '練習', date: '2026-12-06', start: '09:00' },
  },
  start,
  end,
  reason: 'gone',
};
const intent = {
  key: 'released:work:a',
  toMemberId: 'a',
  kind: 'assignment',
  titleKey: 'notify.released',
  subject: { type: 'task', id: 'work' },
  actBy: start,
  until: end,
};
const check = (intents: unknown[], overrides: Record<string, unknown> = {}) =>
  verifyNotifications({
    household: household(),
    plan: plan({ now: '2026-12-06T08:00+09:00', released: [release], ...overrides }),
    events: [],
    intents,
  });
const violations = (result: ReturnType<typeof check>) =>
  result.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('不要になった引き受けの知らせ', () => {
  it('引き受けた本人に、出発の前も途中も期限まで知らせられる', () => {
    expect(violations(check([intent]))).toEqual([]);
    expect(violations(check([intent], { now: '2026-12-06T08:45+09:00' }))).toEqual([]);
    expect(violations(check([intent], { now: end }))).toContain('notification_expired');
  });

  it('時刻のない承諾は本人の確認まで知らせられる', () => {
    const { start: _s, end: _e, ...untimed } = release;
    const { actBy: _a, until: _u, ...noTime } = intent;
    expect(violations(check([noTime], { released: [untimed] }))).toEqual([]);
  });

  it('根拠を確認できない時は、不要と断言する知らせではなく要確認の知らせを使う', () => {
    const unknown = { taskKey: 'work', assigneeId: 'a', reason: 'unconfirmed' };
    const checkIntent = {
      key: 'releasedCheck:work:a',
      toMemberId: 'a',
      kind: 'assignment',
      titleKey: 'notify.releasedCheck',
      subject: { type: 'task', id: 'work' },
    };
    expect(violations(check([checkIntent], { released: [unknown] }))).toEqual([]);
    const categorical = { ...checkIntent, key: 'released:work:a', titleKey: 'notify.released' };
    expect(violations(check([categorical], { released: [unknown] }))).toContain(
      'notification_subject_mismatch',
    );
    const sentence = {
      title: 'まにあう',
      body: '引き受けたことが、今の計画に見つかりません。まだ要るか確かめてください。',
      titleKey: 'notify.releasedCheck',
      count: 1,
    };
    expect(
      verifyNotificationMessage({ message: sentence, language: 'ja', intents: [checkIntent] })
        .status,
    ).toBe('pass');
  });

  it('遠い約束は時刻が近づくまで知らせない', () => {
    expect(violations(check([intent], { now: '2026-12-04T08:00+09:00' }))).toContain(
      'notification_wrong_time',
    );
    expect(violations(check([intent], { now: '2026-12-05T06:30+09:00' }))).toEqual([]);
    expect(violations(check([intent], { now: '2026-12-05T06:29+09:00' }))).toContain(
      'notification_wrong_time',
    );
  });

  it('別の人、別の作業、別のキー、違う時刻を拒む', () => {
    expect(violations(check([{ ...intent, toMemberId: 'b', key: 'released:work:b' }]))).toContain(
      'notification_subject_mismatch',
    );
    expect(
      violations(
        check([{ ...intent, subject: { type: 'task', id: 'other' }, key: 'released:other:a' }]),
      ),
    ).toContain('notification_subject_mismatch');
    expect(violations(check([{ ...intent, key: 'released:other:a' }]))).toContain(
      'notification_key_mismatch',
    );
    expect(violations(check([{ ...intent, until: start }]))).toContain(
      'notification_deadline_mismatch',
    );
    expect(violations(check([{ ...intent, actBy: undefined }]))).toContain(
      'notification_deadline_mismatch',
    );
  });

  it('同じ瞬間の違う時差を受け入れる', () => {
    expect(
      violations(
        check([{ ...intent, actBy: '2026-12-05T23:30+00:00', until: '2026-12-06T00:30+00:00' }]),
      ),
    ).toEqual([]);
  });

  it('固定文から個人情報や作業名を差し込まない', () => {
    const message = {
      title: 'まにあう',
      body: '引き受けたことが、もう要らなくなりました。確かめてください。',
      titleKey: 'notify.released',
      count: 1,
    };
    expect(verifyNotificationMessage({ message, language: 'ja', intents: [intent] }).status).toBe(
      'pass',
    );
    expect(
      verifyNotificationMessage({
        message: { ...message, body: '架空の家族の名前' },
        language: 'ja',
        intents: [intent],
      }).status,
    ).toBe('violation');
    expect(
      verifyNotificationMessage({
        message: {
          title: 'Maniau',
          body: 'Something you took on is no longer needed. Please check.',
          titleKey: 'notify.released',
          count: 1,
        },
        language: 'en',
        intents: [intent],
      }).status,
    ).toBe('pass');
  });
});
