// 送り迎えの対象・家の決まり・言明・時刻を独立に照らす。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement, task } from './fixtures';

function check(
  options: {
    sender?: string;
    leg?: 'to' | 'from';
    kind?: string;
    itemEvidence?: 'stated' | 'inferred';
    incompleteHistory?: boolean;
    childRules?: { id: string; to: boolean; from: boolean }[];
    extraUnconfiguredChild?: boolean;
    itemWhat?: string;
    itemDate?: string;
    itemStart?: string;
    itemEnd?: string;
    omitItemStart?: boolean;
    omitItemEnd?: boolean;
    startTimeUnconfirmed?: boolean;
    endTimeUnconfirmed?: boolean;
    itemPlace?: string;
    itemWritten?: string;
    sourceSentence?: string;
    reqWhat?: string;
    reqDate?: string;
    reqBy?: string;
    taskParams?: Record<string, string>;
    taskItemId?: string;
    omitTaskRequirement?: boolean;
    earliestStart?: string;
    deadline?: string;
    start?: string;
    end?: string;
    duration?: number;
    unplaced?: boolean;
    dayTask?: boolean;
    undatedTask?: boolean;
    taskTimeUnconfirmed?: boolean;
    statement?: Record<string, unknown>;
  } = {},
) {
  const leg = options.leg ?? 'to';
  const activityAt = leg === 'to' ? '10:00' : '12:00';
  const windowStart = leg === 'to' ? '2026-12-06T09:30+09:00' : '2026-12-06T11:30+09:00';
  const windowEnd = leg === 'to' ? '2026-12-06T10:30+09:00' : '2026-12-06T12:30+09:00';
  const family = Household.parse({
    ...household(),
    members: [
      ...household().members,
      ...(options.childRules ?? [{ id: 'child', to: true, from: true }]).map((child) => ({
        id: child.id,
        name: child.id,
        kind: 'child',
        clubEscort: { to: child.to, from: child.from },
      })),
      ...(options.extraUnconfiguredChild
        ? [{ id: 'other-child', name: '別の子', kind: 'child' }]
        : []),
    ],
  });
  const source = {
    id: 'club',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: options.sender ?? 'club',
    language: 'ja',
    sentences: [
      { id: 'club#1', text: options.sourceSentence ?? options.itemWritten ?? '練習試合' },
    ],
  };
  const item = {
    id: 'i1',
    sourceId: 'club',
    sentenceIds: ['club#1'],
    kind: options.kind ?? 'event',
    written: options.itemWritten ?? '練習試合',
    evidence: options.itemEvidence ?? 'stated',
    interpretation: {
      what: options.itemWhat ?? '練習試合',
      date: options.itemDate ?? '2026-12-06',
      ...(options.omitItemStart ? {} : { startTime: options.itemStart ?? '10:00' }),
      ...(options.omitItemEnd ? {} : { endTime: options.itemEnd ?? '12:00' }),
      ...(options.startTimeUnconfirmed ? { startTimeUnconfirmed: true } : {}),
      ...(options.endTimeUnconfirmed ? { endTimeUnconfirmed: true } : {}),
      place: options.itemPlace ?? '公園',
    },
    effects: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: family }),
    event(2, { type: 'noticeReceived', source }),
    event(3, {
      type: 'modelOutputRecorded',
      call: 'extract',
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      sourceId: 'club',
      sourceVersion: 1,
      output: {
        sourceId: 'club',
        items: options.taskItemId ? [item, { ...item, id: options.taskItemId }] : [item],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    }),
    ...(options.statement
      ? [
          event(options.incompleteHistory ? 5 : 4, {
            type: 'escortStated',
            itemId: 'i1',
            leg,
            needed: false,
            childId: 'child',
            what: '練習試合',
            date: '2026-12-06',
            at: options.dayTask ? null : activityAt,
            place: '公園',
            ...options.statement,
          }),
        ]
      : []),
  ];
  const req = requirement({
    key: 'r1',
    kind: 'escort',
    what: options.reqWhat ?? '練習試合',
    date: options.reqDate ?? '2026-12-06',
    by: options.reqBy ?? '2026-12-06T09:30+09:00',
    basis: { itemIds: ['i1'] },
  });
  const entry = task('t1', {
    titleKey: leg === 'to' ? 'task.escortTo' : 'task.escortFrom',
    titleParams: {
      what: '練習試合',
      ...(options.undatedTask ? { eventDate: '2026-12-06' } : { date: '2026-12-06' }),
      ...(options.dayTask || options.undatedTask ? {} : { at: activityAt }),
      place: '公園',
      ...options.taskParams,
    },
    basis: {
      itemIds: [options.taskItemId ?? 'i1'],
      ...(options.omitTaskRequirement ? {} : { requirementKey: 'r1' }),
    },
    earliestStart: options.undatedTask
      ? undefined
      : (options.earliestStart ?? (options.dayTask ? '2026-12-06T00:00+09:00' : windowStart)),
    deadline: options.undatedTask
      ? undefined
      : (options.deadline ?? (options.dayTask ? '2026-12-07T00:00+09:00' : windowEnd)),
    start:
      options.unplaced || options.dayTask || options.undatedTask
        ? undefined
        : (options.start ?? windowStart),
    end:
      options.unplaced || options.dayTask || options.undatedTask
        ? undefined
        : (options.end ?? windowEnd),
    durationMin: options.duration ?? (options.dayTask || options.undatedTask ? 0 : 60),
    segments: ['home', 'away'],
    timing: options.undatedTask ? 'undated' : options.dayTask ? 'day' : 'fixed',
    ...(options.taskTimeUnconfirmed ? { timeUnconfirmed: true } : {}),
  });
  const result = verifyPlan({
    household: family,
    plan: plan({
      throughSeq: options.incompleteHistory ? 5 : events.length,
      requirements: [req],
      tasks: [entry],
    }),
    events,
  });
  return result.issues;
}
const violation = (code: string) => expect.objectContaining({ kind: 'violation', code });

