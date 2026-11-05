// 子の居場所で、見守れる大人を確かめられない時間が、その日に二つ以上に分かれる時（splitGaps）。手配は一番長い
// 時間だけを受け持つので、ほかの時間を黙って落とさず、全部を出し、勧めず、選んで「はい」が来ても決める札を残す。
import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  Household,
  notificationHistory,
  notificationIntents,
  PlanResult,
  planChanges,
  type RoutineSegment,
  todayCards,
} from '../src';
import { computePlan, noAdultAtHome, requestSnapshot } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const opt = (template: string) => `opt:${CARE}:${template}`;
const ask = `task:${opt('opt-grandma')}:ask`;
const kinds = (cards: { kind: string }[]) => cards.map((c) => c.kind);

const seg = (start: string, end: string, kind: 'home' | 'away'): RoutineSegment => ({
  start,
  end,
  kind,
  placeId: kind === 'home' ? 'home' : 'st-toyosu',
  viaStationIds: [],
});

/** 12/7（月）、彩はその日だけ 10–12 時と 14–17 時に出かける。健太はいつもどおり仕事（8:10–18:15 は家にいない）。 */
const split = (segments: RoutineSegment[]) =>
  Household.parse({
    ...household,
    routineExceptions: [{ memberId: 'b', date: '2026-12-07', segments }],
  });
const twoGaps = split([
  seg('06:30', '10:00', 'home'),
  seg('10:00', '12:00', 'away'),
  seg('12:00', '14:00', 'home'),
  seg('14:00', '17:00', 'away'),
  seg('17:00', '22:30', 'home'),
]);
const MORNING = '2026-12-07T10:00+09:00/2026-12-07T12:00+09:00';
const AFTERNOON = '2026-12-07T14:00+09:00/2026-12-07T17:00+09:00';

const arrived = (h: Household = twoGaps) =>
  noticeArrived().add('householdSet', '2026-11-25T19:32+09:00', 'a', { household: h });

const asked = (h: Household = twoGaps) =>
  arrived(h)
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ask, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ask,
      assigneeId: 'b',
      action: 'accept',
    })
    .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
      taskKey: ask,
      requestId: 'r-grandma',
    });

const careOf = (events: readonly DomainEvent[], at: string) =>
  computePlan(events, at).arrangements.find((a) => a.key === CARE);
const decideIntents = (events: readonly DomainEvent[], at: string) =>
  notificationIntents(computePlan(events, at), twoGaps, notificationHistory(events))
    .filter((i) => i.titleKey === 'notify.decide')
    .map((i) => i.toMemberId);

