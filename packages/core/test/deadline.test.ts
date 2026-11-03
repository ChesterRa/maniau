import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatDateTime, Household, toEpochMinutes } from '../src';
import { noAdultAtHome, optionDeadline, ruleDeadline } from '../src/engine';

const household = Household.parse(
  JSON.parse(readFileSync(new URL('../../../data/demo/household.json', import.meta.url), 'utf8')),
);
const tz = household.timeZone;
const at = (value: string) => toEpochMinutes(value);
const show = (minutes: number | undefined) =>
  minutes === undefined ? undefined : formatDateTime(minutes, tz);
const template = (id: string) => {
  const found = household.careOptions.find((o) => o.id === id);
  if (!found) throw new Error(`取れる手が無い：${id}`);
  return found;
};

// お知らせが届いた夜（docs/plan/02-product.md §2）。
const NOTICE_ARRIVED = at('2026-11-25T19:30+09:00');
const NEED_DATE = '2026-12-07';

describe('決まりの締切', () => {
  it('学童：前の週の月曜 18:30、有休：3営業日前 18:00、祖母：3日前 21:00', () => {
    expect(show(ruleDeadline(template('opt-gakudo').deadline, NEED_DATE, household))).toBe(
      '2026-11-30T18:30+09:00',
    );
    expect(show(ruleDeadline(template('opt-leave-a').deadline, NEED_DATE, household))).toBe(
      '2026-12-02T18:00+09:00',
    );
    expect(show(ruleDeadline(template('opt-grandma').deadline, NEED_DATE, household))).toBe(
      '2026-12-04T21:00+09:00',
    );
  });
});

describe('決め時（手順の逆算）', () => {
  it('学童：月曜のお迎えで出すので、届けは 11/30 17:20 に書き始める（10分の窓を落とさない）', () => {
    const result = optionDeadline(template('opt-gakudo'), NEED_DATE, household, NOTICE_ARRIVED);
    expect(show(result.decisionDeadline)).toBe('2026-11-30T17:20+09:00');
    expect(result.steps.map((s) => [s.stepId, s.memberId, show(s.start), show(s.end)])).toEqual([
      ['write', 'a', '2026-11-30T17:20+09:00', '2026-11-30T17:30+09:00'],
      ['submit', 'a', '2026-11-30T18:00+09:00', '2026-11-30T18:05+09:00'],
    ]);
    expect(result.expired).toBe(false);
  });

  it('有休：本人の勤務の中で申請する。水曜の勤務の終わりは親A 17:30、親B 18:30', () => {
    const a = optionDeadline(template('opt-leave-a'), NEED_DATE, household, NOTICE_ARRIVED);
    const b = optionDeadline(template('opt-leave-b'), NEED_DATE, household, NOTICE_ARRIVED);
    expect(show(a.decisionDeadline)).toBe('2026-12-02T17:25+09:00');
    expect(show(b.decisionDeadline)).toBe('2026-12-02T17:55+09:00');
  });

  it('祖母：12/4(金) の夜、家にいる間に頼む', () => {
    const result = optionDeadline(template('opt-grandma'), NEED_DATE, household, NOTICE_ARRIVED);
    expect(show(result.decisionDeadline)).toBe('2026-12-04T20:55+09:00');
  });

  it('手順の担当が前後で別の人に決まった案は、置かない（紙を零分で手渡せるとは言わない）', () => {
    const base = template('opt-gakudo');
    const [write, submit] = base.steps;
    if (!write || !submit) throw new Error('学童の手順が無い');
    const split = {
      ...base,
      steps: [
        { ...write, assigneeId: 'b' },
        { ...submit, assigneeId: 'a' },
      ],
    };
    const result = optionDeadline(split, NEED_DATE, household, NOTICE_ARRIVED);
    expect(result.decisionDeadline).toBeUndefined();
    expect(result.steps).toEqual([]);
    // 同じ人に決まっていれば置ける。
    const same = {
      ...base,
      steps: [
        { ...write, assigneeId: 'a' },
        { ...submit, assigneeId: 'a' },
      ],
    };
    expect(show(optionDeadline(same, NEED_DATE, household, NOTICE_ARRIVED).decisionDeadline)).toBe(
      '2026-11-30T17:20+09:00',
    );
  });

  it('決め時を過ぎたら、もう選べない', () => {
    const later = at('2026-12-01T09:00+09:00');
    expect(optionDeadline(template('opt-gakudo'), NEED_DATE, household, later).expired).toBe(true);
    expect(optionDeadline(template('opt-leave-b'), NEED_DATE, household, later).expired).toBe(
      false,
    );
  });
});

