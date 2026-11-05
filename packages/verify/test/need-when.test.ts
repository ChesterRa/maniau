// 候補・答え・人数・決定の版を事象から独立に検証する。求解器の関数を使わない。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { independentAvailability } from '../src/need-when';
import { arrangement, event, household, option, plan, requirement } from './fixtures';

const at = '2026-11-30T10:00+09:00';
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('試験の材料が無い');
  return value;
}
const people = [
  { id: 'a', kind: 'member' },
  { id: 'b', kind: 'member' },
  { id: 'helper', kind: 'member' },
];
const candidates = [
  { id: 'c1', rev: 1, date: '2026-12-12', startTime: '13:00', endTime: '15:00' },
  { id: 'c2', rev: 1, date: '2026-12-19', startTime: '13:00', endTime: '15:00' },
];
const item = {
  id: 'item-1',
  sourceId: 'source-1',
  sentenceIds: ['s1'],
  kind: 'need',
  written: '架空の用件',
  interpretation: { what: '架空の用件', shape: 'window', holdNeeded: false },
  evidence: 'stated',
  effects: [],
};
const source = {
  id: 'source-1',
  version: 1,
  receivedAt: at,
  sender: 'family',
  language: 'ja',
  sentences: [{ id: 's1', text: '架空の用件' }],
};
const initialEvents = () => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', source }),
  event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] }),
  event(4, { type: 'needCandidatesSet', itemId: 'item-1', candidates }),
  event(5, { type: 'needPeopleSet', itemId: 'item-1', people, required: ['helper'], minCount: 2 }),
  event(6, {
    type: 'answerLinkIssued',
    itemId: 'item-1',
    personId: 'helper',
    linkId: 'l1',
    tokenHash: 'a'.repeat(64),
  }),
  event(7, {
    type: 'availabilityRecorded',
    itemId: 'item-1',
    candidateId: 'c1',
    rev: 1,
    personId: 'a',
    source: 'self',
    answer: 'yes',
  }),
  event(8, {
    type: 'availabilityRecorded',
    itemId: 'item-1',
    candidateId: 'c1',
    rev: 1,
    personId: 'b',
    source: 'family',
    answer: 'maybe',
    note: '仕事しだい',
  }),
  event(9, {
    type: 'availabilityRecorded',
    itemId: 'item-1',
    candidateId: 'c1',
    rev: 1,
    personId: 'helper',
    source: 'link',
    answer: 'yes',
    actorId: 'link',
    linkId: 'l1',
  }),
];
const initialWhen = () => ({
  people,
  required: ['helper'],
  minCount: 2,
  inUse: false,
  candidates: [
    {
      id: 'c1',
      rev: 1,
      date: '2026-12-12',
      start: '2026-12-12T13:00+09:00',
      end: '2026-12-12T15:00+09:00',
      yes: 2,
      possible: 3,
      requiredNo: [],
      requiredOpen: [],
      condition: 'meets',
      pivotal: [],
      ways: [],
      flags: ['waysUndecided'],
    },
    {
      id: 'c2',
      rev: 1,
      date: '2026-12-19',
      start: '2026-12-19T13:00+09:00',
      end: '2026-12-19T15:00+09:00',
      yes: 0,
      possible: 3,
      requiredNo: [],
      requiredOpen: ['helper'],
      condition: 'open',
      pivotal: ['a', 'b', 'helper'],
      ways: [],
      flags: ['waysUndecided'],
    },
  ],
  answers: [
    {
      personId: 'a',
      candidateId: 'c1',
      value: 'yes',
      sources: [{ source: 'self', answer: 'yes', by: 'a', at, seq: 7 }],
    },
    {
      personId: 'b',
      candidateId: 'c1',
      value: 'maybe',
      sources: [{ source: 'family', answer: 'maybe', by: 'a', at, seq: 8, note: '仕事しだい' }],
    },
    {
      personId: 'helper',
      candidateId: 'c1',
      value: 'yes',
      sources: [{ source: 'link', answer: 'yes', by: 'link', at, seq: 9 }],
    },
  ],
  links: [
    { personId: 'a', active: false },
    { personId: 'b', active: false },
    { personId: 'helper', active: true },
  ],
});
const check = (events = initialEvents(), when = initialWhen()) =>
  verifyPlan({
    household: household(),
    events,
    plan: plan({
      throughSeq: events.at(-1)?.seq ?? 0,
      requirements: [
        requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item-1'] }, when }),
      ],
    }),
  });
