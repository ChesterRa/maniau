// 窓の案の潜在的な不足を、事項・やり方・事象から独立に検査する。求解器は使わない。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
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

describe('窓の案が潜在的に受け持てると示せない時間', () => {
  it('受け持つ手順が無ければ全窓が不足し、案を見せても勧めない', () => {
    expect(issues({ cover: 'none', gaps: FULL })).toEqual([]);
    expect(codes({ cover: 'none', gaps: FULL, recommended: true })).toContain(
      'violation:need_potential_gap_recommended',
    );
    expect(codes({ cover: 'none', recommended: true })).toEqual(
      expect.arrayContaining([
        'violation:need_potential_gap_mismatch',
        'violation:need_potential_gap_recommended',
      ]),
    );
  });

  it('窓全体を受け持つ可能性があれば、まだ受諾・返事が無くても不足とせず推薦を妨げない', () => {
    expect(issues({ cover: 'family', recommended: true })).toEqual([]);
    expect(issues({ cover: 'external', recommended: true })).toEqual([]);
    expect(codes({ cover: 'family', gaps: FULL })).toContain(
      'violation:need_potential_gap_mismatch',
    );
  });

  it('部分的な時間は窓との差を両側まで求め、不正な印と推薦を見つける', () => {
    const covers = { start: '08:30', end: '09:30' };
    const expected = [gap('08:00', '08:30'), gap('09:30', '10:00')];
    expect(issues({ covers, gaps: expected })).toEqual([]);
    expect(issues({ covers, gaps: [...expected].reverse() })).toEqual([]);
    // 書き方が違っても同じ瞬間なら同じ。時区の表記を文字列で比較しない。
    expect(
      issues({
        covers,
        gaps: [
          { start: '2026-12-06T23:00+00:00', end: '2026-12-06T23:30+00:00' },
          { start: '2026-12-07T00:30+00:00', end: '2026-12-07T01:00+00:00' },
        ],
      }),
    ).toEqual([]);
    expect(codes({ covers, gaps: [expected[0] as (typeof expected)[number]] })).toContain(
      'violation:need_potential_gap_mismatch',
    );
    expect(codes({ covers, gaps: expected, recommended: true })).toContain(
      'violation:need_potential_gap_recommended',
    );
    expect(issues({ covers: { start: '08:00', end: '10:00' }, recommended: true })).toEqual([]);
    expect(issues({ covers: { start: '07:00', end: '11:00' }, recommended: true })).toEqual([]);
    expect(issues({ covers: { start: '06:00', end: '07:00' }, gaps: FULL })).toEqual([]);
    expect(issues({ covers: { start: '10:00', end: '11:00' }, gaps: FULL })).toEqual([]);
    expect(
      issues({ covers: { start: '09:00', end: '11:00' }, gaps: [gap('08:00', '09:00')] }),
    ).toEqual([]);
    expect(
      issues({ covers: { start: '07:00', end: '09:00' }, gaps: [gap('09:00', '10:00')] }),
    ).toEqual([]);
    expect(
      codes({ covers, gaps: [...expected, expected[0] as (typeof expected)[number]] }),
    ).toContain('violation:need_potential_gap_mismatch');
  });

  it('必要な窓は計画の書き換えた時刻でなく、家族が記録した事項から求める', () => {
    const covers = { start: '08:30', end: '09:30' };
    const planWindow = { start: `${DATE}T09:00+09:00`, end: END };
    expect(
      issues({ covers, planWindow, gaps: [gap('08:00', '08:30'), gap('09:30', '10:00')] }),
    ).toEqual([]);
    expect(codes({ covers, planWindow, gaps: [gap('09:30', '10:00')] })).toContain(
      'violation:need_potential_gap_mismatch',
    );
  });

  it('明記された場所に家族がいると示せず、外の受け持ちと混ざっても全窓が不足する', () => {
    const place = '架空の会場';
    expect(issues({ place, cover: 'family', gaps: FULL })).toEqual([]);
    expect(issues({ place, cover: 'both', gaps: FULL })).toEqual([]);
    expect(codes({ place, cover: 'both', recommended: true })).toEqual(
      expect.arrayContaining([
        'violation:need_potential_gap_mismatch',
        'violation:need_potential_gap_recommended',
      ]),
    );
    expect(issues({ place, cover: 'external', recommended: true })).toEqual([]);
  });

  it('固定された人の日程が窓に合わなければ全窓を示し、偽の推薦や印の欠落を見つける', () => {
    const unavailable = { fixedAssignee: true, workDuringWindow: true };
    expect(issues({ ...unavailable, gaps: FULL })).toEqual([]);
    expect(codes({ ...unavailable, recommended: true })).toEqual(
      expect.arrayContaining([
        'violation:need_potential_gap_mismatch',
        'violation:need_potential_gap_recommended',
      ]),
    );
    // 計画が時刻を偽っても、元のふだんの予定を調べる。
    expect(codes({ ...unavailable, scheduled: true, recommended: true })).toContain(
      'violation:need_potential_gap_recommended',
    );
    // 受け持つ人が事象で決まった場合も、本人の日程を使う。
    expect(issues({ recordedAssignee: true, workDuringWindow: true, gaps: FULL })).toEqual([]);
    expect(codes({ recordedAssignee: true, workDuringWindow: true, recommended: true })).toContain(
      'violation:need_potential_gap_recommended',
    );
    // その日だけの予定があれば、ふだんの仕事より優先する。
    expect(
      issues({
        fixedAssignee: true,
        workDuringWindow: true,
        exceptionAvailable: true,
        scheduled: true,
      }),
    ).toEqual([]);
  });

  it('日程は合うのに作業を置けない訳や作業そのものを独立に確かめられなければ未判定', () => {
    expect(issues({ fixedAssignee: true, scheduled: true, recommended: true })).toEqual([]);
    expect(codes({ fixedAssignee: true, scheduled: true, gaps: FULL })).toContain(
      'violation:need_potential_gap_mismatch',
    );
    expect(codes({ fixedAssignee: true, gaps: FULL })).toContain(
      'undetermined:need_potential_placement_unverified',
    );
    expect(codes({ fixedAssignee: true, recommended: true })).toEqual(
      expect.arrayContaining([
        'violation:need_potential_gap_mismatch',
        'violation:need_potential_gap_recommended',
        'undetermined:need_potential_placement_unverified',
      ]),
    );
    expect(codes({ fixedAssignee: true, missingCoverTask: true, gaps: FULL })).toEqual([
      'undetermined:need_potential_placement_unverified',
    ]);
  });

  it('締切型には受け持ち窓を作らず、紛れ込んだ印だけは断る', () => {
    expect(issues({ shape: 'by', cover: 'none', recommended: true })).toEqual([]);
    expect(codes({ shape: 'by', gaps: FULL })).toContain('violation:need_potential_gap_unexpected');
  });

  it('事項・選び・やり方が欠けた時は、推薦や印を誤りと決めず未判定', () => {
    for (const missing of [{ noItem: true }, { missingChoice: true }, { missingWay: true }]) {
      expect(codes({ ...missing, cover: 'none', recommended: true })).toContain(
        'undetermined:need_potential_unverified',
      );
      expect(
        issues({ ...missing, cover: 'none', recommended: true }).some(
          (issue) => issue.kind === 'violation',
        ),
      ).toBe(false);
    }
    // 途中からの事象にある形が by でも、失われた変更が無かったとは決めない。
    expect(codes({ shape: 'by', gaps: FULL, missingHistory: true })).toContain(
      'undetermined:need_potential_unverified',
    );
    expect(
      issues({ shape: 'by', gaps: FULL, missingHistory: true }).some(
        (issue) => issue.kind === 'violation',
      ),
    ).toBe(false);
  });
});
