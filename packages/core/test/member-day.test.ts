// その日だけの一日の下書き（区間はコードが作る）と、一言から読んだ一日の確かめ（人・日・曜日・時刻。日は家族の
// 原文の言い方からコードが決めた日と比べる）。
import { describe, expect, it } from 'vitest';
import {
  draftDay,
  Household,
  memberDayReply,
  type RoutineSegment,
  toUtteranceReply,
  type UtteranceContext,
  type UtteranceOutput,
  validateHousehold,
} from '../src';
import { household } from './fixtures/demo';

const shape = (segments: RoutineSegment[]) =>
  segments.map((s) => `${s.start}-${s.end} ${s.kind}${s.placeId ? `@${s.placeId}` : ''}`);
/** 下書きを、その日だけの一日として持たせた家（検査を通るか確かめる）。 */
const withDraft = (segments: RoutineSegment[], memberId = 'b', date = '2026-12-07') =>
  Household.parse({ ...household, routineExceptions: [{ memberId, date, segments }] });
const ok = (draft: ReturnType<typeof draftDay>) => {
  if (!draft.ok) throw new Error(`作れない：${draft.problem}`);
  return draft;
};

describe('その日だけの一日の下書き', () => {
  it('休み：その日の始まりから終わりまで、一つの家の区間', () => {
    const draft = ok(draftDay(household, 'b', '2026-12-07', { change: 'off' }));
    expect(draft.base).toBe('routine');
    expect(shape(draft.segments)).toEqual(['06:30-22:30 home@home']);
    expect(validateHousehold(withDraft(draft.segments))).toEqual([]);
  });

  it('外出：その時間だけ外にし、重なる区間の前と後ろは残す', () => {
    const draft = ok(
      draftDay(household, 'b', '2026-12-07', { change: 'away', from: '10:00', to: '12:00' }),
    );
    expect(shape(draft.segments)).toEqual([
      '06:30-08:00 home@home',
      '08:00-08:40 commute',
      '08:40-10:00 work@work-b',
      '10:00-12:00 away',
      '12:00-18:30 work@work-b',
      '18:30-19:10 commute',
      '19:10-22:30 home@home',
    ]);
    expect(validateHousehold(withDraft(draft.segments))).toEqual([]);
  });

  it('外出：家の区間の中なら、家を前と後ろに分ける（土曜）', () => {
    const draft = ok(
      draftDay(household, 'b', '2026-12-12', { change: 'away', from: '13:00', to: '15:00' }),
    );
    expect(shape(draft.segments)).toEqual([
      '07:00-10:00 home@home',
      '10:00-12:00 away@st-toyosu',
      '12:00-13:00 home@home',
      '13:00-15:00 away',
      '15:00-21:00 home@home',
    ]);
  });

  it('その時間だけ家：前後が家とつながる時だけ作り、隣り合う家はまとめる', () => {
    // 土曜の外出を家に替える：一日ずっと家になる。
    const weekend = ok(
      draftDay(household, 'b', '2026-12-12', { change: 'home', from: '10:00', to: '12:00' }),
    );
    expect(shape(weekend.segments)).toEqual(['07:00-21:00 home@home']);
    // 通勤と仕事を全部覆う時間なら、行き来は要らない。
    const covered = ok(
      draftDay(household, 'b', '2026-12-07', { change: 'home', from: '07:00', to: '20:00' }),
    );
    expect(shape(covered.segments)).toEqual(['06:30-22:30 home@home']);
    expect(validateHousehold(withDraft(covered.segments))).toEqual([]);
  });

  it('その時間だけ家：仕事の途中・通勤の途中で家に移る一日は作らない（行き来の時間が分からない）', () => {
    const problem = (from: string, to: string) => {
      const draft = draftDay(household, 'b', '2026-12-07', { change: 'home', from, to });
      return draft.ok ? 'ok' : draft.problem;
    };
    expect(problem('09:00', '17:00')).toBe('travel');
    expect(problem('13:00', '22:30')).toBe('travel');
    expect(problem('06:30', '08:20')).toBe('travel');
  });

  it('外出：時刻が逆・その日とつながらない時は作らない', () => {
    expect(
      draftDay(household, 'b', '2026-12-07', { change: 'away', from: '12:00', to: '10:00' }),
    ).toEqual({
      ok: false,
      problem: 'badTime',
    });
    expect(
      draftDay(household, 'b', '2026-12-07', { change: 'away', from: '23:00', to: '23:30' }),
    ).toEqual({
      ok: false,
      problem: 'outsideDay',
    });
  });

  it('遅くなる：仕事の終わりを延ばし、帰りの通勤を同じ長さでずらす', () => {
    const draft = ok(draftDay(household, 'b', '2026-12-07', { change: 'late', to: '20:00' }));
    expect(shape(draft.segments)).toEqual([
      '06:30-08:00 home@home',
      '08:00-08:40 commute',
      '08:40-20:00 work@work-b',
      '20:00-20:40 commute',
      '20:40-22:30 home@home',
    ]);
    expect(validateHousehold(withDraft(draft.segments))).toEqual([]);
    // その日の終わりを越えて家に着く時は、家の区間を 23:59 までにする。
    const later = ok(draftDay(household, 'b', '2026-12-07', { change: 'late', to: '22:30' }));
    expect(shape(later.segments).slice(-2)).toEqual([
      '22:30-23:10 commute',
      '23:10-23:59 home@home',
    ]);
  });

  it('仕事の終わり：早く上がる日は、帰りの通勤を同じ長さで早める', () => {
    const early = ok(draftDay(household, 'b', '2026-12-07', { change: 'late', to: '15:00' }));
    expect(shape(early.segments)).toEqual([
      '06:30-08:00 home@home',
      '08:00-08:40 commute',
      '08:40-15:00 work@work-b',
      '15:00-15:40 commute',
      '15:40-22:30 home@home',
    ]);
    expect(validateHousehold(withDraft(early.segments))).toEqual([]);
  });

  it('仕事の終わり：帰り道だけをずらし、後の外出は動かさない（届くなら作らない）', () => {
    const evening = withDraft([
      { start: '06:30', end: '08:00', kind: 'home', placeId: 'home', viaStationIds: [] },
      {
        start: '08:00',
        end: '08:40',
        kind: 'commute',
        fromId: 'home',
        toId: 'work-b',
        mode: 'train',
        viaStationIds: [],
      },
      { start: '08:40', end: '18:30', kind: 'work', placeId: 'work-b', viaStationIds: [] },
      {
        start: '18:30',
        end: '19:10',
        kind: 'commute',
        fromId: 'work-b',
        toId: 'home',
        mode: 'train',
        viaStationIds: [],
      },
      { start: '19:10', end: '20:00', kind: 'home', placeId: 'home', viaStationIds: [] },
      { start: '20:00', end: '21:00', kind: 'away', viaStationIds: [] },
      { start: '21:00', end: '22:30', kind: 'home', placeId: 'home', viaStationIds: [] },
    ]);
    const early = ok(draftDay(evening, 'b', '2026-12-07', { change: 'late', to: '17:30' }));
    expect(shape(early.segments).slice(2)).toEqual([
      '08:40-17:30 work@work-b',
      '17:30-18:10 commute',
      '18:10-20:00 home@home',
      '20:00-21:00 away',
      '21:00-22:30 home@home',
    ]);
    // 遅くなって、家に着くのが外出の始まりに届くなら、外出をどうするか分からないので作らない。
    const late = draftDay(evening, 'b', '2026-12-07', { change: 'late', to: '19:30' });
    expect(late.ok ? 'ok' : late.problem).toBe('afterWork');
    // 少し遅いだけなら、外出の前に家に着く。
    const bit = ok(draftDay(evening, 'b', '2026-12-07', { change: 'late', to: '19:00' }));
    expect(shape(bit.segments).slice(3, 6)).toEqual([
      '19:00-19:40 commute',
      '19:40-20:00 home@home',
      '20:00-21:00 away',
    ]);
  });

  it('仕事の終わり：迎えのある日（早くも遅くも）・日をまたぐ・仕事の無い日・始まりより前は作らない', () => {
    const problem = (date: string, to: string) => {
      const draft = draftDay(household, 'b', date, { change: 'late', to });
      return draft.ok ? 'ok' : draft.problem;
    };
    expect(problem('2026-12-08', '19:00')).toBe('pickup');
    expect(problem('2026-12-08', '16:00')).toBe('pickup');
    expect(problem('2026-12-07', '23:30')).toBe('overnight');
    expect(problem('2026-12-12', '19:00')).toBe('noWork');
    expect(problem('2026-12-07', '08:00')).toBe('badTime');
  });

  it('その日だけの一日がもうあれば、それを元にする', () => {
    const recorded = withDraft([
      { start: '06:30', end: '22:30', kind: 'home', placeId: 'home', viaStationIds: [] },
    ]);
    const draft = ok(
      draftDay(recorded, 'b', '2026-12-07', { change: 'away', from: '10:00', to: '11:00' }),
    );
    expect(draft.base).toBe('exception');
    expect(shape(draft.segments)).toEqual([
      '06:30-10:00 home@home',
      '10:00-11:00 away',
      '11:00-22:30 home@home',
    ]);
  });

  it('区間の無い人・日は作らない', () => {
    expect(draftDay(household, 'c', '2026-12-07', { change: 'off' })).toEqual({
      ok: false,
      problem: 'noDay',
    });
  });
});

