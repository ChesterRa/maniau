// 作り手が指定した小さな域の正解を先に決める。製品の求解方法には依存しない。
import { describe, expect, it } from 'vitest';
import {
  assessTrial,
  changesFrom,
  checkTrial,
  enumerateTrial,
  type TrialDomain,
  type TrialSchedule,
} from './joint-oracle';

const domain = (): TrialDomain => ({
  availability: { a: [{ start: 0, end: 4 }] },
  tasks: [
    { id: 'one', content: '一つ目', duration: 2, earliest: 0, deadline: 4, people: ['a'] },
    { id: 'two', content: '二つ目', duration: 2, earliest: 0, deadline: 4, people: ['a'] },
  ],
});

describe('求解結果の主張を有限域で照らす', () => {
  it('可行な候補に重なりがあれば受けず、条件を満たす候補は受ける', () => {
    const overlap = schedule(
      placement('one', 'a', 0, '一つ目'),
      placement('two', 'a', 0, '二つ目'),
    );
    const valid = schedule(placement('one', 'a', 0, '一つ目'), placement('two', 'a', 2, '二つ目'));
    expect(assessTrial(domain(), { kind: 'feasible', schedule: overlap })).toMatchObject({
      kind: 'violation',
      reasons: expect.arrayContaining(['overlap']),
    });
    expect(assessTrial(domain(), { kind: 'feasible', schedule: valid })).toEqual({
      kind: 'pass',
      reasons: [],
    });
  });

  it('置けるのに無解と言えば違反、全候補を調べられなければ未判定', () => {
    expect(assessTrial(domain(), { kind: 'infeasible' })).toEqual({
      kind: 'violation',
      reasons: ['false_infeasible'],
    });
    expect(assessTrial(domain(), { kind: 'infeasible' }, [], 1)).toEqual({
      kind: 'undetermined',
      reasons: ['reference_incomplete'],
    });
    const witnessBudget = Array.from({ length: 50 }, (_, index) => index + 1).find((limit) => {
      const result = enumerateTrial(domain(), limit);
      return !result.complete && result.schedules.length > 0;
    });
    expect(witnessBudget).toBeDefined();
    expect(assessTrial(domain(), { kind: 'infeasible' }, [], witnessBudget)).toEqual({
      kind: 'violation',
      reasons: ['false_infeasible'],
    });
    const impossible: TrialDomain = { ...domain(), availability: { a: [{ start: 0, end: 3 }] } };
    expect(assessTrial(impossible, { kind: 'infeasible' })).toEqual({ kind: 'pass', reasons: [] });
    expect(assessTrial(domain(), { kind: 'unknown' })).toEqual({
      kind: 'undetermined',
      reasons: ['solver_unknown'],
    });
  });

  it('外の返事を待っている時、時間が置けても確定とも無解とも言わない', () => {
    const valid = schedule(placement('one', 'a', 0, '一つ目'), placement('two', 'a', 2, '二つ目'));
    const waiting: TrialDomain = { ...domain(), assumptions: { grandma: 'waiting' } };
    expect(assessTrial(waiting, { kind: 'feasible', schedule: valid })).toEqual({
      kind: 'undetermined',
      reasons: ['assumption_waiting'],
    });
    expect(assessTrial(waiting, { kind: 'infeasible' })).toEqual({
      kind: 'undetermined',
      reasons: ['assumption_waiting'],
    });
    expect(
      assessTrial(waiting, { kind: 'conditional', schedule: valid, requires: ['grandma'] }),
    ).toEqual({ kind: 'pass', reasons: [] });
    expect(assessTrial(waiting, { kind: 'conditional', schedule: valid, requires: [] })).toEqual({
      kind: 'violation',
      reasons: ['condition_missing'],
    });
    expect(
      assessTrial(waiting, {
        kind: 'conditional',
        schedule: valid,
        requires: ['grandma', 'other'],
      }),
    ).toEqual({ kind: 'violation', reasons: ['condition_unknown'] });
    const confirmed: TrialDomain = { ...waiting, assumptions: { grandma: 'confirmed' } };
    expect(assessTrial(confirmed, { kind: 'feasible', schedule: valid })).toEqual({
      kind: 'pass',
      reasons: [],
    });
    const unasked: TrialDomain = { ...waiting, assumptions: { grandma: 'unasked' } };
    expect(assessTrial(unasked, { kind: 'feasible', schedule: valid })).toEqual({
      kind: 'undetermined',
      reasons: ['assumption_unasked'],
    });
    const rejected: TrialDomain = { ...waiting, assumptions: { grandma: 'rejected' } };
    expect(assessTrial(rejected, { kind: 'feasible', schedule: valid })).toEqual({
      kind: 'violation',
      reasons: ['assumption_rejected'],
    });
    expect(assessTrial(rejected, { kind: 'infeasible' })).toEqual({ kind: 'pass', reasons: [] });
    const impossible: TrialDomain = { ...waiting, availability: { a: [{ start: 0, end: 3 }] } };
    expect(assessTrial(impossible, { kind: 'infeasible' })).toEqual({ kind: 'pass', reasons: [] });
  });

  it('より変更の少ない反例があれば最小という主張を断る', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 6 }] },
      tasks: domain().tasks.map((task) => ({ ...task, deadline: 6 })),
    };
    const before = [placement('one', 'a', 0, '一つ目'), placement('two', 'a', 0, '二つ目')];
    const wasteful = schedule(
      placement('one', 'a', 2, '一つ目'),
      placement('two', 'a', 4, '二つ目'),
    );
    const minimal = schedule(
      placement('one', 'a', 0, '一つ目'),
      placement('two', 'a', 2, '二つ目'),
    );
    expect(
      assessTrial(input, { kind: 'feasible', schedule: wasteful, minimumChanges: true }, before),
    ).toEqual({ kind: 'violation', reasons: ['not_minimum'] });
    expect(
      assessTrial(input, { kind: 'feasible', schedule: minimal, minimumChanges: true }, before),
    ).toEqual({ kind: 'pass', reasons: [] });
    expect(
      assessTrial(input, { kind: 'feasible', schedule: minimal, minimumChanges: true }, before, 1),
    ).toEqual({ kind: 'undetermined', reasons: ['reference_incomplete'] });
    const betterBudget = Array.from({ length: 100 }, (_, index) => index + 1).find((limit) => {
      const result = enumerateTrial(input, limit);
      return !result.complete && result.schedules.some((s) => changesFrom(s, before) < 2);
    });
    expect(betterBudget).toBeDefined();
    expect(
      assessTrial(
        input,
        { kind: 'feasible', schedule: wasteful, minimumChanges: true },
        before,
        betterBudget,
      ),
    ).toEqual({ kind: 'violation', reasons: ['not_minimum'] });
  });
});
const placement = (task: string, person: string, start: number, content: string, duration = 2) => ({
  task,
  person,
  start,
  end: start + duration,
  content,
});
const schedule = (...placements: TrialSchedule['placements']): TrialSchedule => ({
  choices: {},
  placements,
});

