// 見せる物：後から届いたお知らせで変わったことを、二人の大人に同じ物として添える。
import { DomainEvent } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../src/demo';
import { viewFor } from '../src/views';

const nowOf = (stage: DemoStageId) => {
  const found = DEMO_STAGES.find((s) => s.id === stage);
  if (!found) throw new Error(stage);
  return found.now;
};

describe('変わったこと', () => {
  it('延期のお知らせの後：要らなくなった預け先と、二人それぞれの取り消し、期限の変わったシャツ', () => {
    const events = demoEvents('postponed');
    for (const member of ['a', 'b']) {
      const view = viewFor(events, member, nowOf('postponed'));
      expect(view.changes?.sourceId, member).toBe('n2');
      expect(view.changes?.gone.map((g) => [g.before.kind, g.before.date])).toEqual([
        ['childCare', '2026-12-07'],
      ]);
      const undo = view.changes?.gone[0]?.undo.map((u) => [u.request.requestId, u.assigneeId]);
      expect(undo?.sort()).toEqual([
        ['r-gakudo', 'a'],
        ['r-grandma', 'b'],
      ]);
      expect(view.changes?.gone[0]?.undo.every((u) => !u.done)).toBe(true);
      // シャツは要るまま、期限だけ変わった（もう買ってある）。
      expect(view.changes?.moved.map((m) => [m.before.what, m.ready])).toEqual([
        ['白い長袖シャツ', true],
      ]);
    }
  });

  it('延期の前（最初のお知らせだけ）の段では出さない', () => {
    for (const stage of ['arrived', 'asked', 'chase', 'backup'] as const) {
      expect(viewFor(demoEvents(stage), 'b', nowOf(stage)).changes, stage).toBeUndefined();
    }
  });
});

describe('条件しだいの事項', () => {
  it('一つの未定の値で決まる条件を添える（同じ日の二つの事項が、どの値の時か分かる）', () => {
    const view = viewFor(demoEvents('chase'), 'b', nowOf('chase'));
    const when = (id: string) => view.items.find((l) => l.item.id === id)?.when;
    expect(when('n1:i6')).toEqual({ label: '学習発表会の実施日', value: '2026-12-05' });
    expect(when('n1:i7')).toEqual({ label: '学習発表会の実施日', value: '2026-12-08' });
  });

  // 別のお知らせ（n2）の事項が、初めのお知らせ（n1）の未定の値を条件に使う。
  const withSecondNotice = () => {
    const events = structuredClone(demoEvents('arrived'));
    const at = nowOf('arrived');
    const add = (actorId: string, body: object) => {
      const seq = events.length + 1;
      events.push(
        DomainEvent.parse({
          id: `t-${seq}`,
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
    add('b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n2',
        title: '集まりのお知らせ',
        sentences: [{ id: 'n2:s1', text: '発表会が12月5日のときは、7日に集まります。' }],
      },
    });
    add('system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: 'n2',
      model: 'test',
      promptVersion: 'test',
      inputHash: 'test',
      output: {
        sourceId: 'n2',
        unknowns: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        conditions: [{ id: 'n2:c1', kind: 'eq', unknownId: 'n1:u1', value: '2026-12-05' }],
        items: [
          {
            id: 'n2:i1',
            sourceId: 'n2',
            sentenceIds: ['n2:s1'],
            kind: 'event',
            written: '7日に集まります',
            interpretation: { what: '集まり', date: '2026-12-07' },
            conditionNodeId: 'n2:c1',
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    });
    const when = () =>
      viewFor(events, 'b', at).items.find((l) => l.item.id === 'n2:i1') ?? { when: 'missing' };
    return { add, when };
  };

  it('未定の値の名前は、今も確かな読み取りからだけ取る（直した文を読み直す前・取り下げた後は添えない）', () => {
    const plain = withSecondNotice();
    expect(plain.when()).toMatchObject({
      conditional: true,
      when: { label: '学習発表会の実施日', value: '2026-12-05' },
    });
    const corrected = withSecondNotice();
    corrected.add('b', {
      type: 'transcriptionCorrected',
      sourceId: 'n1',
      sourceVersion: 2,
      sentences: [{ id: 'n1#1', text: '音楽発表会の予定を確かめています。' }],
    });
    expect(corrected.when()).toMatchObject({ conditional: true });
    expect(corrected.when().when).toBeUndefined();
    const withdrawn = withSecondNotice();
    withdrawn.add('b', { type: 'sourceWithdrawn', sourceId: 'n1' });
    expect(withdrawn.when()).toMatchObject({ conditional: true });
    expect(withdrawn.when().when).toBeUndefined();
  });

  it('値が決まった後は、条件を添えない（もう条件しだいではない）', () => {
    const view = viewFor(demoEvents('postponed'), 'b', nowOf('postponed'));
    expect(view.items.filter((l) => l.when !== undefined)).toEqual([]);
  });
});
