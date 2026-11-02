// 提出物：出す日までに、家で用意して出す作業を一つ作る。初めは担当が無く、二人の「きょう」に出す。
import { describe, expect, it } from 'vitest';
import { type Extraction, type Source, splitSentences, todayCards, toEpochMinutes } from '../src';
import { computePlan } from '../src/engine';
import { placeStep } from '../src/engine/deadline';
import { noticeArrived } from './fixtures/demo';

const TEXT =
  '個人面談の出欠票を、11月27日(金)までに担任に提出してください。\n調査票は後日配ります。';
const notice3: Source = {
  id: 'n3',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '個人面談',
  sentences: splitSentences(TEXT, 'n3'),
};
const extraction3: Extraction = {
  sourceId: 'n3',
  unknowns: [],
  conditions: [],
  items: [
    {
      id: 's1',
      sourceId: 'n3',
      sentenceIds: ['n3#1'],
      kind: 'submission',
      written: '個人面談の出欠票を、11月27日(金)までに担任に提出してください。',
      interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
      evidence: 'stated',
      effects: [],
    },
    {
      id: 's2',
      sourceId: 'n3',
      sentenceIds: ['n3#2'],
      kind: 'submission',
      written: '調査票は後日配ります。',
      interpretation: { what: '調査票' },
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
};

const TASK = 'task:submit:s1';
const withNotice = () =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice3 })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n3',
      sourceId: 'n3',
      output: extraction3,
    });

describe('提出物', () => {
  it('出す日のある提出物は、担当の無い作業として二人に出す。出す日の無い物は要件だけ', () => {
    const plan = computePlan(withNotice().events, '2026-11-25T20:05+09:00');
    const requirement = plan.requirements.find((r) => r.key === 'req:submission:s1');
    expect(requirement).toMatchObject({
      kind: 'submission',
      what: '個人面談の出欠票',
      by: '2026-11-27T08:00+09:00',
    });
    const task = plan.tasks.find((t) => t.key === TASK);
    expect(task).toMatchObject({
      titleKey: 'task.submit',
      titleParams: { what: '個人面談の出欠票' },
      deadline: '2026-11-27T08:00+09:00',
      segments: ['home'],
      commitment: 'proposed',
      live: true,
    });
    expect(task?.assigneeId).toBeUndefined();
    expect(plan.requirements.some((r) => r.key === 'req:submission:s2')).toBe(true);
    expect(plan.tasks.some((t) => t.key === 'task:submit:s2')).toBe(false);
    for (const member of ['a', 'b']) {
      const unowned = todayCards(plan, member).main.find(
        (c) => c.kind === 'unowned' && c.task.key === TASK,
      );
      expect(unowned).toBeDefined();
    }
  });

  it('持った人がいれば、その人の家の時間に、締切までに終わる最も遅い所へ置く（今より前には置かない）', () => {
    const now = '2026-11-25T20:05+09:00';
    const events = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: TASK,
      assigneeId: 'b',
    }).events;
    const plan = computePlan(events, now);
    const task = plan.tasks.find((t) => t.key === TASK);
    expect(task?.assigneeId).toBe('b');
    expect(task?.start).toBeDefined();
    expect(task?.end).toBeDefined();
    if (!task?.start || !task.end) return;
    expect(toEpochMinutes(task.start)).toBeGreaterThanOrEqual(toEpochMinutes(now));
    expect(toEpochMinutes(task.end)).toBeLessThanOrEqual(toEpochMinutes('2026-11-27T08:00+09:00'));
    expect(toEpochMinutes(task.end) - toEpochMinutes(task.start)).toBe(task.durationMin);
    // 持った本人には引き受ける提案として出し、もう一人には出さない。
    expect(
      todayCards(plan, 'b').main.some((c) => c.kind === 'proposal' && c.task.key === TASK),
    ).toBe(true);
    expect(todayCards(plan, 'a').main.some((c) => 'task' in c && c.task.key === TASK)).toBe(false);
  });

  it('締切を過ぎてから持っても、過去には置かない', () => {
    const events = withNotice().add('assignmentProposed', '2026-11-27T09:00+09:00', 'b', {
      taskKey: TASK,
      assigneeId: 'b',
    }).events;
    const plan = computePlan(events, '2026-11-27T09:00+09:00');
    const task = plan.tasks.find((t) => t.key === TASK);
    expect(task?.assigneeId).toBe('b');
    expect(task?.start).toBeUndefined();
  });
  it('ほかの作業が使う時間には置かず、その前の空いた所に置く', () => {
    const household = withNotice().events.find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家族が無い');
    const step = {
      id: 'submit',
      titleKey: 'task.submit',
      durationMin: 10,
      segments: ['home' as const],
      waitAfterMin: 0,
    };
    const now = toEpochMinutes('2026-11-25T20:05+09:00');
    const by = toEpochMinutes('2026-11-27T08:00+09:00');
    const free = placeStep(step, 'b', household.household, now, by, []);
    if (!free) throw new Error('置けない');
    // 空いていれば置いた所を、ほかの作業が使う。
    const used = { start: free.start - 30, end: free.end };
    const moved = placeStep(step, 'b', household.household, now, by, [used]);
    if (!moved) throw new Error('置けない');
    expect(moved.end <= used.start || moved.start >= used.end).toBe(true);
    expect(moved.end).toBeLessThanOrEqual(by);
    expect(moved.start).toBeGreaterThanOrEqual(now);
  });

  it('お知らせを取り下げたら、提出物の作業も要らなくなる', () => {
    const events = withNotice().add('sourceWithdrawn', '2026-11-25T20:30+09:00', 'b', {
      sourceId: 'n3',
    }).events;
    const plan = computePlan(events, '2026-11-25T20:35+09:00');
    const task = plan.tasks.find((t) => t.key === TASK);
    expect(task === undefined || task.live === false).toBe(true);
    for (const member of ['a', 'b']) {
      expect(todayCards(plan, member).main.some((c) => 'task' in c && c.task.key === TASK)).toBe(
        false,
      );
    }
  });
});
