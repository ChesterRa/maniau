// 家の人がする宿題（サイン）と、うちの番の当番の作業を、エンジンと別に書いた検証器にかける。担当の無い時、
// 書かれた時刻に置いた時、持った人が仕事で置けない時の、どれにも違反が無いことを確かめる。
import { DomainEvent } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { demoEvents, demoPlan } from '../src/demo';

describe('家の人がする宿題と当番を検証器にかける', () => {
  it('担当の無い時、時刻どおりに置いた時、仕事で置けない時に、違反が無い', () => {
    const base = demoEvents('arrived');
    const at = '2026-11-25T20:00+09:00';
    const events = [...base];
    const add = (actorId: string, body: object) => {
      const seq = events.length + 1;
      events.push(
        DomainEvent.parse({
          id: `f-${seq}`,
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
    const lines = [
      'あした、音読カードにサインをお願いします。',
      '12月13日(日)8:30〜10:00 お茶当番：陽菜さんのおうち',
      '12月9日(水)10:00〜11:00 読み聞かせ当番：陽菜さんのおうち',
    ];
    add('b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n3',
        title: '連絡帳',
        sentences: lines.map((text, i) => ({ id: `n3#${i + 1}`, text })),
      },
    });
    const item = (id: string, line: number, kind: string, interpretation: object) => ({
      id,
      sourceId: 'n3',
      sentenceIds: [`n3#${line}`],
      kind,
      written: lines[line - 1],
      interpretation,
      evidence: 'stated',
      effects: [],
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
          item('n3:h1', 1, 'homework', {
            what: '音読カードのサイン',
            date: '2026-11-26',
            relativeDay: 'tomorrow',
            familyAction: true,
          }),
          item('n3:d1', 2, 'duty', {
            what: 'お茶当番',
            date: '2026-12-13',
            writtenWeekday: 7,
            startTime: '08:30',
            endTime: '10:00',
            audience: '陽菜さんのおうち',
            familyAction: true,
          }),
          item('n3:d2', 3, 'duty', {
            what: '読み聞かせ当番',
            date: '2026-12-09',
            writtenWeekday: 3,
            startTime: '10:00',
            endTime: '11:00',
            audience: '陽菜さんのおうち',
            familyAction: true,
          }),
        ],
      },
    });
    const { household } = demoPlan('arrived');
    const now = '2026-11-25T20:05+09:00';
    const check = () => {
      const plan = computePlan(events, now);
      const report = verifyPlan({ household, plan, events });
      expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
      return plan;
    };
    const unowned = check();
    for (const key of ['task:submit:n3:h1', 'task:duty:n3:d1', 'task:duty:n3:d2']) {
      expect(unowned.tasks.find((t) => t.key === key)?.assigneeId).toBeUndefined();
    }
    add('b', { type: 'assignmentProposed', taskKey: 'task:submit:n3:h1', assigneeId: 'b' });
    add('b', { type: 'assignmentProposed', taskKey: 'task:duty:n3:d1', assigneeId: 'b' });
    add('a', { type: 'assignmentProposed', taskKey: 'task:duty:n3:d2', assigneeId: 'a' });
    const owned = check();
    expect(owned.tasks.find((t) => t.key === 'task:submit:n3:h1')?.start).toBeDefined();
    expect(owned.tasks.find((t) => t.key === 'task:duty:n3:d1')).toMatchObject({
      start: '2026-12-13T08:30+09:00',
      end: '2026-12-13T10:00+09:00',
    });
    // 水曜の 10 時は仕事の時間なので、書かれた時刻には置かない（ずらさない）。
    expect(owned.tasks.find((t) => t.key === 'task:duty:n3:d2')?.start).toBeUndefined();
  });
});
