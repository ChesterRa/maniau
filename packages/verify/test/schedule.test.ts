import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const codes = (report: ReturnType<typeof verifyPlan>) => report.issues.map((issue) => issue.code);

describe('時刻と場所', () => {
  it('分単位の10分の作業を許し、接する作業を重複としない', () => {
    const first = task('first', {
      durationMin: 10,
      start: '2026-12-07T17:20+09:00',
      end: '2026-12-07T17:30+09:00',
    });
    const second = task('second', {
      start: '2026-12-07T17:30+09:00',
      end: '2026-12-07T18:00+09:00',
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [first, second] }),
      events: [],
    });
    expect(codes(report)).not.toContain('task_overlap');
    expect(codes(report)).not.toContain('duration_mismatch');
    expect(codes(report)).not.toContain('outside_routine');
  });

  it('時差を地域の日付に直し、UTCの前日を誤って使わない', () => {
    const item = task('early', { start: '2026-12-07T08:00+09:00', end: '2026-12-07T08:30+09:00' });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [item] }),
      events: [],
    });
    expect(codes(report)).not.toContain('outside_routine');
  });

  it('長さ0の作業を、同じ時刻にある作業との重なりとして扱わない', () => {
    const marker = task('marker', {
      durationMin: 0,
      start: '2026-12-07T10:15+09:00',
      end: '2026-12-07T10:15+09:00',
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [task('normal'), marker] }),
      events: [],
    });
    expect(codes(report)).not.toContain('task_overlap');
  });

  it('同じ人の重なり、始められる時刻、締切、先後と待ち時間を見つける', () => {
    const first = task('first', { deadline: '2026-12-07T10:20+09:00' });
    const second = task('second', {
      start: '2026-12-07T10:20+09:00',
      end: '2026-12-07T10:50+09:00',
      earliestStart: '2026-12-07T10:25+09:00',
      after: [{ taskKey: 'first', waitMin: 10 }],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [first, second] }),
      events: [],
    });
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        'task_overlap',
        'after_deadline',
        'before_earliest_start',
        'predecessor_wait',
      ]),
    );
  });

  it('店の営業時間は買い物の時間だけで判定し、移動の目安は未確認とする', () => {
    const shop = task('shop', {
      durationMin: 20,
      start: '2026-12-07T12:15+09:00',
      end: '2026-12-07T12:35+09:00',
      segments: ['away'],
      atPlaceId: 'store',
      placeKind: 'store',
      goods: 'clothing',
      travelBeforeMin: 5,
      travelAfterMin: 5,
      travelSource: 'estimate',
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [shop] }),
      events: [],
    });
    expect(codes(report)).not.toContain('outside_opening_hours');
    expect(codes(report)).toContain('route_is_estimate');
    expect(report.status).toBe('undetermined');
  });

  it('移動を含む人の占有の重なりと、短すぎる徒歩を見つける', () => {
    const shop = task('shop', {
      durationMin: 20,
      start: '2026-12-07T12:15+09:00',
      end: '2026-12-07T12:35+09:00',
      segments: ['away'],
      atPlaceId: 'store',
      placeKind: 'store',
      travelBeforeMin: 4,
      travelAfterMin: 5,
      travelSource: 'estimate',
    });
    const other = task('other', {
      durationMin: 10,
      start: '2026-12-07T12:38+09:00',
      end: '2026-12-07T12:48+09:00',
      segments: ['away'],
    });
    const report = verifyPlan({
      household: household(),
      plan: plan({ tasks: [shop, other] }),
      events: [],
    });
    expect(codes(report)).toEqual(expect.arrayContaining(['task_overlap', 'route_too_short']));
  });

  it('営業時間の根拠が期間外なら、閉店と決めつけず未判定にする', () => {
    const family = household();
    const place = family.places.find((entry) => entry.id === 'store');
    if (!place?.hours) throw new Error('店がない');
    place.hours.source = 'googlePlaces';
    place.hours.checkedAt = '2026-11-02T10:00+09:00';
    const shop = task('shop', {
      durationMin: 20,
      start: '2026-12-07T12:15+09:00',
      end: '2026-12-07T12:35+09:00',
      segments: ['away'],
      atPlaceId: 'store',
      placeKind: 'store',
    });
    const report = verifyPlan({ household: family, plan: plan({ tasks: [shop] }), events: [] });
    expect(codes(report)).toContain('opening_hours_out_of_range');
    expect(codes(report)).not.toContain('outside_opening_hours');
  });
});

describe('本命・予備と比較中の候補', () => {
  const casePlan = (backups: string[]) =>
    plan({
      throughSeq: backups.length ? 2 : 1,
      requirements: [requirement()],
      arrangements: [
        arrangement({
          chosenOptionKey: 'one',
          backupOptionKeys: backups,
          options: [
            option('one', { taskKeys: ['a-task'] }),
            option('two', { taskKeys: ['b-task'] }),
          ],
        }),
      ],
      tasks: [
        task('a-task', { basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' } }),
        task('b-task', { basis: { itemIds: [], arrangementKey: 'arrangement', optionKey: 'two' } }),
      ],
    });
  const selection = event(1, {
    type: 'optionChosen',
    arrangementKey: 'arrangement',
    optionKey: 'one',
    role: 'primary',
  });
  const backup = event(2, {
    type: 'optionChosen',
    arrangementKey: 'arrangement',
    optionKey: 'two',
    role: 'backup',
  });

  it('選んでいない比較候補との重なりは同時実行の違反にしない', () => {
    const report = verifyPlan({ household: household(), plan: casePlan([]), events: [selection] });
    expect(codes(report)).not.toContain('task_overlap');
    expect(codes(report)).not.toContain('option_selection_mismatch');
  });

  it('家族が本命と予備の両方を選べば、両方の作業の重なりを検出する', () => {
    const report = verifyPlan({
      household: household(),
      plan: casePlan(['two']),
      events: [selection, backup],
    });
    expect(codes(report)).toContain('task_overlap');
    expect(codes(report)).not.toContain('option_selection_mismatch');
  });

  it('同じ候補の二つの手順は、まだ選択前でも重ねない', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({ options: [option('one', { taskKeys: ['a-task', 'b-task'] })] }),
        ],
        tasks: [task('a-task', { basis }), task('b-task', { basis })],
      }),
      events: [],
    });
    expect(codes(report)).toContain('task_overlap');
  });

  it('推薦された候補が、別の有効な作業と重なる場合を見つける', () => {
    const basis = { itemIds: [], arrangementKey: 'arrangement', optionKey: 'one' };
    const report = verifyPlan({
      household: household(),
      plan: plan({
        requirements: [requirement()],
        arrangements: [
          arrangement({
            recommendedOptionKey: 'one',
            options: [option('one', { taskKeys: ['candidate'] })],
          }),
        ],
        tasks: [task('candidate', { basis }), task('fixed')],
      }),
      events: [],
    });
    expect(codes(report)).toContain('task_overlap');
  });
});
