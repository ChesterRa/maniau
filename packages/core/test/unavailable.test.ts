// 手が離せない時間（家庭の unavailable）：家にいても子を見守れず、作業も置かない。場所の区間は切らず、使う所で除く。
import { describe, expect, it } from 'vitest';
import { Household, proposalSnapshot, type Unavailable, validateHousehold } from '../src';
import {
  careCoverage,
  computePlan,
  noAdultAtHome,
  placeStep,
  purchaseOpportunities,
} from '../src/engine';
import { zonedToEpochMinutes } from '../src/time';
import { household, noticeArrived } from './fixtures/demo';

const busy = (
  memberId: string,
  date: string,
  start: string,
  end: string,
  id = 'u1',
): Unavailable => ({
  id,
  memberId,
  date,
  start,
  end,
});
const withBusy = (list: Unavailable[], h: Household = household) =>
  Household.parse({ ...h, unavailable: list });
const at = (date: string, time: string) => zonedToEpochMinutes(date, time, 'Asia/Tokyo');
const span = (date: string, from: string, to: string) => ({
  start: at(date, from),
  end: at(date, to),
});

const CARE = 'arr:childCare:i4:c';
const SHIRT = 'arr:purchase:i3';

describe('手が離せない時間の形', () => {
  it('前からの家の情報には欄を足さない（無いのは、記録が無い）', () => {
    expect(household.unavailable).toBeUndefined();
    expect(validateHousehold(withBusy([busy('a', '2026-12-07', '09:00', '10:00')]))).toEqual([]);
  });

  it('人は家の大人、始まりは終わりより前、同じ人の同じ日は重ならない、ID は一意', () => {
    const problems = (list: Unavailable[]) =>
      validateHousehold(withBusy(list)).map((i) => i.problem);
    expect(problems([busy('c', '2026-12-07', '09:00', '10:00')])).toContain('unknownRef');
    expect(problems([busy('nobody', '2026-12-07', '09:00', '10:00')])).toContain('unknownRef');
    expect(problems([busy('a', '2026-12-07', '10:00', '10:00')])).toContain('badSegment');
    expect(
      problems([
        busy('a', '2026-12-07', '09:00', '10:00', 'u1'),
        busy('a', '2026-12-07', '09:30', '11:00', 'u2'),
      ]),
    ).toContain('overlap');
    // 端が接するだけ・別の人・別の日は重なりではない。
    expect(
      problems([
        busy('a', '2026-12-07', '09:00', '10:00', 'u1'),
        busy('a', '2026-12-07', '10:00', '11:00', 'u2'),
        busy('b', '2026-12-07', '09:30', '10:30', 'u3'),
        busy('a', '2026-12-08', '09:30', '10:30', 'u4'),
      ]),
    ).toEqual([]);
    expect(
      problems([
        busy('a', '2026-12-07', '09:00', '10:00', 'u1'),
        busy('b', '2026-12-08', '09:00', '10:00', 'u1'),
      ]),
    ).toContain('duplicateId');
  });
});

