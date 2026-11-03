// 習い事・クラブの行事の送り迎え。根拠は家の決まり（子の clubEscort）か、今回の家族の言明だけ。書かれた
// 時刻の前後に往復の目安で置き、書かれた時刻はずらさない。時刻の無い・確かめられない方は、その日の作業に
// する（黙って落とさない）。言明は、言った時の子・用件・日・時刻・場所が今と同じ時だけ当てる。
import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  type Household,
  type Item,
  notificationIntents,
  proposalSnapshot,
  type Source,
  splitSentences,
  todayCards,
} from '../src';
import { computePlan, foldEvents, liveItems } from '../src/engine';
import { EventLog, household } from './fixtures/demo';

const TEXT = [
  '12月5日(土)9:00〜11:00 サッカー練習（若洲グラウンド）',
  '雨天の場合は中止します。',
].join('\n');

const notice = (sender: Source['sender'] = 'club', text = TEXT): Source => ({
  id: 'k1',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender,
  language: 'ja',
  medium: 'text',
  title: 'サッカークラブのお知らせ',
  sentences: splitSentences(text, 'k1'),
});

const practice = (interpretation: Partial<Item['interpretation']> = {}): Item => ({
  id: 'e1',
  sourceId: 'k1',
  sentenceIds: ['k1#1'],
  kind: 'event',
  written: '12月5日(土)9:00〜11:00 サッカー練習（若洲グラウンド）',
  interpretation: {
    what: 'サッカー練習',
    date: '2026-12-05',
    writtenWeekday: 6,
    startTime: '09:00',
    endTime: '11:00',
    place: '若洲グラウンド',
    ...interpretation,
  },
  evidence: 'stated',
  effects: [],
});

const extraction = (item: Item, rain = false): Extraction => ({
  sourceId: 'k1',
  unknowns: rain
    ? [{ id: 'u-rain', label: '当日の天気が雨か', values: ['yes', 'no'], kind: 'other' }]
    : [],
  conditions: rain ? [{ id: 'c-dry', kind: 'eq', unknownId: 'u-rain', value: 'no' }] : [],
  items: [rain ? { ...item, conditionNodeId: 'c-dry' } : item],
  ambiguities: [],
  irrelevantSentenceIds: [],
});

const withChildren = (rules: Record<string, Household['members'][number]['clubEscort']>) => ({
  ...household,
  members: [
    ...household.members
      .filter((m) => m.kind !== 'child')
      .map((m) => ({ ...m, clubEscort: undefined })),
    ...Object.entries(rules).map(([id, clubEscort]) => ({
      id,
      kind: 'child' as const,
      name: id === 'c' ? '陽菜' : '架空の子',
      active: true,
      ...(clubEscort === undefined ? {} : { clubEscort }),
    })),
  ],
});

/** 家族の情報と、送り手・行事の読み取り（毎回新しい列。add は列を書き換えるので、使い回さない）。 */
const arrived = (
  options: {
    house?: Household;
    sender?: Source['sender'];
    item?: Item;
    rain?: boolean;
    text?: string;
  } = {},
) =>
  new EventLog()
    .add('householdSet', '2026-11-24T21:00+09:00', 'a', { household: options.house ?? household })
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', {
      source: notice(options.sender, options.text),
    })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-k1',
      sourceId: 'k1',
      output: extraction(options.item ?? practice(), options.rain ?? false),
    });

const NOW = '2026-11-25T20:05+09:00';
const escortsOf = (events: EventLog['events']) => {
  const plan = computePlan(events, NOW);
  return {
    requirement: plan.requirements.find((r) => r.key === 'req:escort:e1'),
    to: plan.tasks.find((t) => t.key === 'task:escort:to:e1'),
    from: plan.tasks.find((t) => t.key === 'task:escort:from:e1'),
    plan,
  };
};
const frameOf = (events: EventLog['events']) =>
  liveItems(foldEvents(events)).find((l) => l.item.id === 'e1')?.escort;
const said = (
  log: EventLog,
  leg: 'to' | 'from',
  needed: boolean,
  bound: { childId?: string; date?: string; at?: string | null; place?: string | null } = {},
) =>
  log.add('escortStated', '2026-11-25T20:06+09:00', 'b', {
    itemId: 'e1',
    leg,
    needed,
    childId: bound.childId ?? 'c',
    what: 'サッカー練習',
    date: bound.date ?? '2026-12-05',
    at: bound.at === undefined ? (leg === 'to' ? '09:00' : '11:00') : bound.at,
    place: bound.place === undefined ? '若洲グラウンド' : bound.place,
  });