describe('送り迎えの根拠の独立検査', () => {
  it.each(['翌晩', '次の朝'])('「%s」の終わりを行事当日と決めない', (word) => {
    const input = {
      leg: 'from' as const,
      itemStart: '18:00',
      itemEnd: '20:00',
      itemWritten: `12月6日18:00から${word}20:00まで合宿します。`,
    };
    expect(check(input)).toContainEqual(violation('escort_date_confidence_mismatch'));
    expect(check({ ...input, undatedTask: true, taskTimeUnconfirmed: true })).not.toContainEqual(
      violation('escort_date_confidence_mismatch'),
    );
  });
  it('翌日の時刻を読めなかった迎えに、行事の前日を付けない', () => {
    const input = {
      leg: 'from' as const,
      itemStart: '23:00',
      omitItemEnd: true,
      endTimeUnconfirmed: true,
      itemWritten: '12月6日23:00から翌日午前1時まで練習します。',
    };
    expect(check({ ...input, dayTask: true, taskTimeUnconfirmed: true })).toContainEqual(
      violation('escort_date_confidence_mismatch'),
    );
    expect(check({ ...input, undatedTask: true, taskTimeUnconfirmed: true })).not.toContainEqual(
      violation('escort_date_confidence_mismatch'),
    );
    const withoutMarker = { ...input, itemWritten: '終了時刻を確かめてください。' };
    expect(check({ ...withoutMarker, dayTask: true, taskTimeUnconfirmed: true })).toContainEqual(
      violation('escort_date_confidence_mismatch'),
    );
    expect(
      check({ ...withoutMarker, undatedTask: true, taskTimeUnconfirmed: true }),
    ).not.toContainEqual(violation('escort_date_confidence_mismatch'));
  });
  it('翌日を含む原文から終了日の対応を確かめられなければ、同日と断定しない', () => {
    const result = check({
      leg: 'from',
      omitItemStart: true,
      itemEnd: '01:00',
      itemWritten: '12月6日開催の練習は、翌日01:00終了です。',
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'escort_end_date_unverified',
      }),
    );
    expect(result).not.toContainEqual(violation('escort_task_content_mismatch'));
    // 事項の短い引用が「翌日」を含まなくても、根拠として指す文を確かめる。
    const shortened = check({
      leg: 'from',
      itemStart: '09:00',
      itemEnd: '10:00',
      itemWritten: '練習',
      sourceSentence: '12月6日09:00から翌日10:00まで練習します。',
    });
    expect(shortened).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'escort_end_date_unverified',
      }),
    );
  });
  it('家の決まりと、クラブの行事・元の日・時刻が一致する物を誤って拒まない', () => {
    expect(check().filter((entry) => entry.kind === 'violation')).toEqual([]);
    expect(check({ leg: 'from' }).filter((entry) => entry.kind === 'violation')).toEqual([]);
    expect(check()).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'escort_route_unverified' }),
    );
  });
  it('送信元が club でない事項や行事でない事項を、クラブの接送にしない', () => {
    expect(check({ sender: 'school' })).toContainEqual(violation('escort_source_mismatch'));
    expect(check({ kind: 'duty' })).toContainEqual(violation('escort_item_kind_mismatch'));
  });
  it('家の決まりのある子を一人に決められない時、接送を確定しない', () => {
    expect(check({ childRules: [] })).toContainEqual(violation('escort_child_ambiguous'));
    expect(
      check({
        childRules: [
          { id: 'a1', to: true, from: true },
          { id: 'a2', to: true, from: true },
        ],
      }),
    ).toContainEqual(violation('escort_child_ambiguous'));
  });
  it('子が二人いて一人にだけ決まりがあっても、通知がその子の物とは決められない', () => {
    expect(check({ extraUnconfiguredChild: true })).toContainEqual(
      violation('escort_child_ambiguous'),
    );
  });
  it('要件の用件・日が元の行事と違えば見つける', () => {
    expect(check({ reqWhat: '別の行事' })).toContainEqual(
      violation('escort_requirement_content_mismatch'),
    );
    expect(check({ reqDate: '2026-12-13' })).toContainEqual(
      violation('escort_requirement_date_mismatch'),
    );
  });
  it('元の事項が推定、または事象が欠けていれば、食い違いを未判定にする', () => {
    for (const options of [
      { itemEvidence: 'inferred' as const },
      { incompleteHistory: true, statement: { needed: true } },
    ]) {
      const result = check({ ...options, reqWhat: '別の行事' });
      expect(result).not.toContainEqual(violation('escort_requirement_content_mismatch'));
      expect(result).toContainEqual(
        expect.objectContaining({
          kind: 'undetermined',
          code: 'escort_requirement_content_mismatch_unverified',
        }),
      );
    }
  });
  it('要件の期限を、必要な中で最初の送り迎えの出発に合わせる', () => {
    expect(check({ reqBy: '2026-12-06T10:00+09:00' })).toContainEqual(
      violation('escort_requirement_deadline_mismatch'),
    );
    const onlyFrom = [{ id: 'child', to: false, from: true }];
    expect(
      check({ leg: 'from', childRules: onlyFrom, reqBy: '2026-12-06T11:30+09:00' }),
    ).not.toContainEqual(violation('escort_requirement_deadline_mismatch'));
    expect(
      check({ leg: 'from', childRules: onlyFrom, reqBy: '2026-12-06T12:00+09:00' }),
    ).toContainEqual(violation('escort_requirement_deadline_mismatch'));
    expect(
      check({
        leg: 'from',
        omitItemEnd: true,
        dayTask: true,
        reqBy: '2026-12-06T00:00+09:00',
      }),
    ).not.toContainEqual(violation('escort_requirement_deadline_mismatch'));
  });
  it('同じ名と日でも、別の行事を要件と作業につなげない', () => {
    expect(check({ taskItemId: 'i2' })).toContainEqual(violation('escort_task_basis_mismatch'));
    expect(check({ omitTaskRequirement: true })).toContainEqual(
      violation('escort_requirement_missing'),
    );
  });
  for (const [key, value] of [
    ['what', '別の行事'],
    ['date', '2026-12-13'],
    ['at', '11:00'],
    ['place', '別の公園'],
  ] as const) {
    it(`送りの用件の ${key} が元の行事と違えば見つける`, () => {
      expect(check({ taskParams: { [key]: value } })).toContainEqual(
        violation('escort_task_content_mismatch'),
      );
    });
  }
  it('送りを時刻の前後 30 分の目安の区間以外に置かない', () => {
    expect(check({ earliestStart: '2026-12-06T09:20+09:00' })).toContainEqual(
      violation('escort_window_mismatch'),
    );
    expect(
      check({ start: '2026-12-06T09:20+09:00', end: '2026-12-06T10:20+09:00' }),
    ).toContainEqual(violation('escort_window_mismatch'));
    expect(check({ duration: 25 })).toContainEqual(violation('escort_window_mismatch'));
  });
  it('迎えを、書かれた終了時刻の前後 30 分の目安以外に置かない', () => {
    expect(check({ leg: 'from', earliestStart: '2026-12-06T11:20+09:00' })).toContainEqual(
      violation('escort_window_mismatch'),
    );
    expect(
      check({ leg: 'from', start: '2026-12-06T11:20+09:00', end: '2026-12-06T12:20+09:00' }),
    ).toContainEqual(violation('escort_window_mismatch'));
  });
  it('終了が開始以前で 12 時間より長ければ、時刻を確定せず、元の文の確認を促す', () => {
    const unknown = {
      leg: 'from' as const,
      itemStart: '10:00',
      itemEnd: '01:00',
      reqBy: '2026-12-06T00:00+09:00',
    };
    expect(
      check({ ...unknown, undatedTask: true, taskTimeUnconfirmed: true }).filter(
        (entry) => entry.kind === 'violation',
      ),
    ).toEqual([]);
    expect(check({ ...unknown, undatedTask: true })).toContainEqual(
      violation('escort_date_confidence_mismatch'),
    );
    expect(check(unknown)).toContainEqual(violation('escort_date_confidence_mismatch'));
  });
  it('終了時刻なしの迎えと、原文から読み取れなかった迎えを区別する', () => {
    const noEnd = {
      leg: 'from' as const,
      omitItemEnd: true,
      dayTask: true,
      reqBy: '2026-12-06T00:00+09:00',
    };
    expect(check(noEnd).filter((entry) => entry.kind === 'violation')).toEqual([]);
    const dropped = { ...noEnd, endTimeUnconfirmed: true };
    expect(check(dropped)).toContainEqual(violation('escort_date_confidence_mismatch'));
    expect(
      check({ ...dropped, undatedTask: true, taskTimeUnconfirmed: true }).filter(
        (entry) => entry.kind === 'violation',
      ),
    ).toEqual([]);
  });
  it('開始時刻を読み取れなかった送りは、時刻を確認してもらう', () => {
    const dropped = {
      omitItemStart: true,
      startTimeUnconfirmed: true,
      dayTask: true,
      reqBy: '2026-12-06T00:00+09:00',
    };
    expect(check(dropped)).toContainEqual(violation('escort_time_confidence_mismatch'));
    expect(
      check({ ...dropped, taskTimeUnconfirmed: true }).filter(
        (entry) => entry.kind === 'violation',
      ),
    ).toEqual([]);
  });
  it('開始 23 時・終了 1 時の迎えは、翌日 0:30–1:30 の目安で照らす', () => {
    const overnight = {
      leg: 'from' as const,
      itemStart: '23:00',
      itemEnd: '01:00',
      taskParams: { date: '2026-12-07', at: '01:00' },
      earliestStart: '2026-12-07T00:30+09:00',
      deadline: '2026-12-07T01:30+09:00',
      reqBy: '2026-12-06T22:30+09:00',
      unplaced: true,
    };
    const result = check(overnight);
    expect(result.filter((entry) => entry.kind === 'violation')).toEqual([]);
    expect(check({ ...overnight, taskParams: { date: '2026-12-06', at: '01:00' } })).toContainEqual(
      violation('escort_task_content_mismatch'),
    );
    const writtenNext = { ...overnight, itemWritten: '12月6日23:00から翌日1:00まで練習します。' };
    expect(check(writtenNext)).not.toContainEqual(violation('escort_task_content_mismatch'));
    expect(
      check({ ...writtenNext, taskParams: { date: '2026-12-06', at: '01:00' } }),
    ).toContainEqual(violation('escort_task_content_mismatch'));
  });
  it('行事が 0:10 開始なら、送りの目安は前日 23:40 からになる', () => {
    const early = {
      itemStart: '00:10',
      taskParams: { at: '00:10' },
      earliestStart: '2026-12-05T23:40+09:00',
      deadline: '2026-12-06T00:40+09:00',
      reqBy: '2026-12-05T23:40+09:00',
      unplaced: true,
    };
    expect(check(early).filter((entry) => entry.kind === 'violation')).toEqual([]);
    expect(check({ ...early, earliestStart: '2026-12-06T23:40+09:00' })).toContainEqual(
      violation('escort_window_mismatch'),
    );
  });
  it('今回の送りは不要と言った時、有効な送りの作業を残さない', () => {
    expect(check({ statement: {} })).toContainEqual(violation('escort_statement_conflict'));
  });
  it('子または場所の違う古い言明は今の行事には当てない', () => {
    expect(check({ statement: { childId: 'old-child' } })).not.toContainEqual(
      violation('escort_statement_conflict'),
    );
    expect(check({ statement: { place: '古い公園' } })).not.toContainEqual(
      violation('escort_statement_conflict'),
    );
  });
  it('家の決まりが不要の時は作業を出さず、今回必要という言明があれば出せる', () => {
    const childRules = [{ id: 'child', to: false, from: true }];
    expect(check({ childRules })).toContainEqual(violation('escort_rule_conflict'));
    expect(check({ childRules, statement: { needed: true } })).not.toContainEqual(
      violation('escort_rule_conflict'),
    );
  });
});