describe('複数の作業を同時に置く有限の試験域', () => {
  it('作業本体が重ならなくても、移動と寄り道の帰着を含む時間は重ねない', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 20 }] },
      tasks: [
        {
          id: 'visit',
          content: '寄る',
          duration: 2,
          earliest: 5,
          deadline: 7,
          people: ['a'],
          travelBefore: 2,
          travelAfter: 1,
          delayedArrival: 13,
        },
        { id: 'call', content: '電話', duration: 2, earliest: 8, deadline: 15, people: ['a'] },
      ],
    };
    const visit = {
      ...placement('visit', 'a', 5, '寄る'),
      travelBefore: 2,
      travelAfter: 1,
      delayedArrival: 13,
    };
    const overlapping = schedule(visit, placement('call', 'a', 8, '電話'));
    expect(checkTrial(input, overlapping)).toContain('overlap');
    const adjacent = schedule(visit, placement('call', 'a', 13, '電話'));
    expect(checkTrial(input, adjacent)).toEqual([]);
    expect(
      checkTrial(
        input,
        schedule(placement('visit', 'a', 5, '寄る'), placement('call', 'a', 13, '電話')),
      ),
    ).toContain('travel');
    const enumeration = enumerateTrial(input);
    expect(enumeration.complete).toBe(true);
    expect(enumeration.schedules).toHaveLength(1);
    expect(enumeration.schedules[0]?.placements.find((p) => p.task === 'call')?.start).toBe(13);
  });

  it('本人の空きには移動を含め、引き受けた時の移動と帰着も控えと比べる', () => {
    const visit = {
      ...placement('visit', 'a', 5, '寄る'),
      travelBefore: 2,
      travelAfter: 1,
      delayedArrival: 13,
    };
    const input: TrialDomain = {
      availability: { a: [{ start: 3, end: 13 }] },
      tasks: [
        {
          id: 'visit',
          content: '寄る',
          duration: 2,
          earliest: 5,
          deadline: 7,
          people: ['a'],
          travelBefore: 2,
          travelAfter: 1,
          delayedArrival: 13,
          locked: {
            person: 'a',
            start: 5,
            end: 7,
            content: '寄る',
            travelBefore: 2,
            travelAfter: 1,
            delayedArrival: 13,
          },
        },
      ],
    };
    expect(checkTrial(input, schedule(visit))).toEqual([]);
    expect(enumerateTrial(input).schedules).toHaveLength(1);
    const unavailable: TrialDomain = { ...input, availability: { a: [{ start: 4, end: 13 }] } };
    expect(checkTrial(unavailable, schedule(visit))).toContain('availability');
    expect(enumerateTrial(unavailable).schedules).toEqual([]);
    const changed: TrialDomain = {
      ...input,
      tasks: input.tasks.map((task) => ({ ...task, travelAfter: 2 })),
    };
    const changedVisit = { ...visit, travelAfter: 2 };
    expect(checkTrial(changed, schedule(changedVisit))).toContain('locked');
    expect(enumerateTrial(changed).schedules).toEqual([]);
    expect(changesFrom(schedule(changedVisit), [visit])).toBe(1);
    expect(() =>
      enumerateTrial({
        ...input,
        tasks: input.tasks.map((task) => ({ ...task, travelBefore: -1 })),
      }),
    ).toThrow();
  });

  it('一人の四分に二分の作業を二つ置く方法は二つだけ', () => {
    const result = enumerateTrial(domain());
    expect(result.complete).toBe(true);
    expect(result.schedules).toHaveLength(2);
    expect(result.schedules.map((s) => s.placements.map((p) => p.start))).toEqual([
      [0, 2],
      [2, 0],
    ]);
    for (const candidate of result.schedules) expect(checkTrial(domain(), candidate)).toEqual([]);
  });

  it('三分しか使えなければ、二分の作業を二つ置けない', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 3 }] },
      tasks: domain().tasks,
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules).toEqual([]);
  });

  it('二人とも二分使えるなら、二つを同時に別の人が引き受けられる', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 2 }], b: [{ start: 0, end: 2 }] },
      tasks: domain().tasks.map((task) => ({ ...task, people: ['a', 'b'], deadline: 2 })),
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules).toHaveLength(2);
    expect(result.schedules.map((s) => s.placements.map((p) => p.person))).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });

  it('二日分の学童の届出を、一つ目の承諾を動かさず同じ人の区間に置く', () => {
    // 17:10 を 0 とし、書く区間は 0–20、提出できる区間は 45–55 とした架空の縮小場面。
    const input: TrialDomain = {
      availability: {
        a: [
          { start: 0, end: 20 },
          { start: 45, end: 55 },
        ],
      },
      placeAvailability: { school: [{ start: 45, end: 55 }] },
      tasks: [
        {
          id: 'write1',
          content: '一日目を書く',
          duration: 10,
          earliest: 0,
          deadline: 20,
          people: ['a'],
          locked: { person: 'a', start: 10, end: 20, content: '一日目を書く' },
        },
        {
          id: 'send1',
          content: '一日目を出す',
          place: 'school',
          duration: 5,
          earliest: 45,
          deadline: 55,
          people: ['a'],
          after: [{ task: 'write1', wait: 0 }],
          locked: { person: 'a', start: 50, end: 55, content: '一日目を出す', place: 'school' },
        },
        {
          id: 'write2',
          content: '二日目を書く',
          duration: 10,
          earliest: 0,
          deadline: 20,
          people: ['a'],
        },
        {
          id: 'send2',
          content: '二日目を出す',
          place: 'school',
          duration: 5,
          earliest: 45,
          deadline: 55,
          people: ['a'],
          after: [{ task: 'write2', wait: 0 }],
        },
      ],
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.placements.map((p) => p.start)).toEqual([10, 50, 0, 45]);
    const tooLong: TrialDomain = {
      ...input,
      tasks: input.tasks.map((task) => (task.id === 'send2' ? { ...task, duration: 6 } : task)),
    };
    expect(enumerateTrial(tooLong)).toMatchObject({ complete: true, schedules: [] });
  });

  it('先に書く作業と、待ち時間を置いて出す作業の順を守る', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 5 }] },
      tasks: [
        { id: 'write', content: '書く', duration: 2, earliest: 0, deadline: 5, people: ['a'] },
        {
          id: 'send',
          content: '出す',
          duration: 1,
          earliest: 0,
          deadline: 5,
          people: ['a'],
          after: [{ task: 'write', wait: 1 }],
        },
      ],
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules).toHaveLength(3);
    for (const candidate of result.schedules) {
      const [first, second] = candidate.placements;
      expect(first && second && first.end + 1 <= second.start).toBe(true);
    }
    expect(
      checkTrial(
        input,
        schedule(placement('write', 'a', 0, '書く'), placement('send', 'a', 2, '出す', 1)),
      ),
    ).toContain('precedence');
  });

  it('人が使えても、場所が開いている区間の外には置かない', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 4 }] },
      placeAvailability: { school: [{ start: 2, end: 4 }] },
      tasks: [
        {
          id: 'send',
          content: '出す',
          place: 'school',
          duration: 1,
          earliest: 0,
          deadline: 4,
          people: ['a'],
        },
      ],
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules.map((s) => s.placements[0]?.start)).toEqual([2, 3]);
    expect(
      checkTrial(input, schedule({ ...placement('send', 'a', 1, '出す', 1), place: 'school' })),
    ).toContain('placeAvailability');
    const closed: TrialDomain = { ...input, placeAvailability: { school: [] } };
    expect(enumerateTrial(closed)).toEqual({ complete: true, schedules: [] });
    expect(() => enumerateTrial({ ...input, placeAvailability: {} })).toThrow(
      '場所の使える区間が無い',
    );
  });

  it('人が使えても、作業の種類で許された区間の外には置かない', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 4 }] },
      tasks: [
        {
          id: 'paper',
          content: '書く',
          duration: 1,
          earliest: 0,
          deadline: 4,
          people: ['a'],
          windows: [{ start: 1, end: 3 }],
        },
      ],
    };
    expect(enumerateTrial(input).schedules.map((s) => s.placements[0]?.start)).toEqual([1, 2]);
    expect(checkTrial(input, schedule(placement('paper', 'a', 0, '書く', 1)))).toContain(
      'taskWindow',
    );
  });

  it('隣り合う使える区間は合わせ、隙間がある時はまたがない', () => {
    const input: TrialDomain = {
      availability: {
        a: [
          { start: 1, end: 3 },
          { start: 0, end: 1 },
        ],
      },
      placeAvailability: {
        school: [
          { start: 0, end: 1 },
          { start: 1, end: 3 },
        ],
      },
      tasks: [
        {
          id: 'send',
          content: '出す',
          place: 'school',
          duration: 2,
          earliest: 0,
          deadline: 3,
          people: ['a'],
        },
      ],
    };
    expect(enumerateTrial(input).schedules.map((s) => s.placements[0]?.start)).toEqual([0, 1]);
    const gap: TrialDomain = {
      ...input,
      availability: {
        a: [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
      },
    };
    expect(enumerateTrial(gap)).toEqual({ complete: true, schedules: [] });
  });

  it('既に答えた時刻・人・用件を変えず、重なるもう一つを動かす', () => {
    const input: TrialDomain = {
      ...domain(),
      tasks: domain().tasks.map((task) =>
        task.id === 'one'
          ? { ...task, locked: { person: 'a', start: 0, end: 2, content: '一つ目' } }
          : task,
      ),
    };
    const result = enumerateTrial(input);
    expect(result.complete).toBe(true);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.placements.map((p) => p.start)).toEqual([0, 2]);
    expect(
      checkTrial(
        input,
        schedule(placement('one', 'a', 2, '一つ目'), placement('two', 'a', 0, '二つ目')),
      ),
    ).toContain('locked');
    const changedContent: TrialDomain = {
      ...input,
      tasks: input.tasks.map((task) => (task.id === 'one' ? { ...task, content: '訂正後' } : task)),
    };
    expect(enumerateTrial(changedContent)).toMatchObject({ complete: true, schedules: [] });
  });

  it('受けた人・終わる時刻・場所・条件が変われば、承諾済みとして固定できない', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 6 }], b: [{ start: 0, end: 6 }] },
      placeAvailability: { school: [{ start: 0, end: 6 }], home: [{ start: 0, end: 6 }] },
      tasks: [
        {
          id: 'one',
          content: '出す',
          place: 'school',
          condition: '晴れなら',
          recipient: 'grandma',
          duration: 2,
          earliest: 0,
          deadline: 6,
          people: ['a', 'b'],
          locked: {
            person: 'a',
            start: 2,
            end: 4,
            content: '出す',
            place: 'school',
            condition: '晴れなら',
            recipient: 'grandma',
          },
        },
      ],
    };
    expect(enumerateTrial(input).schedules).toHaveLength(1);
    for (const change of [
      { people: ['b'] },
      { duration: 3 },
      { place: 'home' },
      { condition: '雨なら' },
      { recipient: 'school' },
    ]) {
      const altered: TrialDomain = {
        ...input,
        tasks: input.tasks.map((task) => ({ ...task, ...change })),
      };
      expect(enumerateTrial(altered)).toMatchObject({ complete: true, schedules: [] });
    }
  });

  it('選択肢はどちらも試し、承諾済みの作業を黙って消す選択は除く', () => {
    const input: TrialDomain = {
      availability: { a: [{ start: 0, end: 4 }] },
      groups: { care: ['school', 'leave'] },
      tasks: [
        {
          id: 'paper',
          content: '届出',
          duration: 2,
          earliest: 0,
          deadline: 4,
          people: ['a'],
          when: { group: 'care', choice: 'school' },
        },
        {
          id: 'leave',
          content: '休み',
          duration: 2,
          earliest: 0,
          deadline: 4,
          people: ['a'],
          when: { group: 'care', choice: 'leave' },
        },
      ],
    };
    const options = new Set(enumerateTrial(input).schedules.map((s) => s.choices.care));
    expect(options).toEqual(new Set(['school', 'leave']));
    expect(enumerateTrial(input).schedules).toHaveLength(6);
    const locked: TrialDomain = {
      ...input,
      tasks: input.tasks.map((task) =>
        task.id === 'paper'
          ? { ...task, locked: { person: 'a', start: 0, end: 2, content: '届出' } }
          : task,
      ),
    };
    expect(new Set(enumerateTrial(locked).schedules.map((s) => s.choices.care))).toEqual(
      new Set(['school']),
    );
    expect(
      checkTrial(locked, {
        choices: { care: 'leave' },
        placements: [placement('leave', 'a', 0, '休み')],
      }),
    ).toContain('locked');
  });

  it('重なっていた二案のうち、一つだけ動かす候補を数えられる', () => {
    const before = [placement('one', 'a', 0, '一つ目'), placement('two', 'a', 0, '二つ目')];
    const result = enumerateTrial(domain());
    expect(checkTrial(domain(), schedule(...before))).toContain('overlap');
    expect(Math.min(...result.schedules.map((s) => changesFrom(s, before)))).toBe(1);
  });

  it('探索を途中で止めた時、候補が無くても全て試したとは言わない', () => {
    const result = enumerateTrial(domain(), 1);
    expect(result).toEqual({ schedules: [], complete: false });
    const partial = Array.from({ length: 50 }, (_, index) =>
      enumerateTrial(domain(), index + 1),
    ).find((entry) => !entry.complete && entry.schedules.length > 0);
    expect(partial).toBeDefined();
  });

  it('元の入力を変更せず、時刻・締切・担当の誤りをそれぞれ見つける', () => {
    const input = domain();
    const before = structuredClone(input);
    const bad = schedule(placement('one', 'a', 3, '一つ目'), placement('two', 'b', 0, '二つ目'));
    expect(checkTrial(input, bad)).toEqual(
      expect.arrayContaining(['deadline', 'availability', 'person']),
    );
    const duplicate = placement('one', 'a', 0, '一つ目');
    expect(checkTrial(input, schedule(duplicate, duplicate))).toEqual(
      expect.arrayContaining(['duplicate', 'missing', 'overlap']),
    );
    enumerateTrial(input);
    expect(input).toEqual(before);
    expect(enumerateTrial(input)).toEqual(enumerateTrial(input));
    expect(() => enumerateTrial({ ...input, groups: { care: [''] } })).toThrow('選択肢が不正');
    const first = input.tasks[0];
    if (!first) throw new Error('試験の作業が無い');
    expect(() =>
      enumerateTrial({
        ...input,
        tasks: [{ ...first, deadline: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toThrow('作業の条件が不正');
  });
});
