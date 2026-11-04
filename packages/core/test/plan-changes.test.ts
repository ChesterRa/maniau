// 計画の差分（planChanges）：選ぶ・家の情報を直す・「もし〜なら」に共通。家族が進めている作業だけを比べ（比べる
// ための候補と、取り消しを伝える作業は除く）、時刻の有無の両向き・担当・中身・引き受け直し・決め時の変化を出す。
import { describe, expect, it } from 'vitest';
import { type PlanResult, planChanges, type Task } from '../src';

const task = (key: string, over: Partial<Task> = {}): Task =>
  ({
    key,
    titleKey: 'task.submit',
    titleParams: { what: key },
    basis: { itemIds: [] },
    durationMin: 10,
    segments: ['home'],
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    commitment: 'proposed',
    live: true,
    ...over,
  }) as Task;

const plan = (tasks: Task[], over: Partial<PlanResult> = {}): PlanResult =>
  ({
    householdId: 'h',
    now: '2026-11-25T20:00+09:00',
    throughSeq: 1,
    requirements: [],
    arrangements: [],
    tasks,
    requests: [],
    questions: [],
    ...over,
  }) as PlanResult;

const at = (h: number) => `2026-11-26T${String(h).padStart(2, '0')}:00+09:00`;

describe('計画の差分', () => {
  it('同じ計画なら、何も変わらない', () => {
    const p = plan([task('t1', { start: at(9), end: at(10), assigneeId: 'a' })]);
    const changes = planChanges(p, structuredClone(p));
    expect(Object.values(changes).every((v) => Array.isArray(v) && v.length === 0)).toBe(true);
  });

  it('増える・無くなる・時刻が動く・時刻を置けなくなる・置けるようになる・担当が替わる・中身が替わる', () => {
    const before = plan([
      task('gone', { start: at(8) }),
      task('move', { start: at(9), end: at(10) }),
      task('lose', { start: at(11), end: at(12) }),
      task('gain'),
      task('hand', { assigneeId: 'a' }),
      task('what', { titleParams: { what: '申込書' } }),
    ]);
    const after = plan([
      task('move', { start: at(13), end: at(14) }),
      task('lose'),
      task('gain', { start: at(15), end: at(16) }),
      task('hand', { assigneeId: 'b' }),
      task('what', { titleParams: { what: '欠席届' } }),
      task('new', { start: at(17) }),
    ]);
    const changes = planChanges(before, after);
    expect(changes.added.map((s) => s.taskKey)).toEqual(['new']);
    expect(changes.removed.map((s) => s.taskKey)).toEqual(['gone']);
    expect(changes.moved.map((m) => m.taskKey)).toEqual(['move']);
    expect(changes.unplaced).toEqual(['lose']);
    expect(changes.placed).toEqual(['gain']);
    expect(changes.reassigned).toEqual([{ taskKey: 'hand', before: 'a', after: 'b' }]);
    expect(changes.changed).toEqual(['what']);
  });

  it('時刻と担当が同じでも、行く所（店）が替われば変わったとする', () => {
    const before = plan([task('buy', { start: at(19), assigneeId: 'a', atPlaceId: 'store-a' })]);
    const after = plan([task('buy', { start: at(19), assigneeId: 'a', atPlaceId: 'store-b' })]);
    const changes = planChanges(before, after);
    expect(changes.relocated).toEqual([{ taskKey: 'buy', before: 'store-a', after: 'store-b' }]);
    expect(changes.moved).toEqual([]);
    expect(changes.reassigned).toEqual([]);
  });

  it('生きていない作業と取り消しを伝える作業は、増える・無くなるに数えない。引き受け直しは新しい物だけ', () => {
    const before = plan([
      task('dead', { live: false }),
      task('kept', { commitment: 'accepted', assigneeId: 'a', reconfirm: true }),
      task('fresh', { commitment: 'accepted', assigneeId: 'a' }),
    ]);
    const after = plan([
      task('dead', { live: false }),
      task('cancel', { cancels: 'r1' }),
      task('kept', { commitment: 'accepted', assigneeId: 'a', reconfirm: true }),
      task('fresh', { commitment: 'accepted', assigneeId: 'a', reconfirm: true }),
    ]);
    const changes = planChanges(before, after);
    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual([]);
    expect(changes.reconfirm).toEqual(['fresh']);
  });

  it('手の決め時が動く・間に合わなくなる手を出す（生きている手配だけ）', () => {
    const arrangement = (
      deadline: string | undefined,
      expired: boolean,
      certainty: 'checked' | 'estimate' | 'undetermined' = 'checked',
    ) => ({
      key: 'arr',
      requirementKey: 'req',
      kind: 'childCare' as const,
      start: at(8),
      end: at(18),
      status: 'open',
      options: [
        {
          key: 'opt',
          arrangementKey: 'arr',
          templateId: 'opt-grandma',
          titleKey: 'option.askHelper',
          ...(deadline === undefined ? {} : { decisionDeadline: deadline }),
          deadlineCertainty: certainty,
          expired,
          cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 },
          taskKeys: [],
        },
      ],
      backupOptionKeys: [],
      reasons: [],
      live: true,
    });
    const before = plan([], {
      arrangements: [arrangement('2026-12-04T20:55+09:00', false)],
    } as Partial<PlanResult>);
    const after = plan([], {
      arrangements: [arrangement('2026-12-02T20:55+09:00', true)],
    } as Partial<PlanResult>);
    expect(planChanges(before, after).deadlines).toEqual([
      {
        arrangementKey: 'arr',
        optionKey: 'opt',
        templateId: 'opt-grandma',
        titleKey: 'option.askHelper',
        before: {
          decisionDeadline: '2026-12-04T20:55+09:00',
          deadlineCertainty: 'checked',
          expired: false,
        },
        after: {
          decisionDeadline: '2026-12-02T20:55+09:00',
          deadlineCertainty: 'checked',
          expired: true,
        },
      },
    ]);
    // 決め時を計算できなくなった手は、確かさごと渡す（画面が「もう間に合わない」と言い切らないように）。
    const unknown = plan([], {
      arrangements: [arrangement(undefined, true, 'undetermined')],
    } as Partial<PlanResult>);
    expect(planChanges(before, unknown).deadlines[0]?.after).toEqual({
      deadlineCertainty: 'undetermined',
      expired: true,
    });
  });

  it('手配の時間が変わる・新しく要る・要らなくなるを出す（生きている手配だけ）', () => {
    const care = (key: string, start: string, end: string, live = true) => ({
      key,
      requirementKey: `req:${key}`,
      kind: 'childCare' as const,
      childId: 'c',
      start,
      end,
      status: 'open',
      options: [],
      backupOptionKeys: [],
      reasons: [],
      live,
    });
    const before = plan([], {
      arrangements: [
        care('moved', at(8), at(18)),
        care('gone', at(9), at(17)),
        care('same', at(10), at(12)),
        care('dead', at(10), at(12), false),
      ],
    } as Partial<PlanResult>);
    const after = plan([], {
      arrangements: [
        care('moved', at(7), at(18)),
        care('same', at(10), at(12)),
        care('new', at(13), at(15)),
        care('dead', at(11), at(12), false),
      ],
    } as Partial<PlanResult>);
    expect(planChanges(before, after).windows).toEqual([
      {
        arrangementKey: 'moved',
        kind: 'childCare',
        childId: 'c',
        before: { start: at(8), end: at(18) },
        after: { start: at(7), end: at(18) },
      },
      {
        arrangementKey: 'gone',
        kind: 'childCare',
        childId: 'c',
        before: { start: at(9), end: at(17) },
      },
      {
        arrangementKey: 'new',
        kind: 'childCare',
        childId: 'c',
        after: { start: at(13), end: at(15) },
      },
    ]);
  });

  it('送った依頼のうち、新しく相手に確かめが要る物だけを出す', () => {
    const request = (requestId: string, needsCheck: boolean) => ({
      requestId,
      taskKey: `task:${requestId}`,
      to: 'g',
      kind: 'reply',
      sentAt: at(9),
      sentBy: 'a',
      state: 'confirmed',
      basis: { itemIds: [] },
      live: true,
      ...(needsCheck ? { needsCheck } : {}),
    });
    const before = plan([], {
      requests: [request('r1', false), request('r2', true)],
    } as Partial<PlanResult>);
    const after = plan([], {
      requests: [request('r1', true), request('r2', true)],
    } as Partial<PlanResult>);
    expect(planChanges(before, after).checks.map((r) => r.requestId)).toEqual(['r1']);
  });
});