const issues = (events = initialEvents(), when = initialWhen()) =>
  check(events, when).issues.filter((issue) => issue.code.startsWith('need_when_'));

/** 二候補とも答えは成立。期限の違う二つの架空のやり方は事前に手で定める。 */
function wayCase() {
  const family = Household.parse({
    ...household(),
    ways: ['A', 'B'].map((id) => ({
      id,
      name: `架空の手${id}`,
      steps: [{ id: 'one', name: '手順', durationMin: 5, segments: ['home'] }],
      cost: {},
    })),
  });
  const ways = family.ways;
  const about = JSON.stringify({ need: { ...item.interpretation, condition: 'true' }, ways });
  const events = [
    event(1, { type: 'householdSet', household: family }),
    event(2, { type: 'noticeReceived', source }),
    event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] }),
    event(4, { type: 'needCandidatesSet', itemId: 'item-1', candidates }),
    event(5, { type: 'needPeopleSet', itemId: 'item-1', people: [], required: [], minCount: 0 }),
    event(6, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['A', 'B'], about }),
  ];
  const one = {
    wayId: 'A',
    usable: true,
    decisionDeadline: '2026-12-11T10:00+09:00',
    deadlineCertainty: 'estimate',
    reasons: [] as string[],
  };
  const two = {
    wayId: 'B',
    usable: true,
    decisionDeadline: '2026-12-11T20:00+09:00',
    deadlineCertainty: 'estimate',
    reasons: [] as string[],
  };
  const state = (id: string, date: string, displayedWays: (typeof one)[], deadline: string) => ({
    id,
    rev: 1,
    date,
    start: `${date}T13:00+09:00`,
    end: `${date}T15:00+09:00`,
    yes: 0,
    possible: 0,
    requiredNo: [],
    requiredOpen: [],
    condition: 'meets',
    pivotal: [],
    ways: displayedWays,
    decisionDeadline: deadline,
    flags: [],
  });
  const when = {
    people: [],
    required: [],
    minCount: 0,
    answers: [],
    links: [],
    inUse: false,
    candidates: [
      state('c1', '2026-12-12', [one, two], two.decisionDeadline),
      state(
        'c2',
        '2026-12-19',
        [
          { ...one, decisionDeadline: '2026-12-11T19:00+09:00' },
          { ...two, decisionDeadline: '2026-12-11T19:00+09:00' },
        ],
        '2026-12-11T19:00+09:00',
      ),
    ],
  };
  const run = (shown: unknown) =>
    verifyPlan({
      household: family,
      events,
      plan: plan({
        throughSeq: 6,
        requirements: [
          requirement({
            kind: 'need',
            what: '架空の用件',
            basis: { itemIds: ['item-1'] },
            when: shown,
          }),
        ],
      }),
    }).issues.filter((i) => i.code.startsWith('need_when_'));
  return { family, events, when, run };
}

