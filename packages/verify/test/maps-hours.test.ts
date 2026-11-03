import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { household, plan, task } from './fixtures';

function check(
  start: string,
  end: string,
  makeHours: (hours: NonNullable<ReturnType<typeof household>['places'][number]['hours']>) => void,
) {
  const family = household();
  const store = family.places.find((place) => place.id === 'store');
  if (!store?.hours) throw new Error('店がない');
  // 営業時間以外の事情で違反にならないよう、店にいる区間を用意する。
  family.routines = family.routines.map((routine) => ({
    ...routine,
    segments: [{ start: '00:00', end: '23:59', kind: 'away', placeId: 'store', viaStationIds: [] }],
  }));
  store.hours.source = 'googlePlaces';
  store.hours.checkedAt = '2026-11-01T19:00+09:00';
  makeHours(store.hours);
  return verifyPlan({
    household: family,
    plan: plan({
      now: '2026-11-01T19:00+09:00',
      tasks: [
        task('shop', {
          start,
          end,
          durationMin: (Date.parse(end) - Date.parse(start)) / 60_000,
          atPlaceId: 'store',
          placeKind: 'store',
          segments: ['away'],
        }),
      ],
    }),
    events: [],
  }).issues;
}

const notClosed = (issues: ReturnType<typeof check>) => {
  expect(
    issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code),
  ).not.toEqual(expect.arrayContaining(['place_closed', 'outside_opening_hours']));
};

describe('地図の営業時間に必要な根拠', () => {
  it('取得の七日後でも時刻が早ければ有効、とはしない', () => {
    const issues = check('2026-11-08T12:15+09:00', '2026-11-08T12:35+09:00', (hours) => {
      hours.periods = [{ weekday: 7, open: '10:00', close: '11:00' }];
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_coverage_unverified',
      }),
    );
    notClosed(issues);
    expect(issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('七日目の終わりに接しても期間外とはせず、現在は範囲と時区の根拠不足にする', () => {
    const issues = check('2026-11-07T23:40+09:00', '2026-11-08T00:00+09:00', (hours) => {
      hours.periods = [{ weekday: 6, open: '23:00', close: '00:00' }];
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_coverage_unverified',
      }),
    );
    expect(issues.map((issue) => issue.code)).not.toContain('opening_hours_out_of_range');
    notClosed(issues);
  });

  it('周期の表だけでは当日の特別営業を否定せず、閉店日としても断言しない', () => {
    const issues = check('2026-11-03T12:15+09:00', '2026-11-03T12:35+09:00', (hours) => {
      hours.periods = [];
      hours.closedDates = ['2026-11-03'];
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_coverage_unverified',
      }),
    );
    notClosed(issues);
    expect(issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('日をまたぐ営業時間も、取得範囲と時区が不明なら未判定にする', () => {
    const issues = check('2026-11-03T01:00+09:00', '2026-11-03T01:30+09:00', (hours) => {
      hours.periods = [{ weekday: 1, open: '22:00', close: '02:00' }];
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_coverage_unverified',
      }),
    );
    notClosed(issues);
  });

  it('開店と閉店が同じ時刻でも、24時間なのか不明なら閉店としない', () => {
    const issues = check('2026-11-03T12:15+09:00', '2026-11-03T12:35+09:00', (hours) => {
      hours.periods = [{ weekday: 2, open: '00:00', close: '00:00' }];
    });
    expect(
      issues.some(
        (issue) => issue.kind === 'undetermined' && issue.code.startsWith('opening_hours_'),
      ),
    ).toBe(true);
    notClosed(issues);
  });

  it('営業時間が返らない時は、店が閉まっているとは決めない', () => {
    const family = household();
    const store = family.places.find((place) => place.id === 'store');
    if (!store) throw new Error('店がない');
    store.hours = undefined;
    const issues = verifyPlan({
      household: family,
      plan: plan({
        tasks: [
          task('shop', {
            start: '2026-12-07T12:15+09:00',
            end: '2026-12-07T12:35+09:00',
            durationMin: 20,
            atPlaceId: 'store',
            placeKind: 'store',
            segments: ['away'],
          }),
        ],
      }),
      events: [],
    }).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_missing',
      }),
    );
    notClosed(issues);
  });

  it('取得時刻のない地図の営業時間は未判定にする', () => {
    const issues = check('2026-11-03T12:15+09:00', '2026-11-03T12:35+09:00', (hours) => {
      hours.checkedAt = undefined;
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'opening_hours_source_time_missing',
      }),
    );
    notClosed(issues);
  });

  it('地図の道のりの根拠を受け取れない時は、確認済みと言わない', () => {
    const family = household();
    const issues = verifyPlan({
      household: family,
      plan: plan({
        tasks: [
          task('shop', {
            start: '2026-12-07T12:15+09:00',
            end: '2026-12-07T12:35+09:00',
            durationMin: 20,
            atPlaceId: 'store',
            placeKind: 'store',
            segments: ['away'],
            travelSource: 'maps',
          }),
        ],
      }),
      events: [],
    }).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'route_evidence_missing',
      }),
    );
  });

  it('家庭が登録した確かな営業時間と矛盾すれば、従来どおり違反にする', () => {
    const family = household();
    const issues = verifyPlan({
      household: family,
      plan: plan({
        tasks: [
          task('shop', {
            start: '2026-12-07T13:10+09:00',
            end: '2026-12-07T13:30+09:00',
            durationMin: 20,
            atPlaceId: 'store',
            placeKind: 'store',
            segments: ['home'],
          }),
        ],
      }),
      events: [],
    }).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'outside_opening_hours',
      }),
    );
  });
});
