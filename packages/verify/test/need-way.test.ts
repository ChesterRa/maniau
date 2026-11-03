// やり方と窓は、計画の値だけでなく家族の事象から独立に照らす。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const family = (
  cover = false,
  deadline?: { type: 'onTheDay'; at: string },
  wayDeadline?: { type: 'onTheDay'; at: string },
) =>
  Household.parse({
    ...household(),
    ways: [
      {
        id: 'way-1',
        name: '架空の方法',
        ...(wayDeadline ? { deadline: wayDeadline } : {}),
        steps: [
          {
            id: 'step-1',
            name: '手順',
            durationMin: 30,
            segments: ['home'],
            ...(cover ? { cover: true } : {}),
            ...(deadline ? { deadline } : {}),
          },
        ],
        cost: {},
        cancellable: true,
      },
    ],
  });

const events = (interpretation: Record<string, unknown>) => [
  event(1, { type: 'householdSet', household: family(interpretation.shape === 'window') }),
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
  event(3, {
    type: 'itemsStated',
    sourceId: 'source-1',
    items: [
      {
        id: 'item-1',
        sourceId: 'source-1',
        sentenceIds: ['sentence-1'],
        kind: 'need',
        written: '架空の用件',
        interpretation,
        evidence: 'stated',
        effects: [],
      },
    ],
  }),
];

const windowNeed = {
  what: '架空の用件',
  shape: 'window',
  date: '2026-12-07',
  startTime: '08:00',
  endTime: '10:00',
};

function check({
  interpretation = windowNeed,
  start = '2026-12-07T08:00+09:00',
  end = '2026-12-07T10:00+09:00',
  durationMin = 120,
  arrangementEnd,
  deadline,
  wayDeadline,
  markCover,
  about,
  declaredShape,
  requirementBy,
}: {
  interpretation?: Record<string, unknown>;
  start?: string;
  end?: string;
  durationMin?: number;
  arrangementEnd?: string;
  deadline?: { type: 'onTheDay'; at: string };
  wayDeadline?: { type: 'onTheDay'; at: string };
  markCover?: boolean;
  about?: string;
  declaredShape?: 'by' | 'window';
  requirementBy?: string;
} = {}) {
  const cover = interpretation.shape === 'window';
  const home = family(cover, deadline, wayDeadline);
  const history = events(interpretation);
  history[0] = event(1, { type: 'householdSet', household: home });
  const statedBy =
    interpretation.shape === 'by' && typeof interpretation.deadline === 'string'
      ? interpretation.deadlineDayOnly
        ? `${interpretation.deadline.slice(0, 10)}T23:59+09:00`
        : interpretation.deadline
      : undefined;
  const statedAbout = JSON.stringify({
    need: { ...interpretation, condition: 'true' },
    ways: home.ways,
  });
  history.push(
    event(4, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way-1'], about: statedAbout }),
  );
  return verifyPlan({
    household: home,
    events: history,
    plan: plan({
      throughSeq: 4,
      requirements: [
        requirement({
          kind: 'need',
          what: '架空の用件',
          ...(requirementBy || statedBy ? { by: requirementBy ?? statedBy } : {}),
          basis: { itemIds: ['item-1'] },
        }),
      ],
      arrangements: [
        arrangement({
          kind: 'need',
          needShape: declaredShape ?? interpretation.shape,
          start: '2026-12-07T08:00+09:00',
          end: arrangementEnd ?? statedBy ?? '2026-12-07T10:00+09:00',
          options: [option('option-1', { templateId: 'way-1', taskKeys: ['step-task'] })],
        }),
      ],
      tasks: [
        task('step-task', {
          durationMin,
          start,
          end,
          ...((markCover ?? cover) ? { cover: true } : {}),
          ...(about === 'missing' ? {} : { about: about ?? statedAbout }),
          step: { templateId: 'way-1', stepId: 'step-1' },
          basis: {
            itemIds: ['item-1'],
            requirementKey: 'requirement',
            arrangementKey: 'arrangement',
            optionKey: 'option-1',
          },
        }),
      ],
    }),
  });
}

const codes = (report: ReturnType<typeof verifyPlan>) =>
  report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);

