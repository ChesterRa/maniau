// 子を見られる大人がいるかの分かり方（careCoverage）：分からない人・時間を「不在」にも「見られる」にも数えず、
// 分からない所として要件に添えて聞く。手配は、大人の全員が見られないと分かっている時間だけに置く。
import { describe, expect, it } from 'vitest';
import { type DayAnswer, Household, todayCards, validateHousehold } from '../src';
import { careCoverage, computePlan } from '../src/engine';
import { zonedToEpochMinutes } from '../src/time';
import { household, noticeArrived } from './fixtures/demo';

const D = '2026-12-07';
const at = (time: string, date = D) => zonedToEpochMinutes(date, time, 'Asia/Tokyo');
const span = (from: string, to: string) => ({ start: at(from), end: at(to) });
const WHOLE = { start: at('00:00'), end: at('00:00', '2026-12-08') };
const REQ = 'req:childCare:i4:c';
const CARE = 'arr:childCare:i4:c';

const answer = (
  memberId: string,
  rest: DayAnswer['rest'],
  can: [string, string][] = [],
  cannot: [string, string][] = [],
): DayAnswer => ({
  memberId,
  date: D,
  can: can.map(([start, end]) => ({ start, end })),
  cannot: cannot.map(([start, end]) => ({ start, end })),
  rest,
});
/** 12/7（月）の、ふだんの週の一日が無い家庭（ほかの曜日はそのまま）。 */
const noMonday = Household.parse({
  ...household,
  routines: household.routines.filter((r) => r.weekday !== 1),
});
const withAnswers = (answers: DayAnswer[], h: Household = noMonday) =>
  Household.parse({ ...h, dayAnswers: answers });

const planWith = (h: Household) =>
  computePlan(
    noticeArrived().add('householdSet', '2026-11-25T19:32+09:00', 'a', { household: h }).events,
    '2026-11-25T19:40+09:00',
  );

describe('前からの家庭は変わらない', () => {
  it('欄を足さず、分からない時間は無い（大人の全員に、毎日の区間がある）', () => {
    expect(household.dayAnswers).toBeUndefined();
    expect(household.confirmDays).toBeUndefined();
    for (const date of ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08']) {
      const coverage = careCoverage(household, date);
      expect(coverage.unsure).toEqual([]);
      expect(coverage.missing).toEqual([]);
    }
    const care = planWith(household).requirements.find((r) => r.key === REQ);
    expect(care?.missingAdults).toBeUndefined();
    expect(care?.unsure).toBeUndefined();
  });
});

describe('分からない人・時間（受け入れ U1・U2・U4）', () => {
  it('U1：だれの予定も無い日は、一日の全部が分からない（手配も「何もない」も出さず、聞く）', () => {
    expect(careCoverage(noMonday, D)).toEqual({
      certain: [],
      unsure: [WHOLE],
      missing: ['a', 'b'],
    });
    const plan = planWith(noMonday);
    const care = plan.requirements.find((r) => r.key === REQ);
    expect(care?.missingAdults).toEqual(['a', 'b']);
    expect(care?.unsure).toEqual([
      { start: '2026-12-07T00:00+09:00', end: '2026-12-08T00:00+09:00' },
    ]);
    expect(plan.arrangements.find((a) => a.key === CARE)).toBeUndefined();
    for (const member of ['a', 'b']) {
      expect(todayCards(plan, member).main.map((c) => c.kind)).toContain('facts');
    }
  });

  it('U2：A は 9–12 時に見られないと答え、B は答えていない：B を不在にも見られるにも数えない', () => {
    // A はほかの時間は見られる、と答えた。
    const coverage = careCoverage(withAnswers([answer('a', 'can', [], [['09:00', '12:00']])]), D);
    expect(coverage.certain).toEqual([]);
    expect(coverage.unsure).toEqual([span('09:00', '12:00')]);
    expect(coverage.missing).toEqual(['b']);
    // A のほかの時間も分からない時は、A も分からない人に入る。
    const both = careCoverage(withAnswers([answer('a', 'unknown', [], [['09:00', '12:00']])]), D);
    expect(both.certain).toEqual([]);
    expect(both.missing).toEqual(['a', 'b']);
  });

  it('手が離せない時間だけが分かる時：一人の分では「全員不在」と言わない（全員の分の重なりだけ）', () => {
    const busy = (memberId: string, id: string) => ({
      id,
      memberId,
      date: D,
      start: '09:00',
      end: '10:00',
    });
    const one = Household.parse({ ...noMonday, unavailable: [busy('a', 'u1')] });
    expect(careCoverage(one, D).certain).toEqual([]);
    expect(careCoverage(one, D).missing).toEqual(['a', 'b']);
    const both = Household.parse({ ...noMonday, unavailable: [busy('a', 'u1'), busy('b', 'u2')] });
    expect(careCoverage(both, D).certain).toEqual([span('09:00', '10:00')]);
    expect(careCoverage(both, D).missing).toEqual(['a', 'b']);
  });

  it('U4：A が 9–12 時、B が 13–18 時に見られる（ほかは分からない）：12–13 時は消えず、全部見られるとは出ない', () => {
    const h = withAnswers([
      answer('a', 'unknown', [['09:00', '12:00']]),
      answer('b', 'unknown', [['13:00', '18:00']]),
    ]);
    const coverage = careCoverage(h, D);
    expect(coverage.certain).toEqual([]);
    expect(coverage.unsure).toContainEqual(span('12:00', '13:00'));
    expect(coverage.missing).toEqual(['a', 'b']);
    const plan = planWith(h);
    expect(plan.arrangements.find((a) => a.key === CARE)).toBeUndefined();
    expect(plan.requirements.find((r) => r.key === REQ)?.unsure).toContainEqual({
      start: '2026-12-07T12:00+09:00',
      end: '2026-12-07T13:00+09:00',
    });
  });

  it('接する時間（12:00 ちょうど）で、見られる時間をつなげれば、分からない時間は無い', () => {
    const h = withAnswers([
      answer('a', 'cannot', [['00:00', '12:00']]),
      answer('b', 'cannot', [['12:00', '18:00']], [['18:00', '20:00']]),
    ]);
    const coverage = careCoverage(h, D);
    // 18 時より後は二人とも見られない（全員が見られない時間＝手配が要る）。
    expect(coverage.unsure).toEqual([]);
    expect(coverage.missing).toEqual([]);
    expect(coverage.certain).toEqual([{ start: at('18:00'), end: WHOLE.end }]);
  });
});

