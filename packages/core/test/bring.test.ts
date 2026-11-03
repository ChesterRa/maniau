// 持って行く物：使う日の前の日と使う日に、家にあると答えた物と買い終えた物を、大人の全員の「きょう」に
// 静かに出す。家にあるかは、用意の締切の前か使う日のうちなら答え直せる（要件が今の答えを持つ）。締切の後に
// 無いと分かった物は、買う手配を作らず、無いことを二人に出す。使う日は、持ち物に書かれた日付だけ（行事の日
// から推し量らない）。書かれた用意の締切は、使う日にしない。
import { describe, expect, it } from 'vitest';
import {
  atHomeAnswerable,
  type Extraction,
  type Requirement,
  type Source,
  splitSentences,
  todayCards,
} from '../src';
import { computePlan } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const TEXT = '12月5日(土)は、白い靴下を持ってきてください。';
const notice: Source = {
  id: 'n7',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '持ち物',
  sentences: splitSentences(TEXT, 'n7'),
};
const extraction = (date?: string, deadline?: string): Extraction => ({
  sourceId: 'n7',
  unknowns: [],
  conditions: [],
  items: [
    {
      id: 'h1',
      sourceId: 'n7',
      sentenceIds: ['n7#1'],
      kind: 'belongings',
      written: TEXT,
      interpretation: {
        what: '白い靴下',
        ...(date ? { date, writtenWeekday: 6 } : {}),
        ...(deadline ? { deadline } : {}),
      },
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
});
const UNKNOWN = 'u-atHome:h1';
const KEY = 'req:belongings:h1';
const BUY = 'task:opt:arr:purchase:h1:buy:buy';

/** 白い靴下（書かれた使う日は、指定が無ければ 12/5）のお知らせと、家にあるかの答え。 */
function socks(options: {
  answer?: 'yes' | 'no';
  about?: string;
  date?: string | undefined;
  deadline?: string;
}) {
  const log = noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n7',
      sourceId: 'n7',
      output: extraction('date' in options ? options.date : '2026-12-05', options.deadline),
    });
  if (options.answer) {
    log.add('answered', '2026-11-25T20:10+09:00', 'b', {
      unknownId: UNKNOWN,
      value: options.answer,
      about: options.about ?? '白い靴下',
    });
  }
  return log;
}
/** 買い物の作業を引き受けて、済んだと記録する（11/26）。 */
const buy = (log: ReturnType<typeof socks>) =>
  log
    .add('assignmentProposed', '2026-11-26T19:20+09:00', 'a', { taskKey: BUY, assigneeId: 'a' })
    .add('commitmentChanged', '2026-11-26T19:21+09:00', 'a', {
      taskKey: BUY,
      assigneeId: 'a',
      action: 'done',
    });
type Events = ReturnType<typeof noticeArrived>['events'];
const requirementAt = (events: Events, at: string) =>
  computePlan(events, at).requirements.find((r) => r.key === KEY);
const bring = (events: Events, at: string, member = 'b') =>
  todayCards(computePlan(events, at), member).quiet.filter(
    (c) => c.kind === 'bring' && c.requirement.key === KEY,
  );

