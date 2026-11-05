// 窓の案の潜在的な不足を、事項・やり方・事象から独立に検査する。求解器は使わない。
import { DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { needContent } from '../src/history';
import { aboutMatches } from '../src/need-proof';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const DATE = '2026-12-07';
const START = `${DATE}T08:00+09:00`;
const END = `${DATE}T10:00+09:00`;
const gap = (start: string, end: string) => ({
  start: `${DATE}T${start}+09:00`,
  end: `${DATE}T${end}+09:00`,
});
const FULL = [gap('08:00', '10:00')];

interface Case {
  cover?: 'none' | 'family' | 'external' | 'both';
  holdNeeded?: boolean;
  covers?: { start: string; end: string };
  place?: string;
  gaps?: { start: string; end: string }[];
  recommended?: boolean;
  shape?: 'window' | 'by';
  missingChoice?: boolean;
  missingWay?: boolean;
  noItem?: boolean;
  planWindow?: { start: string; end: string };
  missingHistory?: boolean;
  fixedAssignee?: boolean;
  recordedAssignee?: boolean;
  workDuringWindow?: boolean;
  exceptionAvailable?: boolean;
  scheduled?: boolean;
  missingCoverTask?: boolean;
}

function materials(input: Case = {}) {
  const cover = input.cover ?? 'family';
  const steps = [
    {
      id: 'one',
      name: '手順',
      durationMin: 10,
      segments: ['home'],
      ...(input.fixedAssignee ? { assigneeId: 'a' } : {}),
      ...(cover === 'family' || cover === 'both' ? { cover: true } : {}),
      ...(cover === 'external' ? { cover: true, external: { to: 'helper', kind: 'reply' } } : {}),
    },
    ...(cover === 'both'
      ? [
          {
            id: 'two',
            name: '頼む',
            durationMin: 10,
            segments: ['home'],
            cover: true,
            external: { to: 'helper', kind: 'reply' },
          },
        ]
      : []),
  ];
  const family = Household.parse({
    ...household(),
    ...(input.workDuringWindow
      ? {
          routines: household().routines.map((day) =>
            day.memberId === 'a' && day.weekday === 1
              ? { ...day, segments: [{ start: '00:00', end: '23:59', kind: 'work' }] }
              : day,
          ),
        }
      : {}),
    ...(input.exceptionAvailable
      ? {
          routineExceptions: [
            {
              memberId: 'a',
              date: DATE,
              segments: [{ start: '08:00', end: '10:00', kind: 'home', placeId: 'home' }],
            },
          ],
        }
      : {}),
    ways: [
      {
        id: 'way',
        name: '架空の手',
        steps,
        ...(input.covers ? { covers: input.covers } : {}),
        cost: {},
      },
    ],
  });
  const way = family.ways[0];
  if (!way) throw new Error('やり方が無い');
  const shape = input.shape ?? 'window';
  const interpretation = {
    what: '架空の用件',
    shape,
    ...(shape === 'window'
      ? { date: DATE, startTime: '08:00', endTime: '10:00' }
      : { deadline: `${DATE}T10:00+09:00` }),
    ...(input.place === undefined ? {} : { place: input.place }),
    ...(input.holdNeeded === undefined ? {} : { holdNeeded: input.holdNeeded }),
  };
  const item = {
    id: 'item-1',
    sourceId: 'source-1',
    sentenceIds: ['sentence-1'],
    kind: 'need',
    written: '架空の用件',
    interpretation,
    evidence: 'stated',
    effects: [],
  };
  const about = JSON.stringify({ need: { ...interpretation, condition: 'true' }, ways: [way] });
  const fullEvents = [
    event(1, { type: 'householdSet', household: family }),
    event(2, {
      type: 'noticeReceived',
      source: {
        id: 'source-1',
        version: 1,
        receivedAt: '2026-11-30T10:00+09:00',
        sender: 'family',
        language: 'ja',
        sentences: [{ id: 'sentence-1', text: '架空の用件' }],
      },
    }),
    ...(input.noItem
      ? []
      : [event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] })]),
    ...(!input.missingChoice && !input.noItem
      ? [event(4, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way'], about })]
      : []),
    ...(input.recordedAssignee
      ? [event(5, { type: 'assignmentProposed', taskKey: 'task:option-1:one', assigneeId: 'a' })]
      : []),
  ];
  const events = input.missingHistory ? fullEvents.slice(1) : fullEvents;
  const current = plan({
    throughSeq: events.at(-1)?.seq ?? 0,
    requirements: [requirement({ kind: 'need', basis: { itemIds: ['item-1'] } })],
    tasks:
      (input.fixedAssignee || input.recordedAssignee) && !input.missingCoverTask
        ? [
            task('task:option-1:one', {
              basis: { itemIds: ['item-1'], arrangementKey: 'arrangement', optionKey: 'option-1' },
              step: { templateId: 'way', stepId: 'one' },
              cover: true,
              durationMin: 120,
              start: input.scheduled ? START : undefined,
              end: input.scheduled ? END : undefined,
            }),
          ]
        : [],
    arrangements: [
      arrangement({
        kind: 'need',
        needShape: shape,
        start: input.planWindow?.start ?? START,
        end: input.planWindow?.end ?? END,
        options: [
          option('option-1', {
            templateId: input.missingWay ? 'missing-way' : 'way',
            ...(input.gaps === undefined ? {} : { coverGaps: input.gaps }),
          }),
        ],
        ...(input.recommended ? { recommendedOptionKey: 'option-1' } : {}),
      }),
    ],
  });
  return { household: family, plan: current, events };
}

