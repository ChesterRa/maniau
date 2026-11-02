// 扱う店の種類が分からない持ち物も、黙って落とさない：家にあるかを聞き、無いと分かったら、どの店で買えるか
// 分からないと二人の「きょう」に出す（必要な日まで）。
import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  notificationHistory,
  notificationIntents,
  type Source,
  splitSentences,
  todayCards,
} from '../src';
import { computePlan } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const TEXT = '12月5日(土)は、ハンカチを持ってきてください。';
const notice7: Source = {
  id: 'n7',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '持ち物',
  sentences: splitSentences(TEXT, 'n7'),
};
const extraction7: Extraction = {
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
      interpretation: { what: 'ハンカチ', date: '2026-12-05', writtenWeekday: 6 },
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
};
const KEY = 'arr:purchase:h1';
const UNKNOWN = 'u-atHome:h1';
const AT = '2026-11-25T20:30+09:00';
const withNotice = () =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice7 })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n7',
      sourceId: 'n7',
      output: extraction7,
    });
const answered = (value: 'yes' | 'no') =>
  withNotice().add('answered', '2026-11-25T20:10+09:00', 'b', {
    unknownId: UNKNOWN,
    value,
    about: 'ハンカチ',
  });
const noStore = (plan: ReturnType<typeof computePlan>, member: string) =>
  todayCards(plan, member).main.filter((c) => c.kind === 'stuck' && c.arrangement.key === KEY);

describe('店の種類が分からない持ち物', () => {
  it('家にあるかを、要る日の前の日（目安）までに聞く', () => {
    const plan = computePlan(withNotice().events, AT);
    expect(plan.arrangements.find((a) => a.key === KEY)?.status).toBe('askFirst');
    expect(plan.questions.find((q) => q.unknownId === UNKNOWN)).toMatchObject({
      askBy: '2026-12-04T08:00+09:00',
      fallbackValue: 'no',
    });
    expect(noStore(plan, 'b')).toEqual([]);
  });

  it('無いと答えたら、どの店で買えるか分からないと二人に出す。必要な日を過ぎたら出さない', () => {
    const plan = computePlan(answered('no').events, AT);
    const arrangement = plan.arrangements.find((a) => a.key === KEY);
    expect(arrangement?.status).toBe('undetermined');
    expect(arrangement?.reasons).toContainEqual({ code: 'inputMissing', refs: ['storeKind'] });
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
    for (const member of ['a', 'b']) expect(noStore(plan, member)).toHaveLength(1);
    expect(noStore(computePlan(answered('no').events, '2026-12-05T08:30+09:00'), 'b')).toEqual([]);
  });

  it('あると答えたら、手配も札も出さない', () => {
    const plan = computePlan(answered('yes').events, AT);
    expect(plan.arrangements.some((a) => a.key === KEY)).toBe(false);
    expect(noStore(plan, 'b')).toEqual([]);
  });
});

describe('問いの期限（押しの知らせが出るように、今に揃えない）', () => {
  const questionsFor = (events: ReturnType<typeof withNotice>['events'], now: string, id: string) =>
    notificationIntents(computePlan(events, now), household, notificationHistory(events))
      .filter((i) => i.subject.type === 'question' && i.subject.id === id)
      .map((i) => i.toMemberId)
      .sort();

  it('要る日の前の日を過ぎて届いた持ち物も、要る時まで二人に知らせる', () => {
    const late = noticeArrived()
      .add('noticeReceived', '2026-12-04T10:00+09:00', 'b', {
        source: { ...notice7, receivedAt: '2026-12-04T10:00+09:00' },
      })
      .add('modelOutputRecorded', '2026-12-04T10:00+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n7',
        sourceId: 'n7',
        output: extraction7,
      });
    for (const now of [
      '2026-12-04T10:00+09:00',
      '2026-12-04T23:00+09:00',
      '2026-12-05T07:50+09:00',
    ]) {
      const question = computePlan(late.events, now).questions.find((q) => q.unknownId === UNKNOWN);
      expect(question?.askBy, now).toBe('2026-12-05T08:00+09:00');
      expect(questionsFor(late.events, now, UNKNOWN), now).toEqual(['a', 'b']);
    }
  });

  it('店の分かる品物も、最後の買える時の前の一日に入ったら、その時までを期限にして知らせる', () => {
    const now = '2026-12-04T10:00+09:00';
    const question = computePlan(noticeArrived().events, now).questions.find(
      (q) => q.unknownId === 'u-atHome:i3',
    );
    expect(question?.askBy).toBe('2026-12-04T19:05+09:00');
    expect(questionsFor(noticeArrived().events, now, 'u-atHome:i3')).toEqual(['a', 'b']);
  });
});