describe('見守れる大人を確かめられない時間が分かれる日', () => {
  it('記録した時間から出る空きは二つ（ほかの大人の時間との重なり）', () => {
    expect(noAdultAtHome(twoGaps, '2026-12-07').length).toBe(2);
  });

  it('手配は一番長い時間。全部の時間を早い順に添え、勧めない', () => {
    const plan = computePlan(arrived().events, '2026-11-25T19:40+09:00');
    expect(PlanResult.safeParse(plan).success).toBe(true);
    const care = plan.arrangements.find((a) => a.key === CARE);
    expect(care?.start).toBe('2026-12-07T14:00+09:00');
    expect(care?.end).toBe('2026-12-07T17:00+09:00');
    expect(care?.reasons).toContainEqual({ code: 'splitGaps', refs: [MORNING, AFTERNOON] });
    expect(care?.status).toBe('decidable');
    expect(care?.recommendedOptionKey).toBeUndefined();
    expect(care?.recommendedReason).toBeUndefined();
  });

  it('同じ長さなら早い方を手配の時間にする', () => {
    const even = split([
      seg('06:30', '10:00', 'home'),
      seg('10:00', '12:00', 'away'),
      seg('12:00', '14:00', 'home'),
      seg('14:00', '16:00', 'away'),
      seg('16:00', '22:30', 'home'),
    ]);
    const care = careOf(arrived(even).events, '2026-11-25T19:40+09:00');
    expect(care?.start).toBe('2026-12-07T10:00+09:00');
    expect(care?.end).toBe('2026-12-07T12:00+09:00');
  });

  it('分かれていない日は今までどおり（理由を足さず、勧める）', () => {
    const care = careOf(arrived(household).events, '2026-11-25T19:40+09:00');
    expect(care?.reasons.some((r) => r.code === 'splitGaps')).toBe(false);
    expect(care?.recommendedOptionKey).toBe(opt('opt-gakudo'));
  });

  it('頼む文の控えは、手配の時間（一番長い物）だけ', () => {
    const snapshot = requestSnapshot(asked().events, '2026-11-25T19:39+09:00', ask);
    expect(snapshot.window).toEqual({
      start: '2026-12-07T14:00+09:00',
      end: '2026-12-07T17:00+09:00',
    });
  });

  it('返事を待つ間も、「はい」の後も、決める札を二人に残す。最後の時間が終われば消える', () => {
    const waiting = computePlan(asked().events, '2026-11-26T12:00+09:00');
    expect(waiting.arrangements.find((a) => a.key === CARE)?.status).toBe('dependsOnReply');
    for (const member of ['a', 'b'])
      expect(kinds(todayCards(waiting, member).main)).toContain('decide');
    expect(kinds(todayCards(waiting, 'b').quiet)).toContain('waiting');

    const yes = asked().add('externalReplyRecorded', '2026-11-27T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'yes',
    });
    const confirmed = computePlan(yes.events, '2026-12-07T12:30+09:00');
    const care = confirmed.arrangements.find((a) => a.key === CARE);
    expect(care?.inUseOptionKey).toBe(opt('opt-grandma'));
    expect(care?.reasons.find((r) => r.code === 'splitGaps')?.refs).toEqual([MORNING, AFTERNOON]);
    expect(kinds(todayCards(confirmed, 'a').main)).toContain('decide');

    const over = computePlan(yes.events, '2026-12-07T17:00+09:00');
    expect(kinds(todayCards(over, 'a').main)).not.toContain('decide');
  });

  it('一番長い時間が先に終わっても、後の時間が終わるまで札を残す', () => {
    const morningFirst = split([
      seg('06:30', '09:00', 'home'),
      seg('09:00', '12:00', 'away'),
      seg('12:00', '15:00', 'home'),
      seg('15:00', '17:00', 'away'),
      seg('17:00', '22:30', 'home'),
    ]);
    // 祖母が「はい」と答えた：決める札は、後の時間（15–17 時）が終わるまで残す。
    const yes = asked(morningFirst).add('externalReplyRecorded', '2026-11-27T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'yes',
    });
    const noon = computePlan(yes.events, '2026-12-07T12:30+09:00');
    const care = noon.arrangements.find((a) => a.key === CARE);
    expect(care?.end).toBe('2026-12-07T12:00+09:00');
    expect(care?.reasons.some((r) => r.code === 'splitGaps')).toBe(true);
    expect(kinds(todayCards(noon, 'a').main)).toContain('decide');
    const evening = computePlan(yes.events, '2026-12-07T17:00+09:00');
    expect(kinds(todayCards(evening, 'a').main)).not.toContain('decide');
    // 選んだ手が間に合わず、ほかの手も無い：「このままでは間に合いません」も、後の時間が終わるまで残す。
    const lapsed = arrived(morningFirst).add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
      role: 'primary',
    });
    const stuckNoon = computePlan(lapsed.events, '2026-12-07T12:30+09:00');
    expect(stuckNoon.arrangements.find((a) => a.key === CARE)?.status).toBe('infeasible');
    expect(kinds(todayCards(stuckNoon, 'a').main)).toContain('stuck');
    const stuckEvening = computePlan(lapsed.events, '2026-12-07T17:00+09:00');
    expect(kinds(todayCards(stuckEvening, 'a').main)).not.toContain('stuck');
  });

  it('選んだ後の札は知らせない。選び直しが要る時は、今までどおり知らせうる', () => {
    // 学童の決め時（11/30 17:20）の前の晩。祖母の返事を待つ間は、決める事を知らせない。
    expect(decideIntents(asked().events, '2026-11-29T21:00+09:00')).toEqual([]);
    // 祖母に断られた：選び直す。学童の決め時の前の晩なので、二人に知らせる。
    const no = asked().add('externalReplyRecorded', '2026-11-27T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'no',
    });
    const care = careOf(no.events, '2026-11-29T21:00+09:00');
    expect(care?.inUseOptionKey).toBeUndefined();
    expect(care?.recommendedOptionKey).toBeUndefined();
    expect(decideIntents(no.events, '2026-11-29T21:00+09:00').sort()).toEqual(['a', 'b']);
  });

  it('保存の前の「変わること」：手配の時間が動く時も、同じ時も、分かれた全部の時間を添える', () => {
    const at = '2026-11-25T19:40+09:00';
    const afternoonOnly = split([
      seg('06:30', '14:00', 'home'),
      seg('14:00', '17:00', 'away'),
      seg('17:00', '22:30', 'home'),
    ]);
    const plain = computePlan(arrived(household).events, at);
    const one = computePlan(arrived(afternoonOnly).events, at);
    const two = computePlan(arrived().events, at);
    const both = [
      { start: '2026-12-07T10:00+09:00', end: '2026-12-07T12:00+09:00' },
      { start: '2026-12-07T14:00+09:00', end: '2026-12-07T17:00+09:00' },
    ];
    expect(planChanges(plain, two).windows).toEqual([
      expect.objectContaining({
        arrangementKey: CARE,
        before: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        after: { start: '2026-12-07T14:00+09:00', end: '2026-12-07T17:00+09:00' },
        split: both,
      }),
    ]);
    // 一番長い時間は同じ（14–17 時）で、10–12 時が増える：黙って落とさない。
    expect(planChanges(one, two).windows).toEqual([
      expect.objectContaining({ arrangementKey: CARE, split: both }),
    ]);
    // 分かれていない時は、今までどおり（split を付けない）。
    expect(planChanges(plain, one).windows[0]?.split).toBeUndefined();
    expect(planChanges(two, two).windows).toEqual([]);
    // 二つが一つになる（一番長い時間は同じ）：前の分かれ方を添える（変わらないとは言わない）。
    const joined = planChanges(two, one).windows;
    expect(joined).toEqual([expect.objectContaining({ arrangementKey: CARE, splitBefore: both })]);
    expect(joined[0]?.split).toBeUndefined();
  });
});