describe('持って行く物', () => {
  it('家にあると答えた物は、使う日の前の日と使う日（一日中）に、大人の全員に出す', () => {
    const events = socks({ answer: 'yes' }).events;
    expect(requirementAt(events, '2026-12-04T09:00+09:00')).toMatchObject({
      atHome: 'yes',
      date: '2026-12-05',
      by: '2026-12-05T08:00+09:00',
    });
    for (const member of ['a', 'b']) {
      for (const at of [
        '2026-12-04T00:30+09:00',
        '2026-12-04T20:00+09:00',
        '2026-12-05T15:00+09:00',
      ]) {
        expect(bring(events, at, member)).toMatchObject([
          { kind: 'bring', bought: false, requirement: { what: '白い靴下', atHome: 'yes' } },
        ]);
      }
      expect(bring(events, '2026-12-03T23:30+09:00', member)).toEqual([]);
      expect(bring(events, '2026-12-06T00:00+09:00', member)).toEqual([]);
    }
  });

  it('家にあると答えた物は、用意の締切（使う日の朝 8:00）の後も、使う日のうちは答え直せる', () => {
    const events = socks({ answer: 'yes' }).events;
    expect(bring(events, '2026-12-05T07:30+09:00')).toMatchObject([{ reanswer: true }]);
    expect(bring(events, '2026-12-05T23:30+09:00')).toMatchObject([{ reanswer: true }]);
  });

  it('答えていない物は出さない。無いと答えて買っていない物は、締切の前は出さない（問いや買い物の作業が出す）', () => {
    expect(bring(socks({}).events, '2026-12-04T09:00+09:00')).toEqual([]);
    expect(bring(socks({ answer: 'no' }).events, '2026-12-04T09:00+09:00')).toEqual([]);
  });

  it('用意の締切の後に「やっぱり無かった」と答えると、買う手配は作らず、無いことを二人に出し、使う日のうちは「用意できた」に戻せる', () => {
    const late = '2026-12-05T09:00+09:00';
    const missing = socks({ answer: 'yes' }).add('answered', late, 'a', {
      unknownId: UNKNOWN,
      value: 'no',
      about: '白い靴下',
    });
    const plan = computePlan(missing.events, late);
    expect(plan.arrangements.some((a) => a.atHomeUnknownId === UNKNOWN)).toBe(false);
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
    for (const member of ['a', 'b']) {
      expect(bring(missing.events, late, member)).toMatchObject([
        { bought: false, reanswer: true, requirement: { atHome: 'no' } },
      ]);
    }
    const ready = missing.add('answered', '2026-12-05T09:10+09:00', 'b', {
      unknownId: UNKNOWN,
      value: 'yes',
      about: '白い靴下',
    }).events;
    expect(bring(ready, '2026-12-05T09:10+09:00', 'a')).toMatchObject([
      { bought: false, reanswer: true, requirement: { atHome: 'yes' } },
    ]);
    expect(bring(ready, '2026-12-06T00:00+09:00', 'a')).toEqual([]);
  });

  it('無いと答えて買い終えた物は、買った物として出し、見つからなければ答え直せる', () => {
    const events = buy(socks({ answer: 'no' })).events;
    expect(bring(events, '2026-12-04T09:00+09:00')).toMatchObject([
      { kind: 'bring', bought: true, reanswer: true },
    ]);
  });

  it('買った後に「やっぱり無かった」と答えたら、後の答えが今の事実：締切の後は無いことを出し、「用意できた」に戻せる', () => {
    const late = '2026-12-05T09:00+09:00';
    const lost = buy(socks({ answer: 'no' })).add('answered', late, 'b', {
      unknownId: UNKNOWN,
      value: 'no',
      about: '白い靴下',
    });
    expect(requirementAt(lost.events, late)?.bought).toBeUndefined();
    for (const member of ['a', 'b']) {
      expect(bring(lost.events, late, member)).toMatchObject([
        { bought: false, reanswer: true, requirement: { atHome: 'no' } },
      ]);
    }
    const ready = lost.add('answered', '2026-12-05T09:10+09:00', 'a', {
      unknownId: UNKNOWN,
      value: 'yes',
      about: '白い靴下',
    }).events;
    expect(bring(ready, '2026-12-05T09:10+09:00')).toMatchObject([
      { bought: false, requirement: { atHome: 'yes' } },
    ]);
  });

  it('買った後に締切の前で「やっぱり無かった」と答えたら、買い物をもう一度開く', () => {
    const at = '2026-11-27T12:00+09:00';
    const events = buy(socks({ answer: 'no' })).add('answered', at, 'b', {
      unknownId: UNKNOWN,
      value: 'no',
      about: '白い靴下',
    }).events;
    const plan = computePlan(events, at);
    expect(plan.requirements.find((r) => r.key === KEY)?.bought).toBeUndefined();
    expect(plan.arrangements.some((a) => a.atHomeUnknownId === UNKNOWN)).toBe(true);
    expect(plan.tasks.find((t) => t.key === BUY)).toMatchObject({ commitment: 'accepted' });
  });

  it('無いと答えた後に買い終えた物は、買った物として出す（答えより後の買い物）', () => {
    expect(
      requirementAt(buy(socks({ answer: 'no' })).events, '2026-12-04T09:00+09:00'),
    ).toMatchObject({ atHome: 'no', bought: true });
  });

  it('答えた時の品物が今の品物と違えば、その答えを要件に持たせず、持って行く物にも出さない', () => {
    const events = socks({ answer: 'yes', about: '赤い帽子' }).events;
    expect(requirementAt(events, '2026-12-04T09:00+09:00')?.atHome).toBeUndefined();
    expect(bring(events, '2026-12-04T09:00+09:00')).toEqual([]);
  });

  it('前の日に「やっぱり無かった」と答え直すと、持って行く物から外し、買う手配を出し直す', () => {
    const at = '2026-12-04T09:00+09:00';
    const events = socks({ answer: 'yes' }).add('answered', at, 'a', {
      unknownId: UNKNOWN,
      value: 'no',
      about: '白い靴下',
    }).events;
    const plan = computePlan(events, at);
    expect(bring(events, at)).toEqual([]);
    expect(plan.requirements.find((r) => r.key === KEY)?.atHome).toBe('no');
    expect(plan.arrangements.some((a) => a.atHomeUnknownId === UNKNOWN)).toBe(true);
  });
});

