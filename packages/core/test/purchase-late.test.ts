// 買い物の機会を過ぎた時：家にあるかがまだ分からなければ、不可能と決めず、家にあるかを今すぐ聞く。
// 家に無いと分かってから、買える時が無いと示す（過ぎた決め時を添え、決め時が分かる形にする）。
import { describe, expect, it } from 'vitest';
import { computePlan } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const SHIRT = 'arr:purchase:i3';
const UNKNOWN = 'u-atHome:i3';
/** 最後の買い物の機会（12/4 19:05 からの帰り道）の後。 */
const LATE = '2026-12-04T20:50+09:00';

describe('買える時を過ぎた買い物', () => {
  it('家にあるかが分からなければ、聞いてから決める（問いを残し、持って行く時まで聞く）', () => {
    const plan = computePlan(noticeArrived().events, LATE);
    const shirt = plan.arrangements.find((a) => a.key === SHIRT);
    expect(shirt?.status).toBe('askFirst');
    expect(shirt?.reasons.map((r) => r.code).sort()).toEqual(['askFirst', 'noOptionLeft']);
    expect(shirt?.options[0]).toMatchObject({
      expired: true,
      decisionDeadline: '2026-12-04T19:05+09:00',
      deadlineCertainty: 'estimate',
    });
    expect(shirt?.recommendedOptionKey).toBeUndefined();
    expect(plan.questions).toContainEqual({
      key: `q:${UNKNOWN}`,
      unknownId: UNKNOWN,
      askBy: '2026-12-05T08:00+09:00',
      fallbackValue: 'no',
      affects: [SHIRT],
    });
  });

  it('家にあると答えれば、買い物の手配も問いも無くなる', () => {
    const events = noticeArrived().add('answered', LATE, 'b', {
      unknownId: UNKNOWN,
      value: 'yes',
    }).events;
    const plan = computePlan(events, LATE);
    expect(plan.arrangements.some((a) => a.key === SHIRT)).toBe(false);
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
  });

  it('家に無いと答えたら、買える時が無いと示す（過ぎた決め時を添える）', () => {
    const events = noticeArrived().add('answered', LATE, 'b', {
      unknownId: UNKNOWN,
      value: 'no',
    }).events;
    const plan = computePlan(events, LATE);
    const shirt = plan.arrangements.find((a) => a.key === SHIRT);
    expect(shirt?.status).toBe('infeasible');
    expect(shirt?.reasons.map((r) => r.code)).toEqual(['noOptionLeft']);
    expect(shirt?.options[0]).toMatchObject({
      expired: true,
      decisionDeadline: '2026-12-04T19:05+09:00',
      deadlineCertainty: 'estimate',
    });
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
  });

  it('お知らせが来た時にもう機会が無くても、さかのぼって、過ぎた最後の機会を決め時とする', () => {
    // 前の日の夜（店の閉まった後）に来たお知らせ：最後の機会は、届く前の 12/4 19:05。
    const lateNotice = noticeArrived().events.map((e) =>
      e.type === 'noticeReceived'
        ? { ...e, source: { ...e.source, receivedAt: '2026-12-04T21:30+09:00' } }
        : e,
    );
    const plan = computePlan(lateNotice, '2026-12-04T21:40+09:00');
    const shirt = plan.arrangements.find((a) => a.key === SHIRT);
    expect(shirt?.status).toBe('askFirst');
    expect(shirt?.options[0]).toMatchObject({
      expired: true,
      decisionDeadline: '2026-12-04T19:05+09:00',
      deadlineCertainty: 'estimate',
    });
  });

  it('ふだんの週に一度も買える時が無ければ、決め時を作らず、家に無いと答えても不可能とは言わない', () => {
    // 子どもの服を売る店を、家庭の登録から外す（帰り道の店と時間が、いつも合わない）。
    const noStore = (events: ReturnType<typeof noticeArrived>['events']) =>
      events.map((e) =>
        e.type === 'householdSet'
          ? {
              ...e,
              household: {
                ...e.household,
                places: e.household.places.filter(
                  (p) => !(p.kind === 'store' && p.goods.includes('kidsClothing')),
                ),
              },
            }
          : e,
      );
    const asked = computePlan(noStore(noticeArrived().events), LATE);
    const before = asked.arrangements.find((a) => a.key === SHIRT);
    expect(before?.status).toBe('askFirst');
    expect(before?.options[0]).toMatchObject({ expired: true, deadlineCertainty: 'undetermined' });
    expect(before?.options[0]?.decisionDeadline).toBeUndefined();
    expect(asked.questions.some((q) => q.unknownId === UNKNOWN)).toBe(true);
    const answered = noStore(
      noticeArrived().add('answered', LATE, 'b', { unknownId: UNKNOWN, value: 'no' }).events,
    );
    const after = computePlan(answered, LATE).arrangements.find((a) => a.key === SHIRT);
    expect(after?.status).toBe('undetermined');
    expect(after?.reasons.map((r) => r.code)).toEqual(['noOptionLeft']);
  });

  it('持って行く時を過ぎたら、買い物の手配も問いも出さない（要件は残す）', () => {
    const plan = computePlan(noticeArrived().events, '2026-12-05T08:30+09:00');
    expect(plan.arrangements.some((a) => a.key === SHIRT)).toBe(false);
    expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
    expect(plan.requirements.find((r) => r.key === 'req:belongings:i3')).toMatchObject({
      by: '2026-12-05T08:00+09:00',
    });
  });

  it('買い物を済ませたら、家にあるかを聞かず、手配は決まった扱いにする', () => {
    const buy = `task:opt:${SHIRT}:buy:buy`;
    const events = noticeArrived()
      .add('assignmentProposed', '2026-11-26T19:20+09:00', 'a', { taskKey: buy, assigneeId: 'a' })
      .add('commitmentChanged', '2026-11-26T19:21+09:00', 'a', {
        taskKey: buy,
        assigneeId: 'a',
        action: 'done',
      }).events;
    for (const at of ['2026-11-26T19:30+09:00', LATE]) {
      const plan = computePlan(events, at);
      const shirt = plan.arrangements.find((a) => a.key === SHIRT);
      expect(shirt).toMatchObject({ status: 'decidable', reasons: [] });
      expect(plan.questions.some((q) => q.unknownId === UNKNOWN)).toBe(false);
      expect(plan.tasks.find((t) => t.key === buy)?.commitment).toBe('done');
    }
  });
});