describe('前からの記録の、区間の間の空き', () => {
  it('区間の間の空きは分からない（見られるにも、家の外にも数えない）。最初の前と最後の後は、今までどおり家', () => {
    // 健太（a）：9–10 時は家、11–12 時は仕事（10–11 時は記録が無い）。彩（b）：10–11 時は仕事。
    const seg = (start: string, end: string, kind: 'home' | 'work') => ({
      start,
      end,
      kind,
      viaStationIds: [],
    });
    const h = Household.parse({
      ...noMonday,
      routineExceptions: [
        {
          memberId: 'a',
          date: D,
          segments: [seg('09:00', '10:00', 'home'), seg('11:00', '12:00', 'work')],
        },
        {
          memberId: 'b',
          date: D,
          segments: [
            seg('06:00', '10:00', 'home'),
            seg('10:00', '11:00', 'work'),
            seg('11:00', '23:00', 'home'),
          ],
        },
      ],
    });
    const coverage = careCoverage(h, D);
    expect(coverage.unsure).toEqual([span('10:00', '11:00')]);
    expect(coverage.missing).toEqual(['a']);
    expect(coverage.certain).toEqual([]);
  });
});

describe('答えがそろった時と、答え直し（受け入れ U5・U6）', () => {
  it('U5：二人とも見られない時間を答えると、その重なりに手配を置き、聞く札を出さない', () => {
    const h = withAnswers([
      answer('a', 'can', [], [['09:00', '18:00']]),
      answer('b', 'can', [], [['08:00', '19:00']]),
    ]);
    expect(careCoverage(h, D)).toEqual({
      certain: [span('09:00', '18:00')],
      unsure: [],
      missing: [],
    });
    const plan = planWith(h);
    const care = plan.arrangements.find((a) => a.key === CARE);
    expect(care?.start).toBe('2026-12-07T09:00+09:00');
    expect(care?.end).toBe('2026-12-07T18:00+09:00');
    expect(care?.options.length).toBeGreaterThan(0);
    expect(plan.requirements.find((r) => r.key === REQ)?.missingAdults).toBeUndefined();
    expect(todayCards(plan, 'a').main.map((c) => c.kind)).not.toContain('facts');
  });

  it('一人が一日見られると答えれば、もう一人が分からなくても手配は要らない（その人の答えが根拠）', () => {
    expect(careCoverage(withAnswers([answer('a', 'can')]), D)).toEqual({
      certain: [],
      unsure: [],
      missing: [],
    });
  });

  it('手が離せない時間は、見られると答えた時間からも外れ、見られない時間に入る', () => {
    const h = Household.parse({
      ...withAnswers([answer('a', 'can'), answer('b', 'cannot')]),
      unavailable: [{ id: 'u1', memberId: 'a', date: D, start: '10:00', end: '11:00' }],
    });
    expect(careCoverage(h, D).certain).toEqual([span('10:00', '11:00')]);
  });

  it('その日の答えは、ふだんの週より先に使う（答え直しの「分からない」は、ふだんの週を戻さない）', () => {
    // 健太はふだん月曜は仕事。その日は一日見られると答えた → 手配は要らない。
    expect(careCoverage(withAnswers([answer('a', 'can')], household), D).certain).toEqual([]);
    // 「分からない」と答え直すと、ふだんの週の仕事の時間には戻らず、分からないまま。
    const unknown = careCoverage(withAnswers([answer('a', 'unknown')], household), D);
    expect(unknown.certain).toEqual([]);
    expect(unknown.missing).toEqual(['a']);
    expect(unknown.unsure.length).toBeGreaterThan(0);
  });
});

describe('答えの形', () => {
  const problems = (answers: DayAnswer[]) =>
    validateHousehold(withAnswers(answers)).map((i) => i.problem);
  it('人は家の大人、同じ人の同じ日は一つ、始まりは終わりより前、見られる・見られない時間は重ならない', () => {
    expect(problems([answer('c', 'can')])).toContain('unknownRef');
    expect(problems([answer('a', 'can'), answer('a', 'unknown')])).toContain('duplicateId');
    expect(problems([answer('a', 'unknown', [['12:00', '09:00']])])).toContain('badSegment');
    expect(
      problems([answer('a', 'unknown', [['09:00', '12:00']], [['11:00', '13:00']])]),
    ).toContain('overlap');
    expect(
      problems([
        answer('a', 'unknown', [
          ['09:00', '12:00'],
          ['10:00', '11:00'],
        ]),
      ]),
    ).toContain('overlap');
    // 端が接するだけは重なりではない。
    expect(problems([answer('a', 'unknown', [['09:00', '12:00']], [['12:00', '13:00']])])).toEqual(
      [],
    );
  });
});