describe('見守れる大人がいない時間（noAdultAtHome）', () => {
  // 12/7（月）、彩はその日休み（一日家）。健太はいつもどおり仕事。
  const bOff = Household.parse({
    ...household,
    routineExceptions: [
      {
        memberId: 'b',
        date: '2026-12-07',
        segments: [
          { start: '06:30', end: '22:30', kind: 'home', placeId: 'home', viaStationIds: [] },
        ],
      },
    ],
  });

  it('家にいる大人も、手が離せない間は子を見守れない', () => {
    expect(noAdultAtHome(bOff, '2026-12-07')).toEqual([]);
    expect(
      noAdultAtHome(withBusy([busy('b', '2026-12-07', '10:00', '11:00')], bOff), '2026-12-07'),
    ).toEqual([span('2026-12-07', '10:00', '11:00')]);
  });

  it('その日の区間の無い大人は分からない：ほかの大人が家の外でも、手配の要る時間にせず、分からない時間として出す', () => {
    const noA = Household.parse({
      ...household,
      routines: household.routines.filter((r) => !(r.memberId === 'a' && r.weekday === 1)),
    });
    const before = careCoverage(noA, '2026-12-07');
    expect(before.certain).toEqual([]);
    expect(before.missing).toEqual(['a']);
    expect(before.unsure.length).toBeGreaterThan(0);
    // 手が離せない時間は、その人が見られないと分かる時間：彩も家の外の時間なら、そこだけ手配が要る。
    expect(
      noAdultAtHome(withBusy([busy('a', '2026-12-07', '09:00', '10:00')], noA), '2026-12-07'),
    ).toEqual([span('2026-12-07', '09:00', '10:00')]);
  });

  it('どの大人にも区間が無い日：全員の手が離せない時間の重なりだけが、手配の要る時間', () => {
    const none = Household.parse({
      ...household,
      routines: household.routines.filter((r) => r.weekday !== 1),
    });
    expect(noAdultAtHome(none, '2026-12-07')).toEqual([]);
    const both = withBusy(
      [
        busy('a', '2026-12-07', '09:00', '10:00', 'u1'),
        busy('b', '2026-12-07', '09:00', '10:00', 'u2'),
      ],
      none,
    );
    expect(noAdultAtHome(both, '2026-12-07')).toEqual([span('2026-12-07', '09:00', '10:00')]);
    // 一人の手が離せないだけでは、全員が見られないとは言わない（もう一人は分からない）。
    expect(
      noAdultAtHome(withBusy([busy('a', '2026-12-07', '09:00', '10:00')], none), '2026-12-07'),
    ).toEqual([]);
  });

  it('手が離せない時間を足しても、前からの時間は消えない（含む）', () => {
    for (const date of ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08']) {
      const before = noAdultAtHome(household, date);
      const after = noAdultAtHome(
        withBusy([
          busy('a', date, '07:00', '07:30', 'u1'),
          busy('b', date, '12:00', '13:00', 'u2'),
        ]),
        date,
      );
      for (const gap of before) {
        expect(after.some((g) => g.start <= gap.start && gap.end <= g.end)).toBe(true);
      }
    }
  });

  it('子の居場所の手配：休みの日の会議の時間が、手配の要る時間になる（二つなら分かれる）', () => {
    const plan = (h: Household) =>
      computePlan(
        noticeArrived().add('householdSet', '2026-11-25T19:32+09:00', 'a', { household: h }).events,
        '2026-11-25T19:40+09:00',
      ).arrangements.find((a) => a.key === CARE);
    expect(plan(bOff)).toBeUndefined();
    const one = plan(withBusy([busy('b', '2026-12-07', '10:00', '11:00')], bOff));
    expect([one?.start, one?.end]).toEqual(['2026-12-07T10:00+09:00', '2026-12-07T11:00+09:00']);
    const two = plan(
      withBusy(
        [
          busy('b', '2026-12-07', '10:00', '11:00', 'u1'),
          busy('b', '2026-12-07', '14:00', '15:30', 'u2'),
        ],
        bOff,
      ),
    );
    expect([two?.start, two?.end]).toEqual(['2026-12-07T14:00+09:00', '2026-12-07T15:30+09:00']);
    expect(two?.reasons.find((r) => r.code === 'splitGaps')?.refs).toEqual([
      '2026-12-07T10:00+09:00/2026-12-07T11:00+09:00',
      '2026-12-07T14:00+09:00/2026-12-07T15:30+09:00',
    ]);
  });
});