describe('家の決まりからの送り迎え', () => {
  it('決まりのある子が一人なら、書かれた始まり・終わりの前後に、往復の目安で送り・迎えを作る', () => {
    const { requirement, to, from, plan } = escortsOf(arrived().events);
    expect(requirement).toMatchObject({
      kind: 'escort',
      what: 'サッカー練習',
      date: '2026-12-05',
      by: '2026-12-05T08:30+09:00',
      live: true,
    });
    expect(to).toMatchObject({
      titleKey: 'task.escortTo',
      titleParams: {
        what: 'サッカー練習',
        date: '2026-12-05',
        at: '09:00',
        place: '若洲グラウンド',
      },
      timing: 'fixed',
      earliestStart: '2026-12-05T08:30+09:00',
      deadline: '2026-12-05T09:30+09:00',
      durationMin: 60,
      commitment: 'proposed',
    });
    expect(from).toMatchObject({
      titleKey: 'task.escortFrom',
      titleParams: { at: '11:00' },
      timing: 'fixed',
      earliestStart: '2026-12-05T10:30+09:00',
      deadline: '2026-12-05T11:30+09:00',
    });
    expect(to?.assigneeId).toBeUndefined();
    // 担当の無いまま、二人の「きょう」に出す（誰かが持つ）。
    for (const member of ['a', 'b']) {
      const cards = todayCards(plan, member).main;
      expect(cards.some((c) => c.kind === 'unowned' && c.task.key === 'task:escort:to:e1')).toBe(
        true,
      );
    }
    expect(frameOf(arrived().events)).toEqual({
      childId: 'c',
      legs: [
        { leg: 'to', date: '2026-12-05', at: '09:00', needed: true },
        { leg: 'from', date: '2026-12-05', at: '11:00', needed: true },
      ],
    });
  });

  it('決まりが無い・子が二人（決まりのある子が一人でも）・学校からの行事なら、送り迎えを作らない', () => {
    const none = escortsOf(arrived({ house: withChildren({ c: undefined }) }).events);
    expect(none.requirement).toBeUndefined();
    expect(none.to).toBeUndefined();
    const two = withChildren({ c: { to: true, from: true }, d: { to: true, from: true } });
    expect(escortsOf(arrived({ house: two }).events).requirement).toBeUndefined();
    expect(frameOf(arrived({ house: two }).events)).toBeUndefined();
    // 決まりは、その子の送り迎えのしかたで、お知らせがその子の物だという根拠にはならない。
    const oneRuled = withChildren({ c: { to: true, from: true }, d: undefined });
    expect(escortsOf(arrived({ house: oneRuled }).events).requirement).toBeUndefined();
    expect(frameOf(arrived({ house: oneRuled }).events)).toBeUndefined();
    expect(escortsOf(arrived({ sender: 'school' }).events).requirement).toBeUndefined();
  });

  it('決まりが送りだけなら、迎えは作らない', () => {
    const house = withChildren({ c: { to: true, from: false } });
    const { to, from, requirement } = escortsOf(arrived({ house }).events);
    expect(to).toBeDefined();
    expect(from).toBeUndefined();
    expect(requirement?.by).toBe('2026-12-05T08:30+09:00');
  });

  it('持った人がその往復の間に空いていれば、そのまま置く（前や後にずらさない）', () => {
    const events = arrived().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: 'task:escort:to:e1',
      assigneeId: 'b',
    }).events;
    expect(escortsOf(events).to).toMatchObject({
      assigneeId: 'b',
      start: '2026-12-05T08:30+09:00',
      end: '2026-12-05T09:30+09:00',
    });
  });

  it('雨で中止の行事は、送り迎えも条件しだい。中止と分かれば、要らない', () => {
    const open = escortsOf(arrived({ rain: true }).events);
    expect(open.requirement).toMatchObject({ live: true, conditional: true });
    const rained = arrived({ rain: true }).add('answered', '2026-11-25T20:06+09:00', 'b', {
      unknownId: 'u-rain',
      value: 'yes',
    }).events;
    expect(escortsOf(rained).requirement?.live).toBe(false);
    expect(escortsOf(rained).to?.live).toBe(false);
  });
});