describe('候補と答えの独立な検証', () => {
  it('少人数の全割当を列挙した別 oracle と、成立と左右する人が合う', () => {
    let cases = 0;
    for (let n = 0; n <= 5; n += 1) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      for (let ternary = 0; ternary < 3 ** n; ternary += 1) {
        let digits = ternary;
        const values = new Map<string, 'yes' | 'no' | 'unknown'>();
        for (const id of ids) {
          values.set(
            id,
            (['no', 'yes', 'unknown'] as const)[digits % 3] as 'no' | 'yes' | 'unknown',
          );
          digits = Math.floor(digits / 3);
        }
        const unknown = ids.filter((id) => values.get(id) === 'unknown');
        for (let mask = 0; mask < 2 ** n; mask += 1) {
          const required = ids.filter((_, i) => (mask & (1 << i)) !== 0);
          for (let k = 0; k <= n + 1; k += 1) {
            const holds = (assignment: ReadonlyMap<string, boolean>) =>
              ids.filter((id) => values.get(id) === 'yes' || assignment.get(id) === true).length >=
                k &&
              required.every((id) => values.get(id) === 'yes' || assignment.get(id) === true);
            const complete: boolean[] = [];
            for (let a = 0; a < 2 ** unknown.length; a += 1) {
              complete.push(holds(new Map(unknown.map((id, i) => [id, (a & (1 << i)) !== 0]))));
            }
            const condition = complete.every(Boolean)
              ? 'meets'
              : complete.some(Boolean)
                ? 'open'
                : 'cannot';
            const pivotal = unknown.filter((target) => {
              const others = unknown.filter((id) => id !== target);
              for (let a = 0; a < 2 ** others.length; a += 1) {
                const assignment = new Map(others.map((id, i) => [id, (a & (1 << i)) !== 0]));
                assignment.set(target, true);
                const yes = holds(assignment);
                assignment.set(target, false);
                if (yes !== holds(assignment)) return true;
              }
              return false;
            });
            const actual = independentAvailability(ids, required, k, values);
            expect(actual.condition).toBe(condition);
            expect(actual.pivotal).toEqual(pivotal);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(50_000);
  });
  it('三人の二つの候補を手算どおりに照らす。リンクの所有と本人は同一視しない', () => {
    const result = issues();
    expect(result.filter((i) => i.kind === 'violation')).toEqual([]);
    expect(
      result.some((i) => i.kind === 'undetermined' && i.code === 'need_when_link_auth_unverified'),
    ).toBe(true);
  });
  it('はいの数と成立の誤りを見つける', () => {
    const when = initialWhen();
    must(when.candidates[0]).yes = 3;
    must(when.candidates[0]).condition = 'open';
    expect(issues(initialEvents(), when).map((i) => i.code)).toContain('need_when_count_mismatch');
  });
  it('左右する人を追加・削除した計画を見つける', () => {
    const when = initialWhen();
    must(when.candidates[1]).pivotal = ['helper'];
    expect(issues(initialEvents(), when).map((i) => i.code)).toContain('need_when_count_mismatch');
  });
  it('古い版の答えは今の候補に当てず、書込みが記録された事も指摘する', () => {
    const events = initialEvents();
    events.push(
      event(10, {
        type: 'availabilityRecorded',
        itemId: 'item-1',
        candidateId: 'c2',
        rev: 2,
        personId: 'a',
        source: 'self',
        answer: 'yes',
      }),
    );
    expect(issues(events).map((i) => i.code)).toContain('need_when_answer_invalid');
  });
  it('失効したリンクの記録を当てない', () => {
    const events = initialEvents();
    events.push(
      event(10, { type: 'answerLinkRevoked', itemId: 'item-1', personId: 'helper', linkId: 'l1' }),
    );
    events.push(
      event(11, {
        type: 'availabilityRecorded',
        itemId: 'item-1',
        candidateId: 'c2',
        rev: 1,
        personId: 'helper',
        source: 'link',
        answer: 'yes',
        actorId: 'link',
        linkId: 'l1',
      }),
    );
    const when = initialWhen();
    must(when.links[2]).active = false;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_answer_invalid');
  });
  it('リンクの撤回は同じ人の自分の画面の答えを消さない', () => {
    const events = initialEvents();
    events.push(
      event(10, {
        type: 'answerLinkIssued',
        itemId: 'item-1',
        personId: 'a',
        linkId: 'l2',
        tokenHash: 'b'.repeat(64),
      }),
    );
    events.push(
      event(11, {
        type: 'availabilityRecorded',
        itemId: 'item-1',
        candidateId: 'c1',
        rev: 1,
        personId: 'a',
        source: 'link',
        answer: 'no',
        actorId: 'link',
        linkId: 'l2',
      }),
    );
    events.push(
      event(12, {
        type: 'availabilityRecorded',
        itemId: 'item-1',
        candidateId: 'c1',
        rev: 1,
        personId: 'a',
        source: 'link',
        answer: 'withdrawn',
        actorId: 'link',
        linkId: 'l2',
      }),
    );
    const when = initialWhen();
    must(when.links[0]).active = true;
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    must(when.candidates[0]).yes = 1;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_count_mismatch');
  });
  it('有効なリンクを止まったと表示したり、止めたリンクを有効と表示したりしない', () => {
    const when = initialWhen();
    must(when.links[2]).active = false;
    expect(issues(initialEvents(), when).map((i) => i.code)).toContain('need_when_link_mismatch');
    const events = initialEvents();
    events.push(
      event(10, { type: 'answerLinkRevoked', itemId: 'item-1', personId: 'helper', linkId: 'l1' }),
    );
    must(when.links[2]).active = true;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_link_mismatch');
  });
  it('欠けた履歴から数字を確定せず、未判定にする', () => {
    const events = initialEvents().filter((e) => e.seq !== 8);
    const result = issues(events);
    expect(result.some((i) => i.kind === 'undetermined')).toBe(true);
    expect(result.some((i) => i.kind === 'violation')).toBe(false);
  });
  it('名簿がまだ無い候補は未判定で、成立したと決めつけない', () => {
    const events = initialEvents().slice(0, 4);
    const when = {
      ...initialWhen(),
      people: [],
      required: [],
      minCount: 0,
      answers: [],
      links: [],
      candidates: initialWhen().candidates.map((c) => ({
        ...c,
        yes: 0,
        possible: 0,
        requiredOpen: [],
        condition: 'open',
        pivotal: [],
      })),
    };
    expect(issues(events, when).some((i) => i.kind === 'undetermined')).toBe(true);
    expect(
      issues(events, { ...when, people: [{ id: 'a', kind: 'member' }] }).map((i) => i.code),
    ).toContain('need_when_no_roster_claim');
    const withClaimedChoice = {
      ...when,
      chosen: { candidateId: 'c1', rev: 1, stale: false, changes: [] },
    };
    expect(issues(events, withClaimedChoice).map((i) => i.code)).toContain(
      'need_when_choice_mismatch',
    );
    must(when.candidates[0]).yes = 1;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_no_roster_claim');
    must(when.candidates[0]).yes = 0;
    must(when.candidates[0]).condition = 'meets';
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_no_roster_claim');
  });
  it('記録された候補の表を計画が落としたら違反', () => {
    const events = initialEvents();
    const result = verifyPlan({
      household: household(),
      events,
      plan: plan({
        throughSeq: 9,
        requirements: [requirement({ kind: 'need', basis: { itemIds: ['item-1'] } })],
      }),
    });
    expect(result.issues.map((i) => i.code)).toContain('need_when_missing');
  });
  it('同じ人を二回数える名簿は受け付けない', () => {
    const events = initialEvents();
    events[4] = event(5, {
      type: 'needPeopleSet',
      itemId: 'item-1',
      people: [...people, people[0]],
      required: ['helper'],
      minCount: 2,
    });
    expect(issues(events).map((i) => i.code)).toContain('need_when_people_invalid');
  });
  it('外して戻した人の、外す前の返事とリンクを今に当てない', () => {
    const events = initialEvents();
    events.push(
      event(10, {
        type: 'needPeopleSet',
        itemId: 'item-1',
        people: people.slice(0, 2),
        required: [],
        minCount: 1,
      }),
    );
    events.push(
      event(11, { type: 'answerLinkRevoked', itemId: 'item-1', personId: 'helper', linkId: 'l1' }),
    );
    events.push(
      event(12, {
        type: 'needPeopleSet',
        itemId: 'item-1',
        people,
        required: ['helper'],
        minCount: 2,
      }),
    );
    const when = initialWhen();
    must(when.candidates[0]).yes = 1;
    must(when.candidates[0]).requiredOpen = ['helper'];
    must(when.candidates[0]).condition = 'open';
    must(when.candidates[0]).pivotal = ['helper'];
    when.answers = when.answers.filter((a) => a.personId !== 'helper');
    must(when.links[2]).active = false;
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    must(when.candidates[0]).yes = 2;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_count_mismatch');
  });
  it('決定後に条件の一言が変わったら、答えの確かめ待ちとする', () => {
    const events = initialEvents();
    const basis = JSON.stringify({
      people: ['a', 'b', 'helper'],
      required: ['helper'],
      minCount: 2,
      answers: [
        ['a', 'yes', [['self', 'yes', null]]],
        ['b', 'maybe', [['family', 'maybe', '仕事しだい']]],
        ['helper', 'yes', [['link', 'yes', null]]],
      ],
    });
    events.push(
      event(10, { type: 'candidateChosen', itemId: 'item-1', candidateId: 'c1', rev: 1, basis }),
    );
    events.push(
      event(11, {
        type: 'availabilityRecorded',
        itemId: 'item-1',
        candidateId: 'c1',
        rev: 1,
        personId: 'b',
        source: 'family',
        answer: 'maybe',
        note: '午後だけ',
      }),
    );
    const when = {
      ...initialWhen(),
      chosen: { candidateId: 'c1', rev: 1, stale: true, changes: ['answers'] },
    };
    const updatedSource = must(must(when.answers[1]).sources[0]);
    if (!('note' in updatedSource)) throw new Error('条件の一言が無い');
    updatedSource.note = '午後だけ';
    updatedSource.seq = 11;
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    when.chosen.stale = false;
    when.chosen.changes = [];
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_choice_mismatch');
  });
  it('同じ候補の時刻を代を進めず変えたら違反', () => {
    const events = initialEvents();
    events.push(
      event(10, {
        type: 'needCandidatesSet',
        itemId: 'item-1',
        candidates: [{ ...candidates[0], startTime: '14:00' }, candidates[1]],
      }),
    );
    expect(issues(events).map((i) => i.code)).toContain('need_when_candidates_invalid');
  });
  it('用件の内容を直したら候補すべての代を進め、古い答えを当てない', () => {
    const events = initialEvents();
    events.push(
      event(10, { type: 'itemCorrected', itemId: 'item-1', interpretation: { holdNeeded: true } }),
    );
    events.push(
      event(11, {
        type: 'needCandidatesSet',
        itemId: 'item-1',
        candidates: candidates.map((c) => ({ ...c, rev: 2 })),
      }),
    );
    const when = initialWhen();
    for (const candidate of when.candidates) {
      candidate.rev = 2;
      candidate.yes = 0;
      candidate.possible = 3;
      candidate.requiredNo = [];
      candidate.requiredOpen = ['helper'];
      candidate.condition = 'open';
      candidate.pivotal = ['a', 'b', 'helper'];
    }
    when.answers = [];
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    const invalid = [
      ...events.slice(0, -1),
      event(11, { type: 'needCandidatesSet', itemId: 'item-1', candidates }),
    ];
    expect(issues(invalid, when).map((i) => i.code)).toContain('need_when_candidates_invalid');
  });
  it('一度でも引き受けた後、別の候補に決め直せない', () => {
    const basis = JSON.stringify({
      people: ['a', 'b', 'helper'],
      required: ['helper'],
      minCount: 2,
      answers: [
        ['a', 'yes', [['self', 'yes', null]]],
        ['b', 'maybe', [['family', 'maybe', '仕事しだい']]],
        ['helper', 'yes', [['link', 'yes', null]]],
      ],
    });
    const events = initialEvents();
    events.push(
      event(10, { type: 'candidateChosen', itemId: 'item-1', candidateId: 'c1', rev: 1, basis }),
    );
    events.push(
      event(11, {
        type: 'commitmentChanged',
        taskKey: 'task-1',
        assigneeId: 'a',
        action: 'accept',
        basisItemIds: ['item-1'],
      }),
    );
    const when = {
      ...initialWhen(),
      inUse: true,
      chosen: { candidateId: 'c1', rev: 1, stale: false, changes: [] },
    };
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    events.push(
      event(12, {
        type: 'candidateChosen',
        itemId: 'item-1',
        candidateId: 'c2',
        rev: 1,
        basis: '{}',
      }),
    );
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_decision_in_use');
  });
  it('旧い窓の用件で引き受けた後、初めて候補を足す場合も違反として拾う', () => {
    const first = initialEvents().slice(0, 3);
    const choose = event(4, {
      type: 'optionChosen',
      arrangementKey: 'arr:need:item-1',
      optionKey: 'opt:arr:need:item-1:way-1',
      role: 'primary',
    });
    const accept = event(5, {
      type: 'commitmentChanged',
      taskKey: 'task:opt:arr:need:item-1:way-1:ask',
      assigneeId: 'a',
      action: 'accept',
    });
    const add = event(6, { type: 'needCandidatesSet', itemId: 'item-1', candidates });
    expect(issues([...first, choose, accept, add]).map((i) => i.code)).toContain(
      'need_when_decision_in_use',
    );
    expect(issues([...first, choose, { ...add, seq: 5 }]).map((i) => i.code)).not.toContain(
      'need_when_decision_in_use',
    );
  });
  it('選ぶ時に一緒に引き受けた記録は、basisItemIds が無くても手配と案からたどる', () => {
    const basis = JSON.stringify({
      people: ['a', 'b', 'helper'],
      required: ['helper'],
      minCount: 2,
      answers: [
        ['a', 'yes', [['self', 'yes', null]]],
        ['b', 'maybe', [['family', 'maybe', '仕事しだい']]],
        ['helper', 'yes', [['link', 'yes', null]]],
      ],
    });
    const events = initialEvents();
    events.push(
      event(10, { type: 'candidateChosen', itemId: 'item-1', candidateId: 'c1', rev: 1, basis }),
    );
    events.push(
      event(11, {
        type: 'optionChosen',
        arrangementKey: 'arr:need:item-1',
        optionKey: 'opt:arr:need:item-1:way-1',
        role: 'primary',
      }),
    );
    events.push(
      event(12, {
        type: 'commitmentChanged',
        taskKey: 'task:opt:arr:need:item-1:way-1:ask',
        assigneeId: 'a',
        action: 'accept',
      }),
    );
    const when = {
      ...initialWhen(),
      inUse: true,
      chosen: { candidateId: 'c1', rev: 1, stale: false, changes: [] },
    };
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    when.inUse = false;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_in_use_mismatch');
  });
  it('引受けの記録が無くても、済んだ作業があれば使った用件とする', () => {
    const basis = JSON.stringify({
      people: ['a', 'b', 'helper'],
      required: ['helper'],
      minCount: 2,
      answers: [
        ['a', 'yes', [['self', 'yes', null]]],
        ['b', 'maybe', [['family', 'maybe', '仕事しだい']]],
        ['helper', 'yes', [['link', 'yes', null]]],
      ],
    });
    const events = initialEvents();
    events.push(
      event(10, { type: 'candidateChosen', itemId: 'item-1', candidateId: 'c1', rev: 1, basis }),
    );
    events.push(
      event(11, {
        type: 'optionChosen',
        arrangementKey: 'arr:need:item-1',
        optionKey: 'opt:arr:need:item-1:way-1',
        role: 'primary',
      }),
    );
    events.push(
      event(12, {
        type: 'commitmentChanged',
        taskKey: 'task:opt:arr:need:item-1:way-1:ask',
        assigneeId: 'a',
        action: 'done',
      }),
    );
    const when = {
      ...initialWhen(),
      inUse: true,
      chosen: { candidateId: 'c1', rev: 1, stale: false, changes: [] },
    };
    expect(issues(events, when).filter((i) => i.kind === 'violation')).toEqual([]);
    when.inUse = false;
    expect(issues(events, when).map((i) => i.code)).toContain('need_when_in_use_mismatch');
  });
  it('使えるとされたやり方の置き方や最後の時刻は、表示だけから証明しない', () => {
    const { when, run } = wayCase();
    const result = run(when);
    expect(result.filter((i) => i.kind === 'violation')).toEqual([]);
    expect(
      result.some((i) => i.kind === 'undetermined' && i.code === 'need_when_way_unverified'),
    ).toBe(true);
  });
  it('二つのやり方の代償と期限を組み合わせた優位を、勧めとして認めない', () => {
    const { when, run } = wayCase();
    const result = run({
      ...when,
      recommended: { candidateId: 'c1', reason: 'dominates', meetsCount: 2, usableCount: 2 },
    });
    expect(
      result.some((i) => i.kind === 'violation' && i.code === 'need_when_recommendation_mismatch'),
    ).toBe(true);
  });
  it('候補が一つでも、使える手に代償不明があれば勧められない', () => {
    const { when, run } = wayCase();
    const first = must(when.candidates[0]);
    const second = must(when.candidates[1]);
    Object.assign(must(first.ways[1]), { costUnknown: true });
    for (const way of second.ways) {
      way.usable = false;
      way.reasons = ['unplaced'];
    }
    Object.assign(second, { decisionDeadline: undefined, flags: ['noUsableWay'] });
    const result = run({
      ...when,
      recommended: { candidateId: 'c1', reason: 'onlyUsable', meetsCount: 2, usableCount: 1 },
    });
    expect(
      result.some((i) => i.kind === 'violation' && i.code === 'need_when_recommendation_mismatch'),
    ).toBe(true);
  });
  it('行く場所の営業時間が分からない手を、使えるとしたら違反', () => {
    const { family, events, when } = wayCase();
    const next = Household.parse({
      ...family,
      places: [...family.places, { id: 'venue', kind: 'other', name: '架空の会場' }],
      ways: family.ways.map((way) =>
        way.id === 'A'
          ? { ...way, steps: way.steps.map((step) => ({ ...step, placeId: 'venue' })) }
          : way,
      ),
    });
    events[0] = event(1, { type: 'householdSet', household: next });
    events[5] = event(6, {
      type: 'needWaysSet',
      itemId: 'item-1',
      wayIds: ['A', 'B'],
      about: JSON.stringify({
        need: { ...item.interpretation, condition: 'true' },
        ways: next.ways,
      }),
    });
    const result = verifyPlan({
      household: next,
      events,
      plan: plan({
        throughSeq: 6,
        requirements: [requirement({ kind: 'need', basis: { itemIds: ['item-1'] }, when })],
      }),
    });
    expect(
      result.issues.some((i) => i.kind === 'violation' && i.code === 'need_when_usable_mismatch'),
    ).toBe(true);
  });
  it('時刻の無いやり方を使えると表示した勧めを認めない', () => {
    const { when, run } = wayCase();
    must(must(when.candidates[0]).ways[0]).decisionDeadline = undefined as unknown as string;
    const result = run(when);
    expect(
      result.some((i) => i.kind === 'violation' && i.code === 'need_when_usable_mismatch'),
    ).toBe(true);
  });
  it('まだやり方を選んでいないのに、選び待ちの印を落とさない', () => {
    const when = initialWhen();
    must(when.candidates[0]).flags = [];
    expect(issues(initialEvents(), when).map((i) => i.code)).toContain('need_when_flags_mismatch');
  });
  it('決めた候補の窓を事象から得て、計画の窓や不足印だけを正本にしない', () => {
    const fixture = wayCase();
    const neededItem = { ...item, interpretation: { ...item.interpretation, holdNeeded: true } };
    fixture.events[2] = event(3, {
      type: 'itemsStated',
      sourceId: 'source-1',
      items: [neededItem],
    });
    fixture.events[5] = event(6, {
      type: 'needWaysSet',
      itemId: 'item-1',
      wayIds: ['A', 'B'],
      about: JSON.stringify({
        need: { ...neededItem.interpretation, condition: 'true' },
        ways: fixture.family.ways,
      }),
    });
    const basis = JSON.stringify({ people: [], required: [], minCount: 0, answers: [] });
    fixture.events.push(
      event(7, { type: 'candidateChosen', itemId: 'item-1', candidateId: 'c1', rev: 1, basis }),
    );
    const when = {
      ...fixture.when,
      chosen: { candidateId: 'c1', rev: 1, stale: false, changes: [] },
    };
    const arrKey = 'arr:need:item-1';
    const makePlan = (start: string, gaps: { start: string; end: string }[] | undefined) =>
      plan({
        throughSeq: 7,
        requirements: [
          requirement({ kind: 'need', what: '架空の用件', basis: { itemIds: ['item-1'] }, when }),
        ],
        arrangements: [
          arrangement({
            key: arrKey,
            kind: 'need',
            needShape: 'window',
            start,
            end: '2026-12-12T15:00+09:00',
            options: [
              option(`opt:${arrKey}:A`, {
                arrangementKey: arrKey,
                templateId: 'A',
                ...(gaps ? { coverGaps: gaps } : {}),
              }),
            ],
          }),
        ],
      });
    const full = [{ start: '2026-12-12T13:00+09:00', end: '2026-12-12T15:00+09:00' }];
    const checkPlan = (start: string, gaps: typeof full | undefined) =>
      verifyPlan({ household: fixture.family, events: fixture.events, plan: makePlan(start, gaps) })
        .issues;
    const correct = checkPlan('2026-12-12T13:00+09:00', full);
    expect(correct.some((i) => i.code === 'need_window_unverified')).toBe(false);
    expect(correct.some((i) => i.code === 'need_potential_unverified')).toBe(false);
    expect(correct.some((i) => i.code === 'need_potential_gap_mismatch')).toBe(false);
    expect(checkPlan('2026-12-12T14:00+09:00', full).map((i) => i.code)).toContain(
      'need_when_window_mismatch',
    );
    expect(checkPlan('2026-12-12T13:00+09:00', undefined).map((i) => i.code)).toContain(
      'need_potential_gap_mismatch',
    );
  });
});