function issues(input: Case) {
  return verifyPlan(materials(input)).issues.filter((issue) =>
    issue.code.startsWith('need_potential_'),
  );
}

function codes(input: Case) {
  return issues(input).map((issue) => `${issue.kind}:${issue.code}`);
}

describe('窓の受け持ちの要否の独立検証', () => {
  it('省略した旧事象は今までどおり窓の受け持ちを要する', () => {
    expect(issues({ cover: 'none', gaps: FULL })).toEqual([]);
    expect(codes({ cover: 'none', recommended: true })).toContain(
      'violation:need_potential_gap_mismatch',
    );
  });
  it('受け持ち不要と明示された窓は、受け持ち手順が無くても不足としない', () => {
    expect(issues({ holdNeeded: false, cover: 'none', recommended: true })).toEqual([]);
  });
  it('受け持ち不要なのに不足印を出せば違反', () => {
    expect(codes({ holdNeeded: false, cover: 'none', gaps: FULL })).toContain(
      'violation:need_potential_gap_unexpected',
    );
  });
  it('受け持ち要と明示した窓は、従来どおり不足の印と推薦を検証する', () => {
    expect(issues({ holdNeeded: true, cover: 'none', gaps: FULL })).toEqual([]);
    expect(codes({ holdNeeded: true, cover: 'none', recommended: true })).toContain(
      'violation:need_potential_gap_recommended',
    );
  });
  it('履歴が途中からの時は、不要と言えず未判定', () => {
    const result = issues({ holdNeeded: false, cover: 'none', gaps: FULL, missingHistory: true });
    expect(result.some((issue) => issue.kind === 'undetermined')).toBe(true);
    expect(result.some((issue) => issue.kind === 'violation')).toBe(false);
  });
  it('旧い控えは一致し、受け持ちの要否が変われば別の中身として扱う', () => {
    const fixture = materials({ cover: 'none' });
    const records = fixture.events.map((e) => DomainEvent.parse(e));
    const stated = records.find((e) => e.type === 'itemsStated');
    const choice = records.find((e) => e.type === 'needWaysSet');
    if (stated?.type !== 'itemsStated' || choice?.type !== 'needWaysSet')
      throw new Error('記録が無い');
    const old = stated.items[0];
    const way = fixture.household.ways[0];
    if (!old || !way) throw new Error('用件かやり方が無い');
    const changed = { ...old, interpretation: { ...old.interpretation, holdNeeded: false } };
    expect(aboutMatches(choice.about, old, [way])).toBe(true);
    expect(aboutMatches(choice.about, changed, [way])).toBe(false);
    expect(needContent(changed, 'Asia/Tokyo')).not.toEqual(needContent(old, 'Asia/Tokyo'));
  });
});