describe('使う日と用意の締切', () => {
  it('締切が使う日より前でも、持って行く物は使う日の前の日に出す（使う日のうちは答え直せる）', () => {
    const events = socks({ answer: 'yes', deadline: '2026-12-02T17:00+09:00' }).events;
    expect(requirementAt(events, '2026-12-01T20:00+09:00')).toMatchObject({
      date: '2026-12-05',
      by: '2026-12-02T17:00+09:00',
    });
    expect(bring(events, '2026-12-01T20:00+09:00')).toEqual([]);
    expect(bring(events, '2026-12-04T20:00+09:00')).toMatchObject([{ reanswer: true }]);
  });

  it('締切の前に無いと答えて買わなかった物は、締切の後、使う日の前の日に無いことを出す', () => {
    const events = socks({ answer: 'no', deadline: '2026-12-02T17:00+09:00' }).events;
    expect(bring(events, '2026-12-04T20:00+09:00')).toMatchObject([
      { bought: false, requirement: { atHome: 'no' } },
    ]);
  });

  it('締切の前に買い終えた物は、締切の後（買う手配が無くなっても）、使う日の前の日に買った物として出す', () => {
    const at = '2026-12-04T20:00+09:00';
    const events = buy(socks({ answer: 'no', deadline: '2026-12-02T17:00+09:00' })).events;
    expect(computePlan(events, at).arrangements.some((a) => a.atHomeUnknownId === UNKNOWN)).toBe(
      false,
    );
    expect(requirementAt(events, at)).toMatchObject({ atHome: 'no', bought: true });
    expect(bring(events, at)).toMatchObject([{ kind: 'bring', bought: true, reanswer: true }]);
  });

  it('使う日が書かれていなければ（締切だけ）、締切を使う日にせず、持って行く物にも出さない', () => {
    const events = socks({
      answer: 'yes',
      date: undefined,
      deadline: '2026-12-02T17:00+09:00',
    }).events;
    expect(requirementAt(events, '2026-12-01T20:00+09:00')?.date).toBeUndefined();
    expect(bring(events, '2026-12-01T20:00+09:00')).toEqual([]);
  });

  it('日の書かれていない持ち物は、同じお知らせの行事の日から推し量らない（用意の締切の見積もりには使う）', () => {
    // デモのお知らせの白い長袖シャツ：持ち物の文に日は無い。
    const events = noticeArrived().add('answered', '2026-11-26T19:00+09:00', 'b', {
      unknownId: 'u-atHome:i3',
      value: 'yes',
      about: '白い長袖シャツ',
    }).events;
    const plan = computePlan(events, '2026-12-04T09:00+09:00');
    const shirt = plan.requirements.find((r) => r.key === 'req:belongings:i3');
    expect(shirt).toMatchObject({ atHome: 'yes', by: '2026-12-05T08:00+09:00' });
    expect(shirt?.date).toBeUndefined();
    expect(todayCards(plan, 'b').quiet.filter((c) => c.kind === 'bring')).toEqual([]);
  });
});

describe('家にあるかに答えられる間（画面・一言・サーバーで同じ決まり）', () => {
  const base: Requirement = {
    key: KEY,
    kind: 'belongings',
    what: '白い靴下',
    date: '2026-12-05',
    by: '2026-12-02T17:00+09:00',
    nature: 'required',
    basis: { itemIds: ['h1'], requirementKey: KEY },
    live: true,
    atHomeUnknownId: UNKNOWN,
  };
  it('用意の締切の前と、書かれた使う日の終わりまで', () => {
    expect(atHomeAnswerable(base, '2026-12-02T16:59+09:00')).toBe(true);
    expect(atHomeAnswerable(base, '2026-12-03T09:00+09:00')).toBe(true);
    expect(atHomeAnswerable(base, '2026-12-05T23:59+09:00')).toBe(true);
    expect(atHomeAnswerable(base, '2026-12-06T00:00+09:00')).toBe(false);
  });
  it('使う日の書かれていない物は締切の前だけ。要らなくなった物には答えない', () => {
    const { date: _date, ...undated } = base;
    expect(atHomeAnswerable(undated, '2026-12-02T16:59+09:00')).toBe(true);
    expect(atHomeAnswerable(undated, '2026-12-02T17:00+09:00')).toBe(false);
    expect(atHomeAnswerable({ ...base, live: false }, '2026-12-01T09:00+09:00')).toBe(false);
  });
});