describe('書かれた時刻の無い・確かめられない方', () => {
  it('終わりが書かれていなければ、迎えはその日の作業にする（時刻を作らない）', () => {
    const item = practice({ endTime: undefined });
    const { from, to } = escortsOf(arrived({ item }).events);
    expect(to?.timing).toBe('fixed');
    expect(from).toMatchObject({
      timing: 'day',
      earliestStart: '2026-12-05T00:00+09:00',
      deadline: '2026-12-06T00:00+09:00',
      durationMin: 0,
    });
    expect(from?.timeUnconfirmed).toBeUndefined();
    expect(from?.titleParams.at).toBeUndefined();
  });

  it('読み取りが終わり・始まりを落とした時は、確かめてと印を付ける（書かれていないと言わない）', () => {
    const item = practice({
      startTime: undefined,
      endTime: undefined,
      startTimeUnconfirmed: true,
      endTimeUnconfirmed: true,
    });
    const { from, to, requirement } = escortsOf(arrived({ item }).events);
    expect(to).toMatchObject({ timing: 'day', timeUnconfirmed: true });
    // 落とした終わりは次の日の時刻だったかもしれないので、迎えは日も決めない（下の試験）。
    expect(from).toMatchObject({ timing: 'undated', timeUnconfirmed: true });
    // 要件の期限は、送りの日の始まり。
    expect(requirement?.by).toBe('2026-12-05T00:00+09:00');
  });

  /** 日を決められない迎え：日も時刻も締切も無く、行事の日だけを添える（迎えの日として見せない）。 */
  const undatedFrom = (from: ReturnType<typeof escortsOf>['from']) => {
    expect(from).toMatchObject({
      timing: 'undated',
      timeUnconfirmed: true,
      titleParams: { what: 'サッカー練習', eventDate: '2026-12-05' },
    });
    expect(from?.titleParams.date).toBeUndefined();
    expect(from?.titleParams.at).toBeUndefined();
    expect(from?.earliestStart).toBeUndefined();
    expect(from?.deadline).toBeUndefined();
  };

  it('読み取りが落とした終わりは、次の日の時刻だったかもしれないので、迎えの日を決めずに確かめてもらう', () => {
    // 「12月5日23:00から翌日午前1時まで」の終わりを読み違えて落とした時も、行事の日の迎えにしない。
    const item = {
      ...practice({ startTime: '23:00', endTime: undefined, endTimeUnconfirmed: true }),
      written: '12月5日23:00から翌日午前1時まで練習します。',
    };
    const { from, to } = escortsOf(arrived({ item }).events);
    undatedFrom(from);
    expect(to).toMatchObject({ timing: 'fixed', titleParams: { date: '2026-12-05', at: '23:00' } });
    // 「翌日」が無くても、落とした終わりの日は分からない。
    const plain = practice({ endTime: undefined, endTimeUnconfirmed: true });
    undatedFrom(escortsOf(arrived({ item: plain }).events).from);
  });

  it('終わりが書かれていなくても、「翌日」などとあれば、迎えの日を決めずに確かめてもらう', () => {
    const item = {
      ...practice({ startTime: '22:00', endTime: undefined }),
      written: '12月5日22:00から翌朝まで練習します。',
    };
    undatedFrom(escortsOf(arrived({ item }).events).from);
  });

  it('始まりが無い時の終わりは、その日か次の日か決められないので、日も時刻も付けずに確かめてもらう', () => {
    for (const endTime of ['01:00', '16:00']) {
      const item = practice({ startTime: undefined, endTime });
      const { from, to } = escortsOf(arrived({ item }).events);
      undatedFrom(from);
      expect(to).toMatchObject({ timing: 'day' });
      expect(to?.timeUnconfirmed).toBeUndefined();
    }
  });

  it('「翌日」と書かれた終わりを、時刻の大小だけで同じ日にしない', () => {
    const long = {
      ...practice({ startTime: '09:00', endTime: '10:00' }),
      written: '12月6日09:00から翌日10:00まで練習します。',
    };
    const unread = escortsOf(arrived({ item: long }).events);
    undatedFrom(unread.from);
    expect(unread.to).toMatchObject({ timing: 'fixed', titleParams: { at: '09:00' } });
    // 読み取りの引用が短くても（「練習」）、指した文に「翌日」があれば同じ日にしない。
    const short = { ...practice({ startTime: '09:00', endTime: '10:00' }), written: '練習' };
    const text = '12月5日(土)09:00から翌日10:00まで練習します。';
    undatedFrom(escortsOf(arrived({ item: short, text }).events).from);
    // 「翌晩」「次の朝」も次の日を言う（18:00 から翌晩 20:00 の合宿を、同じ日の 20:00 にしない）。
    for (const written of [
      '12月5日18:00から翌晩20:00まで合宿',
      '12月5日18:00から次の朝20:00まで',
    ]) {
      const camp = { ...practice({ startTime: '18:00', endTime: '20:00' }), written };
      undatedFrom(escortsOf(arrived({ item: camp }).events).from);
    }
    const night = {
      ...practice({ startTime: '23:00', endTime: '01:00' }),
      written: '12月5日23:00から翌日01:00まで',
    };
    expect(escortsOf(arrived({ item: night }).events).from).toMatchObject({
      timing: 'fixed',
      titleParams: { date: '2026-12-06', at: '01:00' },
    });
  });

  it('終わりが始まり以前の時刻なら、12 時間までは次の日の迎えにし、ほかは確かめてもらう', () => {
    const night = practice({ startTime: '23:00', endTime: '01:00' });
    const overnight = escortsOf(arrived({ item: night }).events);
    expect(overnight.from).toMatchObject({
      timing: 'fixed',
      titleParams: { date: '2026-12-06', at: '01:00' },
      earliestStart: '2026-12-06T00:30+09:00',
      deadline: '2026-12-06T01:30+09:00',
    });
    // 開始の前の、同じ日の 1:00 には置かない。
    expect(overnight.to?.earliestStart).toBe('2026-12-05T22:30+09:00');
    const odd = practice({ startTime: '10:00', endTime: '09:00' });
    undatedFrom(escortsOf(arrived({ item: odd }).events).from);
  });
});