describe('通用のすることとやり方', () => {
  it('受け持ちは雛形の長さではなく、家族が言った窓全体を使う', () => {
    const valid = codes(check());
    expect(valid).toEqual([]);
    expect(valid).not.toContain('option_template_missing');
    expect(valid).not.toContain('step_template_missing');
    expect(valid).not.toContain('step_constraints_mismatch');

    const partial = codes(check({ end: '2026-12-07T09:00+09:00', durationMin: 60 }));
    expect(partial).toContain('need_cover_window_mismatch');
  });

  it('予約や連絡の作業を、窓を受け持つ作業と取り違えない', () => {
    expect(codes(check({ markCover: false }))).toContain('need_cover_marker_mismatch');
    const interpretation = { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' };
    expect(
      codes(
        check({ interpretation, markCover: true, durationMin: 30, end: '2026-12-07T08:30+09:00' }),
      ),
    ).toContain('need_cover_marker_mismatch');
  });

  it('作業自体の用件とやり方の控えが現在の事実と違えば検出する', () => {
    expect(codes(check({ about: '{}' }))).toContain('need_task_about_mismatch');
    expect(check({ about: 'missing' }).issues.map((issue) => issue.code)).toContain(
      'need_task_about_unverified',
    );
  });

  it('期限型の手配は、家族が言った締切を変えない', () => {
    const interpretation = { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' };
    expect(
      codes(check({ interpretation, durationMin: 30, end: '2026-12-07T08:30+09:00' })),
    ).not.toContain('need_deadline_mismatch');
    expect(
      codes(
        check({
          interpretation,
          durationMin: 30,
          end: '2026-12-07T08:30+09:00',
          arrangementEnd: '2026-12-07T08:00+09:00',
        }),
      ),
    ).toContain('need_deadline_mismatch');
    expect(
      codes(
        check({
          interpretation,
          durationMin: 30,
          end: '2026-12-07T08:30+09:00',
          requirementBy: '2026-12-07T08:00+09:00',
        }),
      ),
    ).toContain('need_deadline_mismatch');
  });

  it('家族の窓と異なる手配を、窓全体の計画として通さない', () => {
    expect(codes(check({ arrangementEnd: '2026-12-07T09:30+09:00' }))).toContain(
      'need_window_mismatch',
    );
  });

  it('手配の形を、家族の事項と照らす', () => {
    expect(codes(check({ declaredShape: 'by' }))).toContain('need_shape_mismatch');
    expect(codes(check({ declaredShape: 'window' }))).not.toContain('need_shape_mismatch');
  });

  it('各手順の当日の締切を独立に確かめる', () => {
    const interpretation = { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' };
    const checkAt = (start: string, end: string) =>
      codes(
        check({
          interpretation,
          start,
          end,
          durationMin: 30,
          deadline: { type: 'onTheDay', at: '09:00' },
        }),
      );
    expect(checkAt('2026-12-07T08:30+09:00', '2026-12-07T09:00+09:00')).not.toContain(
      'step_deadline_missed',
    );
    expect(checkAt('2026-12-07T08:31+09:00', '2026-12-07T09:01+09:00')).toContain(
      'step_deadline_missed',
    );
  });

  it('やり方全体の締切は最初の手順の開始を照らす', () => {
    const interpretation = { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' };
    const checkAt = (start: string, end: string) =>
      codes(
        check({
          interpretation,
          start,
          end,
          durationMin: 30,
          wayDeadline: { type: 'onTheDay', at: '09:00' },
        }),
      );
    expect(checkAt('2026-12-07T08:50+09:00', '2026-12-07T09:20+09:00')).not.toContain(
      'template_deadline_missed',
    );
    expect(checkAt('2026-12-07T09:01+09:00', '2026-12-07T09:31+09:00')).toContain(
      'way_deadline_missed',
    );
  });

  it('日だけの締切を内部の朝の目安で早く終わらせない', () => {
    const interpretation = {
      what: '架空の用件',
      shape: 'by',
      deadline: '2026-12-07T08:00+09:00',
      deadlineDayOnly: true,
    };
    expect(
      codes(
        check({
          interpretation,
          durationMin: 30,
          start: '2026-12-07T08:00+09:00',
          end: '2026-12-07T08:30+09:00',
          requirementBy: '2026-12-07T08:00+09:00',
        }),
      ),
    ).toContain('need_day_deadline_mismatch');
    expect(
      codes(
        check({
          interpretation,
          durationMin: 30,
          start: '2026-12-07T08:00+09:00',
          end: '2026-12-07T08:30+09:00',
          requirementBy: '2026-12-07T23:59+09:00',
        }),
      ),
    ).not.toContain('need_day_deadline_mismatch');
  });
});