const context: UtteranceContext = {
  now: '2026-11-29T21:00+09:00',
  timeZone: 'Asia/Tokyo',
  speaker: { id: 'b', name: '彩' },
  members: [
    { id: 'a', name: '健太', kind: 'adult' },
    { id: 'b', name: '彩', kind: 'adult' },
    { id: 'c', name: '陽菜', kind: 'child' },
  ],
  utterance: '12/7 に私が休めたら？',
  tasks: [],
  requests: [],
  unknowns: [],
  items: [],
};
const day = (fields: Partial<NonNullable<UtteranceOutput['memberDay']>>) => ({
  mode: 'hypothetical' as const,
  memberId: 'b',
  date: '2026-12-07',
  dateText: '12/7',
  change: 'off' as const,
  from: null,
  to: null,
  ...fields,
});
/** その一言（原文）を聞いた時の前提。 */
const saying = (utterance: string, now = context.now): UtteranceContext => ({
  ...context,
  utterance,
  now,
});
const output = (memberDay: UtteranceOutput['memberDay']): UtteranceOutput => ({
  kind: 'memberDay',
  actions: [],
  refs: { taskKeys: [], requestIds: [], itemIds: [] },
  unsupported: null,
  memberDay,
});

describe('一言から読んだ一日の確かめ', () => {
  it('人・日・時刻が決まれば、問題なしで返す（記録の候補は作らない）', () => {
    const reply = toUtteranceReply(output(day({})), context, () => 'r');
    expect(reply).toEqual({
      kind: 'memberDay',
      day: { mode: 'hypothetical', change: 'off', memberId: 'b', date: '2026-12-07', problems: [] },
    });
  });

  it('大人でない人・過ぎた日・曜日の食い違いは、決められない欄として返す', () => {
    expect(memberDayReply(day({ memberId: 'c' }), context).problems).toEqual(['person']);
    expect(
      memberDayReply(day({ date: '2026-11-28' }), saying('11/28 に休んでいたら？')).problems,
    ).toEqual(['date']);
    expect(memberDayReply(day({}), saying('12/7（金）に休んだら？')).problems).toEqual(['weekday']);
    expect(memberDayReply(day({}), saying('12/7(月)に休んだら？')).problems).toEqual([]);
    expect(memberDayReply(day({}), saying('12/7 月曜日に休んだら？')).problems).toEqual([]);
    // 「12月8日」の月・日は曜日でない（食い違いにしない）。
    expect(
      memberDayReply(day({ date: '2026-12-08' }), saying('12月8日に休んだら？')).problems,
    ).toEqual([]);
    expect(
      memberDayReply(day({ date: '2026-12-08' }), saying('12月8日（月）に休んだら？')).problems,
    ).toEqual(['weekday']);
  });

  it('日は家族の原文から決めた日と比べ、違えば黙って直さずに聞く（モデルの写した言い方は使わない）', () => {
    // 11/29（日）の「明日」は 11/30。モデルが 12/7 と読んでも、言い方の控えを「明日」と書いても通さない。
    const tomorrow = saying('明日、彩が休んだら？');
    const wrong = memberDayReply(day({ date: '2026-12-07', dateText: '明日' }), tomorrow);
    expect(wrong.problems).toEqual(['date']);
    expect(wrong.date).toBeUndefined();
    expect(memberDayReply(day({ date: '2026-11-30', dateText: '明日' }), tomorrow)).toMatchObject({
      date: '2026-11-30',
      problems: [],
    });
    // モデルが日を読めなかった・原文に日の言い方が無い・原文の 12/7 をモデルが 12/8 と読んだ時も聞く。
    expect(memberDayReply(day({ date: null }), tomorrow).problems).toEqual(['date']);
    expect(memberDayReply(day({ date: '2026-11-30' }), saying('彩が休んだら？')).problems).toEqual([
      'date',
    ]);
    expect(memberDayReply(day({ date: '2026-12-08', dateText: '12/7' }), context).problems).toEqual(
      ['date'],
    );
    // 原文に年があれば、その年でない日は受けない（年を落として今年にしない）。
    expect(
      memberDayReply(day({ date: '2026-12-07' }), saying('What if I take December 7, 2027 off?'))
        .problems,
    ).toEqual(['date']);
    // 日の言い方を含む家の人の名前（「明日香」）は日として読まない。名前のほかに「明日」と言えば読む。
    const asuka = [...context.members, { id: 'd', name: '明日香', kind: 'adult' }];
    expect(
      memberDayReply(day({ memberId: 'd', date: '2026-11-30' }), {
        ...saying('明日香が休んだら？'),
        members: asuka,
      }).problems,
    ).toEqual(['date']);
    expect(
      memberDayReply(day({ memberId: 'd', date: '2026-11-30' }), {
        ...saying('明日香が明日休んだら？'),
        members: asuka,
      }).problems,
    ).toEqual([]);
    // 英語の原文も同じ。
    const english = saying('What if Aya takes tomorrow off?');
    expect(memberDayReply(day({ date: '2026-11-30' }), english).problems).toEqual([]);
    expect(memberDayReply(day({ date: '2026-12-07' }), english).problems).toEqual(['date']);
  });

  it('週の始まりや「next」の取り方で日が変わる言い方は、どの日を読んでも聞く', () => {
    // 11/29 は日曜：「来週の月曜」は、週を月曜から数えれば 11/30、日曜から数えれば 12/7。
    const nextMonday = saying('来週の月曜に休んだら？');
    expect(memberDayReply(day({ date: '2026-11-30' }), nextMonday).problems).toEqual(['date']);
    expect(memberDayReply(day({ date: '2026-12-07' }), nextMonday).problems).toEqual(['date']);
    expect(
      memberDayReply(day({ date: '2026-12-07' }), saying('What if I take next Monday off?'))
        .problems,
    ).toEqual(['date']);
    // 水曜（12/2）なら、どちらで数えても来週の月曜は 12/7。
    const wednesday = '2026-12-02T08:00+09:00';
    expect(
      memberDayReply(day({ date: '2026-12-07' }), saying('来週の月曜に休んだら？', wednesday))
        .problems,
    ).toEqual([]);
    expect(
      memberDayReply(
        day({ date: '2026-12-07' }),
        saying('What if I take next Monday off?', wednesday),
      ).problems,
    ).toEqual([]);
  });

  it('外出は始まりと終わり、遅くなるは終わりが要る（言われていない時刻は推さない）', () => {
    expect(memberDayReply(day({ change: 'away' }), context).problems).toEqual(['time']);
    expect(
      memberDayReply(day({ change: 'away', from: '10:00', to: '12:00' }), context).problems,
    ).toEqual([]);
    expect(memberDayReply(day({ change: 'late' }), context).problems).toEqual(['time']);
    expect(memberDayReply(day({ change: 'late', to: '25:00' }), context).problems).toEqual([
      'time',
    ]);
  });

  it('その時間だけ家は始まりと終わりが要り、時刻の付いた一日の休みは決められない欄にする', () => {
    expect(memberDayReply(day({ change: 'home' }), context).problems).toEqual(['time']);
    expect(
      memberDayReply(day({ change: 'home', from: '09:00', to: '17:00' }), context).problems,
    ).toEqual([]);
    expect(
      memberDayReply(day({ change: 'off', from: '09:00', to: '17:00' }), context).problems,
    ).toEqual(['time']);
    expect(memberDayReply(day({ change: 'off', to: '17:00' }), context).problems).toEqual(['time']);
  });

  it('仮か本当か決められない時は、そのまま返す', () => {
    expect(memberDayReply(day({ mode: 'undetermined' }), context).mode).toBe('undetermined');
  });

  it('一日の欄が無い・本当と仮が混ざる出力からは、一日の話を作らない', () => {
    expect(toUtteranceReply(output(null), context, () => 'r')).toEqual({
      kind: 'unsupported',
      reason: 'routineChange',
    });
    expect(
      toUtteranceReply({ ...output(day({})), unsupported: 'replyOrWhatIf' }, context, () => 'r'),
    ).toEqual({ kind: 'unsupported', reason: 'replyOrWhatIf' });
  });
});
