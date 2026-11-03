// 事項・要件・作業を独立に作り、家の人の行動について三者を照らす。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement, task } from './fixtures';

function check(
  kind: 'homework' | 'duty',
  changes: {
    itemWhat?: string;
    requirementWhat?: string;
    taskWhat?: string;
    requirementDate?: string;
    omitRequirementDate?: boolean;
    omitItemDate?: boolean;
    start?: string;
    end?: string;
    itemStart?: string;
    itemEnd?: string;
    itemPlace?: string;
    omitItemStart?: boolean;
    startTimeUnconfirmed?: boolean;
    taskTimeUnconfirmed?: boolean;
    incompleteHistory?: boolean;
    taskParams?: Record<string, string>;
    earliestStart?: string;
    deadline?: string;
    unplaced?: boolean;
  } = {},
) {
  const isDuty = kind === 'duty';
  const what = isDuty ? 'お茶当番' : '音読カードのサイン';
  const source = {
    id: 'n1',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'school',
    language: 'ja',
    sentences: [{ id: 'n1#1', text: what }],
  };
  const item = {
    id: 'i1',
    sourceId: 'n1',
    sentenceIds: ['n1#1'],
    kind,
    written: what,
    evidence: 'stated',
    interpretation: {
      what: changes.itemWhat ?? what,
      ...(changes.omitItemDate ? {} : { date: '2026-12-07' }),
      familyAction: true,
      ...(isDuty
        ? {
            ...(changes.omitItemStart ? {} : { startTime: changes.itemStart ?? '10:00' }),
            endTime: changes.itemEnd ?? '10:30',
            ...(changes.startTimeUnconfirmed ? { startTimeUnconfirmed: true } : {}),
            ...(changes.itemPlace ? { place: changes.itemPlace } : {}),
          }
        : {}),
    },
    effects: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    event(2, { type: 'noticeReceived', source }),
    event(3, {
      type: 'modelOutputRecorded',
      call: 'extract',
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      sourceId: 'n1',
      sourceVersion: 1,
      output: {
        sourceId: 'n1',
        items: [item],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    }),
    event(4, { type: 'assignmentProposed', taskKey: 't1', assigneeId: 'a' }),
  ];
  const req = requirement({
    key: 'r1',
    kind: isDuty ? 'attendance' : 'submission',
    what: changes.requirementWhat ?? what,
    ...(isDuty && !changes.omitRequirementDate
      ? { date: changes.requirementDate ?? '2026-12-07' }
      : {}),
    basis: { itemIds: ['i1'] },
  });
  const entry = task('t1', {
    titleKey: isDuty ? 'task.duty' : 'task.familyAction',
    titleParams: {
      what: changes.taskWhat ?? what,
      ...(isDuty
        ? {
            ...(changes.omitItemDate ? {} : { date: '2026-12-07' }),
            ...(changes.omitItemStart ? {} : { start: changes.itemStart ?? '10:00' }),
            end: changes.itemEnd ?? '10:30',
            ...(changes.itemPlace ? { place: changes.itemPlace } : {}),
          }
        : {}),
      ...changes.taskParams,
    },
    basis: { itemIds: ['i1'], requirementKey: 'r1' },
    ...(isDuty
      ? {
          earliestStart:
            changes.earliestStart ??
            `2026-12-07T${changes.omitItemStart ? '00:00' : (changes.itemStart ?? '10:00')}+09:00`,
          deadline:
            changes.deadline ??
            (changes.omitItemStart ? '2026-12-08T00:00+09:00' : '2026-12-07T10:30+09:00'),
          ...(changes.omitItemStart ? { timing: 'day' } : {}),
          ...(changes.taskTimeUnconfirmed ? { timeUnconfirmed: true } : {}),
        }
      : {}),
    start: changes.unplaced ? undefined : (changes.start ?? '2026-12-07T10:00+09:00'),
    end: changes.unplaced ? undefined : (changes.end ?? '2026-12-07T10:30+09:00'),
  });
  return verifyPlan({
    household: household(),
    events: changes.incompleteHistory ? events.slice(0, -1) : events,
    plan: plan({ throughSeq: 4, requirements: [req], tasks: [entry] }),
  }).issues;
}

describe('家の人がする作業の根拠', () => {
  for (const kind of ['homework', 'duty'] as const) {
    it(`${kind}: 作業名と要件が異なれば見つける`, () => {
      expect(check(kind, { taskWhat: '別の用件' })).toContainEqual(
        expect.objectContaining({
          kind: 'violation',
          code: 'task_requirement_content_mismatch',
        }),
      );
    });
    it(`${kind}: 作業と要件が揃っていても、元の事項と違えば見つける`, () => {
      expect(check(kind, { requirementWhat: '別の用件', taskWhat: '別の用件' })).toContainEqual(
        expect.objectContaining({ kind: 'violation', code: 'requirement_content_mismatch' }),
      );
    });
    it(`${kind}: 一致する物は誤って違反にしない`, () => {
      expect(check(kind).filter((issue) => issue.kind === 'violation')).toEqual([]);
    });
  }
  it('当番の要件の日は元の事項の日と照らす', () => {
    expect(check('duty', { requirementDate: '2026-12-14' })).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'requirement_date_mismatch' }),
    );
  });
  it('元の事項にある当番の日が要件に無ければ見つけ、元の日が無い時は未判定にする', () => {
    expect(check('duty', { omitRequirementDate: true })).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'requirement_date_mismatch' }),
    );
    expect(check('duty', { omitItemDate: true })).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'requirement_date_unverified' }),
    );
  });
  it('当番を明記された時刻と違う時刻に置けば見つける', () => {
    expect(
      check('duty', { start: '2026-12-07T09:00+09:00', end: '2026-12-07T09:30+09:00' }),
    ).toContainEqual(expect.objectContaining({ kind: 'violation', code: 'duty_time_mismatch' }));
  });
  it('開始を確かめられない当番を、確認なしの時刻として見せる計画を見つける', () => {
    const uncertain = { omitItemStart: true, startTimeUnconfirmed: true, unplaced: true };
    expect(check('duty', uncertain)).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'duty_time_confidence_mismatch' }),
    );
    expect(check('duty', { ...uncertain, taskTimeUnconfirmed: true })).not.toContainEqual(
      expect.objectContaining({ code: 'duty_time_confidence_mismatch' }),
    );
    expect(check('duty', { omitItemStart: true, unplaced: true })).not.toContainEqual(
      expect.objectContaining({ code: 'duty_time_confidence_mismatch' }),
    );
    // 確かめた開始が後から入れば、古い確認印だけで固定時刻を否定しない。
    expect(check('duty', { startTimeUnconfirmed: true })).not.toContainEqual(
      expect.objectContaining({ code: 'duty_time_confidence_mismatch' }),
    );
    expect(check('duty', { ...uncertain, incompleteHistory: true })).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'duty_time_confidence_unverified' }),
    );
  });
  it('未担当でも、示す開始や終了が元の時刻と違えば見つける', () => {
    expect(check('duty', { unplaced: true })).not.toContainEqual(
      expect.objectContaining({ code: 'duty_time_mismatch' }),
    );
    for (const changed of [
      { earliestStart: '2026-12-07T09:00+09:00' },
      { deadline: '2026-12-07T11:00+09:00' },
    ]) {
      expect(check('duty', { unplaced: true, ...changed })).toContainEqual(
        expect.objectContaining({ kind: 'violation', code: 'duty_time_mismatch' }),
      );
    }
  });
  for (const [field, value] of [
    ['date', '2026-12-14'],
    ['start', '09:00'],
    ['end', '10:45'],
    ['place', '旧校舎'],
  ] as const) {
    it(`当番の用件の ${field} が元の事項と違えば見つける`, () => {
      expect(check('duty', { itemPlace: '学校', taskParams: { [field]: value } })).toContainEqual(
        expect.objectContaining({ kind: 'violation', code: 'duty_content_mismatch' }),
      );
    });
  }
  it('日をまたぐ当番の終了は翌日として照らす', () => {
    const overnight = {
      itemStart: '23:00',
      itemEnd: '01:00',
      start: '2026-12-07T23:00+09:00',
      end: '2026-12-08T01:00+09:00',
      deadline: '2026-12-08T01:00+09:00',
    };
    expect(check('duty', overnight)).not.toContainEqual(
      expect.objectContaining({ code: 'duty_time_mismatch' }),
    );
    expect(check('duty', { ...overnight, end: '2026-12-08T00:00+09:00' })).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'duty_time_mismatch' }),
    );
  });
});