describe('今回の言明', () => {
  it('「今回は要らない」と言った方は作らず、どちらも要らなければ要件も作らない', () => {
    const oneOff = said(arrived(), 'from', false).events;
    const one = escortsOf(oneOff);
    expect(one.to).toBeDefined();
    expect(one.from).toBeUndefined();
    expect(frameOf(oneOff)?.legs[1]).toMatchObject({ leg: 'from', needed: false, stated: true });
    const both = said(said(arrived(), 'from', false), 'to', false).events;
    expect(escortsOf(both).requirement).toBeUndefined();
    // 行事そのもの（よていに出す事項）は変えない。
    expect(liveItems(foldEvents(both)).find((l) => l.item.id === 'e1')).toMatchObject({
      live: true,
      trusted: true,
    });
  });

  it('決まりに無い方も、今回は要ると言えば作る。言い直せば、家の決まりと同じでも言明として示す', () => {
    const house = withChildren({ c: { to: true, from: false } });
    const added = said(arrived({ house }), 'from', true).events;
    expect(escortsOf(added).from).toMatchObject({ timing: 'fixed', titleParams: { at: '11:00' } });
    expect(frameOf(added)?.legs[1]).toMatchObject({ needed: true, stated: true });
    const back = said(said(arrived(), 'from', false), 'from', true).events;
    expect(escortsOf(back).from).toBeDefined();
    expect(frameOf(back)?.legs[1]).toMatchObject({ needed: true, stated: true });
  });

  it('場所・時刻・日が直されたら、前の「要らない」を当てない', () => {
    const moved = said(arrived(), 'from', false).add(
      'itemCorrected',
      '2026-11-25T20:07+09:00',
      'a',
      { itemId: 'e1', interpretation: { place: '夢の島グラウンド' } },
    ).events;
    expect(escortsOf(moved).from).toMatchObject({ titleParams: { place: '夢の島グラウンド' } });
    expect(frameOf(moved)?.legs[1]?.stated).toBeUndefined();
    const later = said(arrived(), 'from', false).add(
      'itemCorrected',
      '2026-11-25T20:07+09:00',
      'a',
      { itemId: 'e1', interpretation: { endTime: '12:00' } },
    ).events;
    expect(escortsOf(later).from).toMatchObject({ titleParams: { at: '12:00' } });
  });

  it('決まりのある子が替われば、前の子についての言明を当てない', () => {
    const switched = said(arrived(), 'from', false).add(
      'householdSet',
      '2026-11-25T20:07+09:00',
      'a',
      { household: withChildren({ d: { to: true, from: true } }) },
    ).events;
    expect(frameOf(switched)).toMatchObject({ childId: 'd' });
    expect(escortsOf(switched).from).toBeDefined();
  });

  it('言った時と違う子・日・時刻・場所で控えた言明は当てない（どれか一つでも）', () => {
    for (const bound of [
      { childId: 'd' },
      { date: '2026-12-06' },
      { at: '10:00' },
      { at: null },
      { place: null },
    ]) {
      expect(escortsOf(said(arrived(), 'from', false, bound).events).from).toBeDefined();
    }
  });

  it('読み取りに無い事項への言明は、記録に残っても使わない', () => {
    const log = arrived().add('escortStated', '2026-11-25T20:06+09:00', 'b', {
      itemId: 'nope',
      leg: 'from',
      needed: false,
      childId: 'c',
      what: 'サッカー練習',
      date: '2026-12-05',
      at: '11:00',
      place: '若洲グラウンド',
    });
    const state = foldEvents(log.events);
    expect(state.rejected.some((r) => r.reason === '読み取りに無い事項への言明')).toBe(true);
    expect(escortsOf(log.events).from).toBeDefined();
  });
});

