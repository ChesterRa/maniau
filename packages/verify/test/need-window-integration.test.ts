// 旧い窓に候補を足し、別の日に決めた履歴を手書きする。エンジンの計算は使わない。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyNotifications, verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('試験の材料が無い');
  return value;
}

function materials() {
  const family = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way',
        name: '架空の手',
        deadline: { type: 'daysBefore', days: 1, at: '21:00' },
        steps: [{ id: 'ask', name: '聞く', durationMin: 5, segments: ['home'] }],
        requires: ['prep'],
        cost: {},
      },
    ],
    preparations: [
      {
        id: 'prep',
        name: '架空の登録',
        state: 'done',
        appliesTo: { kind: 'household' },
        validUntil: '2026-12-10',
      },
    ],
  });
  const source = {
    id: 'src',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'family',
    language: 'ja',
    sentences: [{ id: 's1', text: '架空の用件' }],
  };
  const item = {
    id: 'item',
    sourceId: 'src',
    sentenceIds: ['s1'],
    kind: 'need',
    written: '架空の用件',
    interpretation: {
      what: '架空の用件',
      shape: 'window',
      date: '2026-12-09',
      startTime: '13:00',
      endTime: '15:00',
      holdNeeded: false,
    },
    evidence: 'stated',
    effects: [],
  };
  const candidate = (id: string, date: string) => ({
    id,
    rev: 1,
    date,
    startTime: '13:00',
    endTime: '15:00',
  });
  const candidates = [candidate('c1', '2026-12-09'), candidate('c2', '2026-12-11')];
  const basis = JSON.stringify({ people: [], required: [], minCount: 0, answers: [] });
  const events = [
    event(1, { type: 'householdSet', household: family }),
    event(2, { type: 'noticeReceived', source }),
    event(3, { type: 'itemsStated', sourceId: 'src', items: [item] }),
    event(4, {
      type: 'needWaysSet',
      itemId: 'item',
      wayIds: ['way'],
      about: JSON.stringify({
        need: { ...item.interpretation, condition: 'true' },
        ways: family.ways,
      }),
    }),
    event(5, { type: 'needCandidatesSet', itemId: 'item', candidates }),
    event(6, { type: 'needPeopleSet', itemId: 'item', people: [], required: [], minCount: 0 }),
    event(7, { type: 'candidateChosen', itemId: 'item', candidateId: 'c2', rev: 1, basis }),
  ];
  const state = (c: ReturnType<typeof candidate>, usable: boolean, deadline: string) => ({
    id: c.id,
    rev: c.rev,
    date: c.date,
    start: `${c.date}T13:00+09:00`,
    end: `${c.date}T15:00+09:00`,
    yes: 0,
    possible: 0,
    requiredNo: [],
    requiredOpen: [],
    condition: 'meets',
    pivotal: [],
    ways: [
      {
        wayId: 'way',
        usable,
        decisionDeadline: deadline,
        deadlineCertainty: 'estimate',
        reasons: usable ? [] : ['needsPreparation'],
      },
    ],
    ...(usable ? { decisionDeadline: deadline } : {}),
    flags: usable ? [] : ['noUsableWay'],
  });
  const when = {
    candidates: [
      state(must(candidates[0]), false, '2026-12-08T20:55+09:00'),
      state(must(candidates[1]), false, '2026-12-10T20:55+09:00'),
    ],
    people: [],
    required: [],
    minCount: 0,
    answers: [],
    links: [],
    inUse: false,
    chosen: { candidateId: 'c2', rev: 1, stale: false, changes: [] },
  };
  const arrKey = 'arr:need:item';
  const optKey = `opt:${arrKey}:way`;
  const taskKey = `task:${optKey}:ask`;
  const current = plan({
    throughSeq: 7,
    now: '2026-12-10T14:00+09:00',
    requirements: [
      requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item'] }, when }),
    ],
    arrangements: [
      arrangement({
        key: arrKey,
        kind: 'need',
        needShape: 'window',
        start: '2026-12-11T13:00+09:00',
        end: '2026-12-11T15:00+09:00',
        status: 'undetermined',
        reasons: [{ code: 'inputMissing', refs: ['waysChanged'] }],
        options: [
          option(optKey, {
            arrangementKey: arrKey,
            templateId: 'way',
            decisionDeadline: '2026-12-10T20:55+09:00',
            deadlineCertainty: 'estimate',
            taskKeys: [taskKey],
            needsPreparation: [{ preparationId: 'prep', state: 'expired' }],
          }),
        ],
      }),
    ],
    tasks: [
      task(taskKey, {
        durationMin: 5,
        start: '2026-12-10T20:55+09:00',
        end: '2026-12-10T21:00+09:00',
        step: { templateId: 'way', stepId: 'ask' },
        basis: {
          itemIds: ['item'],
          requirementKey: 'requirement',
          arrangementKey: arrKey,
          optionKey: optKey,
        },
      }),
    ],
  });
  return { family, events, current, arrKey };
}

describe('候補の日を選んだ後の独立な期限確認', () => {
  it('旧い日ではなく決めた候補の日で、作業・案・登録の期限を照らす', () => {
    const m = materials();
    const codes = (value = m.current) =>
      verifyPlan({ household: m.family, events: m.events, plan: value }).issues.map((i) => i.code);
    expect(
      verifyPlan({ household: m.family, events: m.events, plan: m.current }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    for (const code of [
      'decision_after_rule_deadline',
      'way_deadline_missed',
      'preparation_mismatch',
    ])
      expect(codes()).not.toContain(code);
    const badDecision = structuredClone(m.current);
    must(must(badDecision.arrangements[0]).options[0]).decisionDeadline = '2026-12-11T23:00+09:00';
    expect(codes(badDecision)).toContain('decision_after_rule_deadline');
    const lateTask = structuredClone(m.current);
    must(lateTask.tasks[0]).start = '2026-12-11T10:00+09:00';
    must(lateTask.tasks[0]).end = '2026-12-11T10:05+09:00';
    expect(codes(lateTask)).toContain('way_deadline_missed');
    const hidden = structuredClone(m.current);
    must(must(hidden.arrangements[0]).options[0]).needsPreparation = [];
    expect(codes(hidden)).toContain('preparation_mismatch');
  });

  it('知らせの窓も決めた候補から照らし、計画だけをずらせば違反にする', () => {
    const m = materials();
    const intent = {
      key: `needWays:${m.arrKey}:a`,
      toMemberId: 'a',
      kind: 'decisionApproaching',
      titleKey: 'notify.need',
      subject: { type: 'arrangement', id: m.arrKey },
      until: '2026-12-11T15:00+09:00',
      actBy: '2026-12-11T13:00+09:00',
    };
    const codes = (value = m.current) =>
      verifyNotifications({
        household: m.family,
        events: m.events,
        plan: value,
        intents: [intent],
      }).issues.map((i) => i.code);
    expect(
      verifyNotifications({
        household: m.family,
        events: m.events,
        plan: m.current,
        intents: [intent],
      }).issues.filter((i) => i.kind === 'violation'),
    ).toEqual([]);
    expect(codes()).not.toContain('notification_need_frame_mismatch');
    expect(codes()).not.toContain('notification_need_evidence_unverified');
    const wrong = structuredClone(m.current);
    must(wrong.arrangements[0]).start = '2026-12-11T14:00+09:00';
    expect(codes(wrong)).toContain('notification_need_frame_mismatch');
  });
});
