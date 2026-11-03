// デモの各段の計画を、エンジンと別に書いた検証器にかける（エンジンと検証器をつなぐ試験）。
// 検証器は道のりや要件の網羅を確かめられないので、全体は「未判定」になり得る。違反が無いことを確かめる。
import { DomainEvent } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, demoEvents, demoPlan } from '../src/demo';

describe('デモの計画を検証器にかける', () => {
  for (const stage of DEMO_STAGES) {
    it(`${stage.id}（${stage.now}）：違反が無い`, () => {
      const { household, plan } = demoPlan(stage.id);
      const report = verifyPlan({ household, plan, events: demoEvents(stage.id) });
      expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
      expect(report.status).not.toBe('violation');
    });
  }
});

describe('提出物を検証器にかける', () => {
  it('担当の無い時も、持った人の時間に置いた時も、違反が無い', () => {
    const base = demoEvents('arrived');
    const at = '2026-11-25T20:00+09:00';
    const events = [...base];
    const add = (actorId: string, body: object) => {
      const seq = events.length + 1;
      events.push(
        DomainEvent.parse({
          id: `s-${seq}`,
          householdId: base[0]?.householdId,
          seq,
          version: 1,
          occurredAt: at,
          recordedAt: at,
          actorId,
          ...body,
        }),
      );
    };
    const first = base.find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    add('b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n3',
        title: '個人面談',
        sentences: [
          { id: 'n3#1', text: '個人面談の出欠票を、11月27日(金)までに提出してください。' },
        ],
      },
    });
    add('system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: 'n3',
      model: 'test',
      promptVersion: 'test',
      inputHash: 'test',
      output: {
        sourceId: 'n3',
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        items: [
          {
            id: 'n3:i1',
            sourceId: 'n3',
            sentenceIds: ['n3#1'],
            kind: 'submission',
            written: '個人面談の出欠票を、11月27日(金)までに提出してください。',
            interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    });
    const { household } = demoPlan('arrived');
    const check = (now: string) => {
      const plan = computePlan(events, now);
      const task = plan.tasks.find((t) => t.key === 'task:submit:n3:i1');
      const report = verifyPlan({ household, plan, events });
      expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
      return task;
    };
    expect(check('2026-11-25T20:05+09:00')?.assigneeId).toBeUndefined();
    add('b', { type: 'assignmentProposed', taskKey: 'task:submit:n3:i1', assigneeId: 'b' });
    const placed = check('2026-11-25T20:05+09:00');
    expect(placed).toMatchObject({ assigneeId: 'b', commitment: 'proposed' });
    expect(placed?.start).toBeDefined();
  });

  it('済んだ作業は時間を取らない（今は要らなくなっていても、計画の時刻を残さない）。提出物を置き、違反は無い', () => {
    const events = [...demoEvents('asked')];
    const at = '2026-12-04T20:30+09:00';
    const add = (actorId: string, body: object) => {
      const seq = events.length + 1;
      events.push(
        DomainEvent.parse({
          id: `o-${seq}`,
          householdId: events[0]?.householdId,
          seq,
          version: 1,
          occurredAt: at,
          recordedAt: at,
          actorId,
          ...body,
        }),
      );
    };
    const first = events.find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    const written = '本日21時までに出欠票を提出してください。';
    add('b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n3',
        title: '出欠票',
        sentences: [{ id: 'n3#1', text: written }],
      },
    });
    add('system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: 'n3',
      model: 'test',
      promptVersion: 'test',
      inputHash: 'test',
      output: {
        sourceId: 'n3',
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        items: [
          {
            id: 'n3:i1',
            sourceId: 'n3',
            sentenceIds: ['n3#1'],
            kind: 'submission',
            written,
            interpretation: { what: '出欠票', deadline: '2026-12-04T21:00+09:00' },
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    });
    // 12/8 に決まると、12/7 の預け先は要らなくなる（祖母に頼んだ作業は済んだまま、今は要らない）。
    add('b', { type: 'answered', unknownId: 'n1:u1', value: '2026-12-08' });
    add('b', { type: 'assignmentProposed', taskKey: 'task:submit:n3:i1', assigneeId: 'b' });
    const plan = computePlan(events, at);
    const asked = plan.tasks.find((t) => t.key.includes('opt-grandma:ask'));
    expect(asked).toMatchObject({ assigneeId: 'b', commitment: 'done', live: false });
    // 済ませた時刻は記録に無いので、計画の時刻を済ませた時として残さない（時間を取らない）。
    expect(asked?.start).toBeUndefined();
    const submission = plan.tasks.find((t) => t.key === 'task:submit:n3:i1');
    expect(submission?.start).toBeDefined();
    expect(submission?.end).toBeDefined();
    const { household } = demoPlan('asked');
    const report = verifyPlan({ household, plan, events });
    expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
  });

  it('選んでいない比べるためだけの作業は、提出物を置ける最後の空きを塞がない', () => {
    const events = [...demoEvents('arrived')];
    const at = '2026-12-04T20:50+09:00';
    const add = (actorId: string, body: object, time = at) => {
      const seq = events.length + 1;
      events.push(
        DomainEvent.parse({
          id: `k-${seq}`,
          householdId: events[0]?.householdId,
          seq,
          version: 1,
          occurredAt: time,
          recordedAt: time,
          actorId,
          ...body,
        }),
      );
    };
    const first = events.find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    // 学童を本命に選び、その手順を一つ済ませる（祖母に頼む案は、比べるためだけの候補になる）。
    const arrangementKey = 'arr:childCare:n1:i6:c';
    const optionKey = `opt:${arrangementKey}:opt-gakudo`;
    const write = `task:${optionKey}:write`;
    const early = '2026-11-25T20:00+09:00';
    add('b', { type: 'optionChosen', arrangementKey, optionKey, role: 'primary' }, early);
    add('b', { type: 'assignmentProposed', taskKey: write, assigneeId: 'a' }, early);
    add(
      'a',
      { type: 'commitmentChanged', taskKey: write, assigneeId: 'a', action: 'done' },
      '2026-11-25T20:01+09:00',
    );
    const written = '本日21時までに出欠票を提出してください。';
    add('b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n3',
        title: '出欠票',
        sentences: [{ id: 'n3#1', text: written }],
      },
    });
    add('system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: 'n3',
      model: 'test',
      promptVersion: 'test',
      inputHash: 'test',
      output: {
        sourceId: 'n3',
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        items: [
          {
            id: 'n3:i1',
            sourceId: 'n3',
            sentenceIds: ['n3#1'],
            kind: 'submission',
            written,
            interpretation: { what: '出欠票', deadline: '2026-12-04T21:00+09:00' },
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    });
    add('b', { type: 'assignmentProposed', taskKey: 'task:submit:n3:i1', assigneeId: 'a' });
    const plan = computePlan(events, at);
    const candidate = plan.tasks.find((t) => t.key.includes('opt-grandma:ask'));
    expect(candidate).toMatchObject({ assigneeId: 'a', start: '2026-12-04T20:55+09:00' });
    const submission = plan.tasks.find((t) => t.key === 'task:submit:n3:i1');
    expect(submission).toMatchObject({
      start: '2026-12-04T20:50+09:00',
      end: '2026-12-04T21:00+09:00',
    });
    const { household } = demoPlan('arrived');
    const report = verifyPlan({ household, plan, events });
    // 重なりの違反が無いこと（この時刻まで進めた段の、買い物の手配の別の判定は、この試験の外）。
    expect(
      report.issues.filter((i) => i.kind === 'violation' && i.code === 'task_overlap'),
    ).toEqual([]);
  });
});