// 引き受けた後に、もう要らなくなった送り迎え（後のお知らせの取り消し、条件が外れた）。本人だけに一番上の札と
// 知らせを出し、約束した時（引き受けた時の控え）で知らせる幅と終わりを決める。本人が分かったと言うまで残す。
describe('引き受けた後に要らなくなった送り迎え', () => {
  const TO = 'task:escort:to:e1';
  /** b が送りを持ち、引き受ける（その時の控えを付ける）。 */
  const accepted = (log: EventLog) => {
    log.add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', { taskKey: TO, assigneeId: 'b' });
    const task = computePlan(log.events, NOW).tasks.find((t) => t.key === TO);
    const shown = task ? proposalSnapshot(task) : undefined;
    if (!shown) throw new Error('控えが無い');
    return log.add('commitmentChanged', '2026-11-25T20:07+09:00', 'b', {
      taskKey: TO,
      assigneeId: 'b',
      action: 'accept',
      shown,
      basisItemIds: ['e1'],
      basisSourceIds: ['k1'],
    });
  };
  const CANCEL = '雨のため、12月5日(土)の練習は中止します。';
  /** 後から、練習を取り消すお知らせが届く。 */
  const cancelled = (log: EventLog, at: string) =>
    log
      .add('noticeReceived', at, 'b', {
        source: { ...notice(), id: 'k2', receivedAt: at, sentences: splitSentences(CANCEL, 'k2') },
      })
      .add('modelOutputRecorded', at, 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-k2',
        sourceId: 'k2',
        output: {
          sourceId: 'k2',
          unknowns: [],
          conditions: [],
          items: [
            {
              id: 'x1',
              sourceId: 'k2',
              sentenceIds: ['k2#1'],
              kind: 'event',
              written: CANCEL,
              interpretation: { what: 'サッカー練習の中止', date: '2026-12-05', writtenWeekday: 6 },
              evidence: 'stated',
              effects: [{ type: 'cancel', itemId: 'e1' }],
            },
          ],
          ambiguities: [],
          irrelevantSentenceIds: [],
        },
      });
  const intentsAt = (events: EventLog['events'], now: string) =>
    notificationIntents(computePlan(events, now), household).filter((i) =>
      i.key.startsWith('released:'),
    );

  it('出発の30分前に中止が届けば、持った本人だけに一番上の札を出し、すぐ知らせる', () => {
    const events = cancelled(accepted(arrived()), '2026-12-05T08:00+09:00').events;
    const plan = computePlan(events, '2026-12-05T08:00+09:00');
    expect(plan.tasks.some((t) => t.key === TO)).toBe(false);
    // 中止のお知らせの事項には、送り迎えを作らない。
    expect(plan.tasks.some((t) => t.basis.itemIds.includes('x1'))).toBe(false);
    expect(plan.released).toEqual([
      {
        taskKey: TO,
        assigneeId: 'b',
        content: {
          titleKey: 'task.escortTo',
          titleParams: {
            what: 'サッカー練習',
            date: '2026-12-05',
            at: '09:00',
            place: '若洲グラウンド',
          },
        },
        start: '2026-12-05T08:30+09:00',
        end: '2026-12-05T09:30+09:00',
        reason: 'gone',
      },
    ]);
    expect(todayCards(plan, 'b').main[0]).toMatchObject({ kind: 'released' });
    expect(todayCards(plan, 'a').main.some((c) => c.kind === 'released')).toBe(false);
    expect(intentsAt(events, '2026-12-05T08:00+09:00')).toEqual([
      {
        key: `released:${TO}:b`,
        subject: { type: 'task', id: TO },
        toMemberId: 'b',
        kind: 'assignment',
        titleKey: 'notify.released',
        until: '2026-12-05T09:30+09:00',
        actBy: '2026-12-05T08:30+09:00',
      },
    ]);
  });

  it('出発の後、終わる前に届いても知らせ、終わった後は出さない。遠い日の中止は札だけ', () => {
    const late = cancelled(accepted(arrived()), '2026-12-05T08:45+09:00').events;
    expect(intentsAt(late, '2026-12-05T08:45+09:00')).toHaveLength(1);
    expect(computePlan(late, '2026-12-05T09:30+09:00').released).toBeUndefined();
    expect(intentsAt(late, '2026-12-05T09:30+09:00')).toEqual([]);
    const early = cancelled(accepted(arrived()), '2026-11-28T10:00+09:00').events;
    const plan = computePlan(early, '2026-11-28T10:00+09:00');
    expect(todayCards(plan, 'b').main[0]).toMatchObject({ kind: 'released' });
    expect(intentsAt(early, '2026-11-28T10:00+09:00')).toEqual([]);
    expect(intentsAt(early, '2026-12-04T07:00+09:00')).toHaveLength(1);
  });

  it('分かったと言えば消える。その後に中止が取り下げられたら、だれも持っていない送りに戻る', () => {
    const log = cancelled(accepted(arrived()), '2026-12-05T08:00+09:00').add(
      'commitmentChanged',
      '2026-12-05T08:01+09:00',
      'b',
      { taskKey: TO, assigneeId: 'b', action: 'withdraw' },
    );
    expect(computePlan(log.events, '2026-12-05T08:01+09:00').released).toBeUndefined();
    const back = log.add('sourceWithdrawn', '2026-12-05T08:02+09:00', 'a', { sourceId: 'k2' });
    const plan = computePlan(back.events, '2026-12-05T08:02+09:00');
    expect(plan.tasks.find((t) => t.key === TO)?.commitment).toBe('withdrawn');
    expect(todayCards(plan, 'a').main.some((c) => c.kind === 'unowned' && c.task.key === TO)).toBe(
      true,
    );
  });

  it('「もう要らない」と知らせた後に戻った送りは、前の引き受けのまま当てず、本人に確かめ直してもらう', () => {
    const log = cancelled(accepted(arrived()), '2026-12-05T08:00+09:00')
      .add('notified', '2026-12-05T08:00+09:00', 'system', {
        notificationKey: `released:${TO}:b#1`,
        toMemberId: 'b',
        channel: 'webPush',
        result: 'accepted',
        kind: 'assignment',
        content: { titleKey: 'notify.released', params: {} },
        appVersion: 'fixture',
      })
      .add('sourceWithdrawn', '2026-12-05T08:02+09:00', 'a', { sourceId: 'k2' });
    const plan = computePlan(log.events, '2026-12-05T08:02+09:00');
    expect(plan.tasks.find((t) => t.key === TO)).toMatchObject({
      commitment: 'accepted',
      reconfirm: true,
    });
    expect(todayCards(plan, 'b').main.some((c) => c.kind === 'proposal' && c.task.key === TO)).toBe(
      true,
    );
    // 引き受け直せば、確かめ直しは消える。
    const task = plan.tasks.find((t) => t.key === TO);
    const shown = task ? proposalSnapshot(task) : undefined;
    if (!shown) throw new Error('控えが無い');
    const again = log.add('commitmentChanged', '2026-12-05T08:03+09:00', 'b', {
      taskKey: TO,
      assigneeId: 'b',
      action: 'accept',
      shown,
    });
    expect(
      computePlan(again.events, '2026-12-05T08:03+09:00').tasks.find((t) => t.key === TO)
        ?.reconfirm,
    ).toBeUndefined();
  });

  it('分かったと言う前に中止が取り下げられたら、元の引き受けのまま戻る', () => {
    const back = cancelled(accepted(arrived()), '2026-12-05T08:00+09:00').add(
      'sourceWithdrawn',
      '2026-12-05T08:02+09:00',
      'a',
      { sourceId: 'k2' },
    );
    const plan = computePlan(back.events, '2026-12-05T08:02+09:00');
    expect(plan.released).toBeUndefined();
    expect(plan.tasks.find((t) => t.key === TO)?.commitment).toBe('accepted');
  });

  it('条件が外れた時も、引き受けた時の控え（後で直された時刻ではない）で知らせる', () => {
    // 9:00 で引き受けた後に 10:00 へ直され（まだ引き受け直していない）、雨で中止と答えが入った。
    const log = accepted(arrived({ rain: true }))
      .add('itemCorrected', '2026-11-26T09:00+09:00', 'a', {
        itemId: 'e1',
        interpretation: { startTime: '10:00' },
      })
      .add('answered', '2026-12-05T07:00+09:00', 'a', { unknownId: 'u-rain', value: 'yes' });
    const plan = computePlan(log.events, '2026-12-05T07:00+09:00');
    expect(plan.tasks.find((t) => t.key === TO)?.live).toBe(false);
    expect(plan.released).toEqual([
      expect.objectContaining({
        taskKey: TO,
        start: '2026-12-05T08:30+09:00',
        end: '2026-12-05T09:30+09:00',
        reason: 'notLive',
        content: expect.objectContaining({ titleParams: expect.objectContaining({ at: '09:00' }) }),
      }),
    ]);
  });

  it('根拠の分からない古い引き受けは、要らないとは言わずに確かめてと出し、時刻が無いのですぐ知らせる', () => {
    const log = arrived()
      .add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', { taskKey: TO, assigneeId: 'b' })
      .add('commitmentChanged', '2026-11-25T20:07+09:00', 'b', {
        taskKey: TO,
        assigneeId: 'b',
        action: 'accept',
      });
    const events = cancelled(log, '2026-11-28T10:00+09:00').events;
    const plan = computePlan(events, '2026-11-28T10:00+09:00');
    expect(plan.released).toEqual([{ taskKey: TO, assigneeId: 'b', reason: 'unconfirmed' }]);
    expect(
      notificationIntents(plan, household).filter((i) => i.key.startsWith('releasedCheck:')),
    ).toEqual([
      {
        key: `releasedCheck:${TO}:b`,
        subject: { type: 'task', id: TO },
        toMemberId: 'b',
        kind: 'assignment',
        titleKey: 'notify.releasedCheck',
      },
    ]);
  });

  it('根拠の分からない古い引き受けも、家庭のお知らせを消した後は、中身も時刻も出さない', () => {
    const legacy = arrived()
      .add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', { taskKey: TO, assigneeId: 'b' })
      .add('commitmentChanged', '2026-11-25T20:07+09:00', 'b', {
        taskKey: TO,
        assigneeId: 'b',
        action: 'accept',
        shown: {
          start: '2026-12-05T08:30+09:00',
          end: '2026-12-05T09:30+09:00',
          titleKey: 'task.escortTo',
          titleParams: { what: 'サッカー練習', date: '2026-12-05', at: '09:00' },
          travelBeforeMin: 0,
          travelAfterMin: 0,
        },
      })
      .add('sourceContentPurged', '2026-12-04T10:00+09:00', 'system', {
        sourceId: 'k1',
        scope: 'all',
      });
    const plan = computePlan(legacy.events, '2026-12-04T10:00+09:00');
    expect(plan.released).toEqual([{ taskKey: TO, assigneeId: 'b', reason: 'unconfirmed' }]);
  });

  it('根拠のお知らせを消したら、要らないとは言わず、消した中身も時刻も出さずに確かめてと出す', () => {
    const events = accepted(arrived()).add(
      'sourceContentPurged',
      '2026-12-04T10:00+09:00',
      'system',
      {
        sourceId: 'k1',
        scope: 'all',
      },
    ).events;
    const plan = computePlan(events, '2026-12-04T10:00+09:00');
    expect(plan.tasks.some((t) => t.key === TO)).toBe(false);
    expect(plan.released).toEqual([{ taskKey: TO, assigneeId: 'b', reason: 'unconfirmed' }]);
    expect(JSON.stringify(plan.released)).not.toContain('サッカー');
  });

  it('読み直しで元の事項が見つからない・別の物になった・子が増えた時は、要らないとは言わず確かめてと出す（関係ない・取り下げは要らない）', () => {
    const reread = accepted(arrived())
      .add('transcriptionCorrected', '2026-12-04T10:00+09:00', 'b', {
        sourceId: 'k1',
        sourceVersion: 2,
        sentences: splitSentences(TEXT, 'k1'),
      })
      .add('modelOutputRecorded', '2026-12-04T10:01+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-k1-v2',
        sourceId: 'k1',
        sourceVersion: 2,
        output: { ...extraction(practice()), items: [] },
      });
    const missing = computePlan(reread.events, '2026-12-04T10:01+09:00');
    expect(missing.tasks.some((t) => t.key === TO)).toBe(false);
    expect(missing.released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed', content: expect.anything() }),
    ]);
    // 読み直しで同じ ID が別の種類（連絡）に使われても、同じ事項の証拠ではない（§4.1）。
    const reused = accepted(arrived())
      .add('transcriptionCorrected', '2026-12-04T10:00+09:00', 'b', {
        sourceId: 'k1',
        sourceVersion: 2,
        sentences: splitSentences(TEXT, 'k1'),
      })
      .add('modelOutputRecorded', '2026-12-04T10:01+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-k1-v2',
        sourceId: 'k1',
        sourceVersion: 2,
        output: extraction({ ...practice(), kind: 'contact' }),
      });
    expect(computePlan(reused.events, '2026-12-04T10:01+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed' }),
    ]);
    // その後、別の物になった事項を家族が「読み違い」として外しても、元の行事を外したことにはならない。
    const reusedDismissed = reused.add('itemDismissed', '2026-12-04T10:02+09:00', 'a', {
      itemId: 'e1',
      reason: 'misread',
    });
    expect(computePlan(reusedDismissed.events, '2026-12-04T10:02+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed' }),
    ]);
    // 子が二人になって送り迎えを作らなくなった（どの子の行事か分からない）のも、要らなくなったのではない。
    const twoChildren = accepted(arrived()).add('householdSet', '2026-12-04T10:00+09:00', 'a', {
      household: withChildren({ c: { to: true, from: true }, d: undefined }),
    });
    expect(computePlan(twoChildren.events, '2026-12-04T10:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed' }),
    ]);
    const dismissed = accepted(arrived()).add('itemDismissed', '2026-12-04T10:00+09:00', 'a', {
      itemId: 'e1',
      reason: 'notOurs',
    });
    expect(computePlan(dismissed.events, '2026-12-04T10:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'gone' }),
    ]);
    const withdrawn = accepted(arrived()).add('sourceWithdrawn', '2026-12-04T10:00+09:00', 'a', {
      sourceId: 'k1',
    });
    expect(computePlan(withdrawn.events, '2026-12-04T10:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'gone' }),
    ]);
  });

  it('引き受けた後に読み直していれば、同じ ID の取り消し・条件の外れも、要らないとは言わず確かめてと出す', () => {
    // 読み直しで同じ行事が同じ ID で残っても、引き受けた時と同じ物とは確かめられない（§4.1）。
    const reread = (rain: boolean) =>
      accepted(arrived({ rain }))
        .add('transcriptionCorrected', '2026-12-04T10:00+09:00', 'b', {
          sourceId: 'k1',
          sourceVersion: 2,
          sentences: splitSentences(TEXT, 'k1'),
        })
        .add('modelOutputRecorded', '2026-12-04T10:01+09:00', 'system', {
          call: 'extract',
          model: 'hand-written',
          promptVersion: 'fixture',
          inputHash: 'fixture-k1-v2',
          sourceId: 'k1',
          sourceVersion: 2,
          output: extraction(practice(), rain),
        });
    const kept = computePlan(reread(false).events, '2026-12-04T10:01+09:00');
    expect(kept.tasks.find((t) => t.key === TO)?.commitment).toBe('accepted');
    expect(kept.released).toBeUndefined();
    const cancelledAfter = cancelled(reread(false), '2026-12-05T08:00+09:00').events;
    expect(computePlan(cancelledAfter, '2026-12-05T08:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed' }),
    ]);
    const rainy = reread(true).add('answered', '2026-12-05T07:00+09:00', 'b', {
      unknownId: 'u-rain',
      value: 'yes',
    }).events;
    expect(computePlan(rainy, '2026-12-05T07:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'unconfirmed' }),
    ]);
    // 読み直していなければ、取り消しは「もう要りません」（下の試験の前提も同じ）。
    const plain = cancelled(accepted(arrived()), '2026-12-05T08:00+09:00').events;
    expect(computePlan(plain, '2026-12-05T08:00+09:00').released).toEqual([
      expect.objectContaining({ taskKey: TO, reason: 'gone' }),
    ]);
  });

  it('書き起こしを直して読み直す間は、前の版の作業が残り、「もう要りません」を出さない', () => {
    const events = accepted(arrived()).add(
      'transcriptionCorrected',
      '2026-12-04T10:00+09:00',
      'b',
      {
        sourceId: 'k1',
        sourceVersion: 2,
        sentences: splitSentences(TEXT, 'k1'),
      },
    ).events;
    const plan = computePlan(events, '2026-12-04T10:00+09:00');
    expect(plan.tasks.find((t) => t.key === TO)?.commitment).toBe('accepted');
    expect(plan.released).toBeUndefined();
  });

  it('引き受けていない（提案だけ・担当なし）作業が無くなっても、出さない', () => {
    const proposed = arrived().add('assignmentProposed', '2026-11-25T20:06+09:00', 'a', {
      taskKey: TO,
      assigneeId: 'b',
    });
    const plan = computePlan(
      cancelled(proposed, '2026-12-05T08:00+09:00').events,
      '2026-12-05T08:00+09:00',
    );
    expect(plan.released).toBeUndefined();
  });
});