describe('作業を置く所', () => {
  // 12/1（火）、健太は 19:00–22:30 家。家で 30 分の手順を、22:00 までに終わる一番遅い所に置く。
  const step = {
    id: 's',
    titleKey: 't',
    durationMin: 30,
    segments: ['home' as const],
    waitAfterMin: 0,
  };
  const place = (h: Household) =>
    placeStep(step, 'a', h, at('2026-12-01', '19:00'), at('2026-12-01', '22:00'), []);

  it('手が離せない時間には置かない（その前に置く）', () => {
    expect(place(household)?.start).toBe(at('2026-12-01', '21:30'));
    const moved = place(withBusy([busy('a', '2026-12-01', '21:15', '22:00')]));
    expect(moved?.start).toBe(at('2026-12-01', '20:45'));
    expect(moved?.end).toBe(at('2026-12-01', '21:15'));
    // ほかの人・ほかの日の手が離せない時間は関わらない。
    expect(place(withBusy([busy('b', '2026-12-01', '21:00', '22:00')]))?.start).toBe(
      at('2026-12-01', '21:30'),
    );
  });

  it('置ける時間が全部ふさがれば、置かない', () => {
    expect(place(withBusy([busy('a', '2026-12-01', '19:00', '22:00')]))).toBeUndefined();
  });
});

describe('買い物の寄り道', () => {
  const buy = (h: Household) =>
    computePlan(
      noticeArrived()
        .add('householdSet', '2026-11-25T19:32+09:00', 'a', { household: h })
        .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
        .events,
      '2026-11-25T19:40+09:00',
    ).tasks.find((t) => t.basis.arrangementKey === SHIRT);

  it('寄る人の手が離せない時間に重なれば寄らない。家で子を見る人が手が離せない時も寄らない', () => {
    const plain = buy(household);
    expect([plain?.assigneeId, plain?.start]).toEqual(['a', '2026-11-26T18:55+09:00']);
    for (const h of [
      withBusy([busy('a', '2026-11-26', '18:50', '19:05')]),
      withBusy([busy('b', '2026-11-26', '19:00', '19:30')]),
    ]) {
      const moved = buy(h);
      expect(moved?.start).not.toBe('2026-11-26T18:55+09:00');
      expect(moved?.start).toBe('2026-11-27T19:05+09:00');
    }
  });
});

describe('外出の中の買い物', () => {
  // 健太の 11/26（木）を、13:00–16:00 に豊洲（店の駅）へ出かける一日にする。店は駅から歩いて 5 分。
  const outing = Household.parse({
    ...household,
    routineExceptions: [
      {
        memberId: 'a',
        date: '2026-11-26',
        segments: [
          { start: '06:30', end: '13:00', kind: 'home', placeId: 'home', viaStationIds: [] },
          { start: '13:00', end: '16:00', kind: 'away', placeId: 'st-toyosu', viaStationIds: [] },
          { start: '16:00', end: '22:00', kind: 'home', placeId: 'home', viaStationIds: [] },
        ],
      },
    ],
  });
  const away = (h: Household) =>
    purchaseOpportunities(
      h,
      'kidsClothing',
      15,
      at('2026-11-26', '00:00'),
      at('2026-11-26', '23:59'),
    )
      .filter(
        (o) => o.memberId === 'a' && o.slotKind === 'away' && o.storeId === 'store-clothing-toyosu',
      )
      .map((o) => [o.start, o.end]);
  const times = (from: string, to: string) => [[at('2026-11-26', from), at('2026-11-26', to)]];

  it('手が離せない時間が無ければ、外出の始まりに置く（今までどおり）', () => {
    expect(away(outing)).toEqual(times('13:05', '13:20'));
  });

  it('早い所がふさがっていても、同じ外出の後ろに往復が収まれば、その一番早い時に置く（店が開いている時）', () => {
    expect(away(withBusy([busy('a', '2026-11-26', '13:00', '13:30')], outing))).toEqual(
      times('13:35', '13:50'),
    );
    // 行き・買う・戻りの 25 分が、間の手が離せない時間に掛かる時も、その後ろへ。
    expect(away(withBusy([busy('a', '2026-11-26', '13:10', '13:20')], outing))).toEqual(
      times('13:25', '13:40'),
    );
    expect(
      away(
        withBusy(
          [
            busy('a', '2026-11-26', '13:00', '13:30'),
            busy('a', '2026-11-26', '13:40', '14:00', 'u2'),
          ],
          outing,
        ),
      ),
    ).toEqual(times('14:05', '14:20'));
    // 外出の前の手が離せない時間は関わらない。ほかの人の物も関わらない。
    expect(away(withBusy([busy('a', '2026-11-26', '12:00', '12:30')], outing))).toEqual(
      times('13:05', '13:20'),
    );
    expect(away(withBusy([busy('b', '2026-11-26', '13:00', '13:30')], outing))).toEqual(
      times('13:05', '13:20'),
    );
  });

  it('一つの外出・店に機会は一つのまま（前に置ける時は、後ろの手が離せない時間で増やさず、変えない）', () => {
    expect(away(withBusy([busy('a', '2026-11-26', '14:00', '14:30')], outing))).toEqual(
      times('13:05', '13:20'),
    );
  });

  it('外出の残りに 25 分が収まらなければ置かない', () => {
    expect(away(withBusy([busy('a', '2026-11-26', '13:00', '15:40')], outing))).toEqual([]);
  });

  it('計画：シャツを買う作業は、同じ日の外出の空いた所に置き、ほかの日へ動かさない', () => {
    const shirt = (h: Household) =>
      computePlan(
        noticeArrived()
          .add('householdSet', '2026-11-25T19:32+09:00', 'a', { household: h })
          .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
          .events,
        '2026-11-25T19:40+09:00',
      ).tasks.find((t) => t.basis.arrangementKey === SHIRT);
    expect([shirt(outing)?.assigneeId, shirt(outing)?.start]).toEqual([
      'a',
      '2026-11-26T13:05+09:00',
    ]);
    const later = shirt(withBusy([busy('a', '2026-11-26', '13:00', '13:30')], outing));
    expect([later?.assigneeId, later?.start, later?.end]).toEqual([
      'a',
      '2026-11-26T13:35+09:00',
      '2026-11-26T13:50+09:00',
    ]);
  });
});