describe('子の居場所の手配が要る時間', () => {
  it('12/7(月) は、親Aが家を出る 8:10 から、親Aが帰る 18:15 まで', () => {
    const gaps = noAdultAtHome(household, NEED_DATE).map((g) => [show(g.start), show(g.end)]);
    expect(gaps).toEqual([['2026-12-07T08:10+09:00', '2026-12-07T18:15+09:00']]);
  });

  it('二人とも朝だけ家にいて、そのまま一日の終わりまで帰らない日も、家を出てから終わりまでを手配の要る時間にする', () => {
    const dayOut = (workId: string): Household['routines'][number]['segments'] => [
      { start: '00:00', end: '07:00', kind: 'home', placeId: 'home', viaStationIds: [] },
      { start: '07:00', end: '23:59', kind: 'work', placeId: workId, viaStationIds: [] },
    ];
    const away: Household = {
      ...household,
      routines: household.routines.map((r) =>
        r.weekday === 1 && (r.memberId === 'a' || r.memberId === 'b')
          ? { ...r, segments: dayOut(r.memberId === 'a' ? 'work-a' : 'work-b') }
          : r,
      ),
    };
    const gaps = noAdultAtHome(away, NEED_DATE).map((g) => [show(g.start), show(g.end)]);
    expect(gaps).toEqual([['2026-12-07T07:00+09:00', '2026-12-07T23:59+09:00']]);
  });

  it('家の場所でも、仕事の区間は子を見られないとして数える（見られるなら「家」と書く）', () => {
    const remote: Household = {
      ...household,
      routines: household.routines.map((r) =>
        r.weekday === 1 && r.memberId === 'a'
          ? {
              ...r,
              segments: r.segments.map((s, i) =>
                i === 0 ? { ...s, kind: 'work' as const, placeId: 'home' } : s,
              ),
            }
          : r,
      ),
    };
    // 健太（a）は 6:30 から家で仕事をして 8:10 に出る。彩（b）は 8:00 に出る。
    const gaps = noAdultAtHome(remote, NEED_DATE).map((g) => [show(g.start), show(g.end)]);
    expect(gaps).toEqual([['2026-12-07T08:00+09:00', '2026-12-07T18:15+09:00']]);
  });

  it('外出は、家の場所と書かれていても家の外として数える', () => {
    const out: Household = {
      ...household,
      routines: household.routines.map((r) =>
        r.weekday === 1 && r.memberId === 'a'
          ? {
              ...r,
              segments: r.segments.map((s, i) =>
                i === 0 ? { ...s, kind: 'away' as const, placeId: 'home' } : s,
              ),
            }
          : r,
      ),
    };
    const gaps = noAdultAtHome(out, NEED_DATE).map((g) => [show(g.start), show(g.end)]);
    expect(gaps).toEqual([['2026-12-07T08:00+09:00', '2026-12-07T18:15+09:00']]);
  });

  it('一人が家で一日を終え、もう一人が遅くまで出ている夜は、手配の要る時間にしない', () => {
    const late: Household = {
      ...household,
      routines: household.routines.map((r) =>
        r.weekday === 1 && r.memberId === 'b'
          ? {
              ...r,
              segments: [
                { start: '06:30', end: '08:00', kind: 'home', placeId: 'home', viaStationIds: [] },
                {
                  start: '08:00',
                  end: '23:30',
                  kind: 'work',
                  placeId: 'work-b',
                  viaStationIds: [],
                },
              ],
            }
          : r,
      ),
    };
    // 健太（a）は 18:15 に帰って家で一日を終える。彩（b）は 23:30 まで出ている。
    const gaps = noAdultAtHome(late, NEED_DATE).map((g) => [show(g.start), show(g.end)]);
    expect(gaps).toEqual([['2026-12-07T08:10+09:00', '2026-12-07T18:15+09:00']]);
  });
});
