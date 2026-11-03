// 当番の開始と終了を別々に照らし、夜に待てるかの根拠も確かめる。
import { describe, expect, it } from 'vitest';
import { verifyNotifications } from '../src';
import { household, plan, task } from './fixtures';

const start = '2026-12-13T08:30+09:00';
const end = '2026-12-13T10:00+09:00';
const before = '2026-12-12T06:30+09:00';
const fixed = task('duty', {
  titleKey: 'task.duty',
  titleParams: { what: 'お茶当番', date: '2026-12-13', start: '08:30', end: '10:00' },
  timing: 'fixed',
  assigneeId: undefined,
  start: undefined,
  end: undefined,
  earliestStart: start,
  deadline: end,
});
const intent = {
  key: 'unowned:duty:a',
  toMemberId: 'a',
  kind: 'assignment',
  titleKey: 'notify.unowned',
  subject: { type: 'task', id: 'duty' },
  until: end,
  actBy: start,
};
const issues = (entry: unknown, work: Record<string, unknown> = fixed, now = before) =>
  verifyNotifications({
    household: household(),
    plan: plan({ now, tasks: [work] }),
    events: [],
    intents: [entry],
  }).issues.filter((issue) => issue.kind === 'violation');
const codes = (values: ReturnType<typeof issues>) => values.map((value) => value.code);

describe('当番への知らせ', () => {
  it('開始の26時間前から、終了まで有効な未担当の知らせを出せる', () => {
    expect(codes(issues(intent))).toEqual([]);
    expect(codes(issues(intent, fixed, '2026-12-12T06:29+09:00'))).toContain(
      'notification_wrong_time',
    );
    expect(codes(issues(intent, fixed, start))).toContain('notification_wrong_time');
  });
  it('開始と終了を入れ替えたり、開始を省いたりしない', () => {
    for (const changed of [{ actBy: undefined }, { actBy: end }, { until: start }]) {
      expect(codes(issues({ ...intent, ...changed }))).toContain('notification_deadline_mismatch');
    }
  });
  it('終わりを推定した固定当番でも、行動時刻は書かれた開始', () => {
    expect(codes(issues(intent, { ...fixed, timing: 'fixedEndEstimated' }))).toEqual([]);
  });
  it('固定当番の未配置の提案にも、開始と終了の両方が必要', () => {
    const proposal = {
      ...intent,
      key: 'proposal:duty:a',
      titleKey: 'notify.proposal',
    };
    const assigned = { ...fixed, assigneeId: 'a', commitment: 'proposed' };
    expect(codes(issues(proposal, assigned))).toEqual([]);
    expect(codes(issues({ ...proposal, actBy: undefined }, assigned))).toContain(
      'notification_deadline_mismatch',
    );
  });
  it('日のみの当番は、時刻を作らずその日の終わりまで知らせる', () => {
    const day = {
      ...fixed,
      timing: 'day',
      earliestStart: '2026-12-13T00:00+09:00',
      deadline: '2026-12-14T00:00+09:00',
    };
    const dayIntent = { ...intent, until: day.deadline, actBy: undefined };
    expect(codes(issues(dayIntent, day, '2026-12-13T09:00+09:00'))).toEqual([]);
    expect(
      codes(issues({ ...dayIntent, actBy: day.earliestStart }, day, '2026-12-13T09:00+09:00')),
    ).toContain('notification_deadline_mismatch');
  });
  it('開始時刻を確認できない当番は、その日の始まりから早めに確かめ、当日に届いても知らせる', () => {
    const unknown = {
      ...fixed,
      timing: 'day',
      timeUnconfirmed: true,
      earliestStart: '2026-12-13T00:00+09:00',
      deadline: '2026-12-14T00:00+09:00',
    };
    const unknownIntent = { ...intent, until: unknown.deadline, actBy: unknown.earliestStart };
    expect(codes(issues(unknownIntent, unknown, '2026-12-11T21:59+09:00'))).toContain(
      'notification_wrong_time',
    );
    for (const now of [
      '2026-12-11T22:00+09:00',
      '2026-12-13T06:55+09:00',
      '2026-12-13T09:00+09:00',
    ]) {
      expect(codes(issues(unknownIntent, unknown, now))).toEqual([]);
    }
    expect(codes(issues({ ...unknownIntent, actBy: undefined }, unknown))).toContain(
      'notification_deadline_mismatch',
    );
    expect(codes(issues(unknownIntent, unknown, unknown.deadline))).toContain(
      'notification_expired',
    );
  });
  it('開始時刻を確認できない当番の仕組みの提案も、当日中は知らせられる', () => {
    const unknown = {
      ...fixed,
      timing: 'day',
      timeUnconfirmed: true,
      earliestStart: '2026-12-13T00:00+09:00',
      deadline: '2026-12-14T00:00+09:00',
      assigneeId: 'a',
      commitment: 'proposed',
    };
    const proposal = {
      ...intent,
      key: 'proposal:duty:a',
      titleKey: 'notify.proposal',
      until: unknown.deadline,
      actBy: unknown.earliestStart,
    };
    expect(codes(issues(proposal, unknown, '2026-12-13T09:00+09:00'))).toEqual([]);
  });
  it('ほかの作業の仕組みの提案は、今までどおり締切を基準にする', () => {
    const ordinary = task('duty', {
      start: '2026-12-13T08:30+09:00',
      end: '2026-12-13T09:00+09:00',
      deadline: '2026-12-14T20:00+09:00',
    });
    const proposal = {
      ...intent,
      key: 'proposal:duty:a',
      titleKey: 'notify.proposal',
      until: ordinary.start,
      actBy: undefined,
    };
    expect(codes(issues(proposal, ordinary, '2026-12-12T09:00+09:00'))).toContain(
      'notification_wrong_time',
    );
  });
});