describe('引き受けた作業に、後から手が離せない時間が重なる', () => {
  const ask = 'task:opt:arr:purchase:i3:buy:buy';
  // 健太が、見せられた時刻（11/26 18:55）で引き受けた。
  const accepted = () => {
    const log = noticeArrived().add('answered', '2026-11-25T19:35+09:00', 'b', {
      unknownId: 'u-atHome:i3',
      value: 'no',
    });
    const task = computePlan(log.events, '2026-11-25T19:36+09:00').tasks.find((t) => t.key === ask);
    const shown = task && proposalSnapshot(task);
    if (!shown) throw new Error('提案の控えが無い');
    return log.add('commitmentChanged', '2026-11-25T19:37+09:00', 'a', {
      taskKey: ask,
      assigneeId: 'a',
      action: 'accept',
      shown,
    });
  };

  it('黙って取り消さず、確かめ直しにする。外せば元に戻る', () => {
    const now = '2026-11-25T20:00+09:00';
    const first = computePlan(accepted().events, now).tasks.find((t) => t.key === ask);
    expect([first?.commitment, first?.start, first?.reconfirm]).toEqual([
      'accepted',
      '2026-11-26T18:55+09:00',
      undefined,
    ]);
    const added = accepted().add('householdSet', '2026-11-25T19:50+09:00', 'a', {
      household: withBusy([busy('a', '2026-11-26', '18:50', '19:05')]),
    });
    const moved = computePlan(added.events, now).tasks.find((t) => t.key === ask);
    expect(moved?.live).toBe(true);
    expect(moved?.reconfirm).toBe(true);
    expect(moved?.start).not.toBe('2026-11-26T18:55+09:00');
    const removed = added.add('householdSet', '2026-11-25T19:55+09:00', 'a', { household });
    const back = computePlan(removed.events, now).tasks.find((t) => t.key === ask);
    expect([back?.commitment, back?.start, back?.reconfirm]).toEqual([
      'accepted',
      '2026-11-26T18:55+09:00',
      undefined,
    ]);
  });
});
