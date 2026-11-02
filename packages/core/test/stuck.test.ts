// このままでは無理（01-model §8）：登録した手立てでは間に合う方法が見つからない手配を、必要な日まで
// 大人の全員の「きょう」に出す（隠さない）。聞いてから決める間は、問いの札だけを出す。
import { describe, expect, it } from 'vitest';
import { todayCards } from '../src';
import { computePlan } from '../src/engine';
import { notice2, noticeArrived } from './fixtures/demo';

const SHIRT = 'arr:purchase:i3';
const UNKNOWN = 'u-atHome:i3';
const LATE = '2026-12-04T20:50+09:00';
const stuckIn = (plan: ReturnType<typeof computePlan>, member: string) =>
  todayCards(plan, member).main.filter((c) => c.kind === 'stuck');

describe('このままでは無理の札', () => {
  it('家に無いと答え、買える時も過ぎたら、二人に札を出す（要件を添える）', () => {
    const events = noticeArrived().add('answered', LATE, 'b', {
      unknownId: UNKNOWN,
      value: 'no',
    }).events;
    const plan = computePlan(events, LATE);
    for (const member of ['a', 'b']) {
      const cards = stuckIn(plan, member);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        arrangement: { key: SHIRT },
        requirement: { what: '白い長袖シャツ', by: '2026-12-05T08:00+09:00' },
      });
    }
  });

  it('まだ聞いている間は出さない（問いの札で足りる）', () => {
    const plan = computePlan(noticeArrived().events, LATE);
    expect(stuckIn(plan, 'b')).toEqual([]);
    expect(todayCards(plan, 'b').main.some((c) => c.kind === 'question')).toBe(true);
  });

  it('必要な時を過ぎたら出さない', () => {
    const events = noticeArrived().add('answered', LATE, 'b', {
      unknownId: UNKNOWN,
      value: 'no',
    }).events;
    const after = stuckIn(computePlan(events, '2026-12-05T08:30+09:00'), 'b');
    expect(after.some((c) => c.kind === 'stuck' && c.arrangement.key === SHIRT)).toBe(false);
  });

  it('子の居場所も、決め時を全部過ぎて選べる手が無ければ、その日まで出す', () => {
    const plan = computePlan(noticeArrived().events, '2026-12-05T08:30+09:00');
    const care = stuckIn(plan, 'a').find(
      (c) => c.kind === 'stuck' && c.arrangement.kind === 'childCare',
    );
    expect(care).toMatchObject({ arrangement: { status: 'infeasible' } });
    expect(stuckIn(computePlan(noticeArrived().events, '2026-12-07T18:30+09:00'), 'a')).toEqual([]);
  });

  it('買える時があるうちは出さない', () => {
    const events = noticeArrived().add('answered', '2026-11-25T19:40+09:00', 'b', {
      unknownId: UNKNOWN,
      value: 'no',
    }).events;
    expect(stuckIn(computePlan(events, '2026-11-25T19:45+09:00'), 'b')).toEqual([]);
  });

  it('「ある」と答えた品物が、直されて別の物になれば、その答えは使わずに聞き直す', () => {
    const answered = () =>
      noticeArrived().add('answered', '2026-11-25T19:40+09:00', 'b', {
        unknownId: UNKNOWN,
        value: 'yes',
        about: '白い長袖シャツ',
      });
    const at = '2026-11-25T19:45+09:00';
    expect(computePlan(answered().events, at).arrangements.some((a) => a.key === SHIRT)).toBe(
      false,
    );
    const corrected = answered().add('itemCorrected', '2026-11-25T19:42+09:00', 'a', {
      itemId: 'i3',
      interpretation: { what: '赤い帽子' },
    }).events;
    const plan = computePlan(corrected, at);
    expect(plan.arrangements.find((a) => a.key === SHIRT)?.status).toBe('askFirst');
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
    // 品物を見せずに答えた古い形は、これまでどおり使う。
    const plain = noticeArrived()
      .add('answered', '2026-11-25T19:40+09:00', 'b', { unknownId: UNKNOWN, value: 'yes' })
      .add('itemCorrected', '2026-11-25T19:42+09:00', 'a', {
        itemId: 'i3',
        interpretation: { what: '赤い帽子' },
      }).events;
    expect(computePlan(plain, at).arrangements.some((a) => a.key === SHIRT)).toBe(false);
  });

  it('後のお知らせで別の品物に置き換わっても、前に「ある」と答えた品物の答えは使わずに聞き直す', () => {
    const at = '2026-11-25T19:45+09:00';
    const replaced = noticeArrived()
      .add('answered', '2026-11-25T19:40+09:00', 'b', {
        unknownId: UNKNOWN,
        value: 'yes',
        about: '白い長袖シャツ',
      })
      .add('noticeReceived', '2026-11-25T19:41+09:00', 'b', {
        source: { ...notice2, id: 'n9', sentences: [{ id: 'n9#1', text: '（架空）' }] },
      })
      .add('modelOutputRecorded', '2026-11-25T19:41+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n9',
        sourceId: 'n9',
        output: {
          sourceId: 'n9',
          unknowns: [],
          conditions: [],
          items: [
            {
              id: 'n9:i1',
              sourceId: 'n9',
              sentenceIds: ['n9#1'],
              kind: 'belongings',
              written: '（架空）',
              interpretation: { what: '赤い帽子' },
              evidence: 'stated',
              effects: [{ type: 'replace', itemId: 'i3' }],
            },
          ],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }).events;
    const plan = computePlan(replaced, at);
    expect(plan.requirements.find((r) => r.key === 'req:belongings:i3')?.what).toBe('赤い帽子');
    expect(plan.arrangements.find((a) => a.key === SHIRT)?.status).toBe('askFirst');
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
  });
});
