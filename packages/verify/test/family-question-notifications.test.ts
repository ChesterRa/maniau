import { describe, expect, it } from 'vitest';
import { verifyNotifications } from '../src';
import { arrangement, household, plan, task } from './fixtures';

const until = '2026-12-07T10:00+09:00';
const family = {
  key: 'q',
  unknownId: 'u',
  until,
  affects: ['r'],
  family: {
    label: '行きますか',
    choices: [
      { value: 'yes', requirementKeys: ['r'], conditionalKeys: [] },
      { value: 'no', requirementKeys: [], conditionalKeys: [] },
    ],
  },
};
const intent = {
  key: 'question:u:a',
  toMemberId: 'a',
  kind: 'question',
  titleKey: 'notify.question',
  subject: { type: 'question', id: 'u' },
  until,
};

function codes(
  now: string,
  question: Record<string, unknown> = family,
  sent: Record<string, unknown> = intent,
) {
  return verifyNotifications({
    household: household(),
    plan: plan({ now, questions: [question] }),
    events: [],
    intents: [sent],
  })
    .issues.filter((issue) => issue.kind === 'violation')
    .map((issue) => issue.code);
}

describe('家族への問いの知らせ', () => {
  it('期限の26時間前から直前までは、期限を付けて知らせる', () => {
    expect(codes('2026-12-06T08:00+09:00')).toEqual([]);
    expect(codes('2026-12-07T09:59+09:00')).toEqual([]);
    expect(codes('2026-12-06T07:59+09:00')).toContain('notification_wrong_time');
    expect(codes(until)).toContain('notification_wrong_time');
    expect(
      codes('2026-12-06T08:00+09:00', family, { ...intent, until: '2026-12-07T09:00+09:00' }),
    ).toContain('notification_deadline_mismatch');
  });

  it('期限のない家族への問いを押し知らせにしない', () => {
    const { until: _until, ...undated } = family;
    const { until: _intentUntil, ...noDeadline } = intent;
    expect(codes('2026-12-06T08:00+09:00', undated, noDeadline)).toContain(
      'notification_subject_mismatch',
    );
  });

  it('持ち物の問いは従来どおり askBy を知らせの期限にする', () => {
    const atHome = { key: 'q', unknownId: 'u', askBy: until, fallbackValue: 'no', affects: [] };
    expect(codes('2026-12-06T08:00+09:00', atHome)).toEqual([]);
  });

  it('家族の答え待ちの要件を、先に担当なしとして押し知らせしない', () => {
    const work = task('work', {
      assigneeId: undefined,
      commitment: 'proposed',
      basis: { itemIds: [], requirementKey: 'r' },
      deadline: until,
    });
    const unowned = {
      key: 'unowned:work:a',
      toMemberId: 'a',
      kind: 'assignment',
      titleKey: 'notify.unowned',
      subject: { type: 'task', id: 'work' },
      until,
    };
    const check = (questions: unknown[]) =>
      verifyNotifications({
        household: household(),
        plan: plan({ now: '2026-12-06T08:00+09:00', tasks: [work], questions }),
        events: [],
        intents: [unowned],
      })
        .issues.filter((issue) => issue.kind === 'violation')
        .map((issue) => issue.code);
    expect(check([family])).toContain('notification_family_unanswered');
    expect(check([])).not.toContain('notification_family_unanswered');
    const linked = task('work', {
      assigneeId: undefined,
      commitment: 'proposed',
      basis: { itemIds: [], arrangementKey: 'arr' },
      deadline: until,
    });
    const viaArrangement = verifyNotifications({
      household: household(),
      plan: plan({
        now: '2026-12-06T08:00+09:00',
        tasks: [linked],
        questions: [family],
        arrangements: [arrangement({ key: 'arr', requirementKey: 'r' })],
      }),
      events: [],
      intents: [unowned],
    });
    expect(viaArrangement.issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'notification_family_unanswered',
      }),
    );
  });

  it('参加が決まる前に、その時だけ要る持ち物を家にあるか押し知らせしない', () => {
    const atHome = {
      key: 'q-home',
      unknownId: 'u-home',
      askBy: until,
      fallbackValue: 'no',
      affects: ['arr'],
    };
    const homeNotice = {
      ...intent,
      key: 'question:u-home:a',
      subject: { type: 'question', id: 'u-home' },
    };
    const check = (questions: unknown[]) =>
      verifyNotifications({
        household: household(),
        plan: plan({
          now: '2026-12-06T08:00+09:00',
          questions,
          arrangements: [arrangement({ key: 'arr', requirementKey: 'r' })],
        }),
        events: [],
        intents: [homeNotice],
      })
        .issues.filter((issue) => issue.kind === 'violation')
        .map((issue) => issue.code);
    expect(check([family, atHome])).toContain('notification_family_unanswered');
    expect(check([atHome])).not.toContain('notification_family_unanswered');
  });
});
