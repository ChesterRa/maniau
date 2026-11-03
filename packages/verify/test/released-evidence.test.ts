import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

// 架空の約束。現在の作業ではなく、本人が受けた時に見た控えを根拠にする。
const start = '2026-12-06T08:30+09:00';
const end = '2026-12-06T09:30+09:00';
const shown = {
  titleKey: 'task.escortTo',
  titleParams: { what: '練習', date: '2026-12-06', start: '09:00', place: '公園' },
  start,
  end,
  travelBeforeMin: 0,
  travelAfterMin: 0,
};
const events = () => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 'work', assigneeId: 'a' }),
  event(3, {
    type: 'commitmentChanged',
    taskKey: 'work',
    assigneeId: 'a',
    action: 'accept',
    shown,
    basisItemIds: [],
    basisSourceIds: ['source'],
  }),
];
const released = () => ({
  taskKey: 'work',
  assigneeId: 'a',
  content: { titleKey: shown.titleKey, titleParams: shown.titleParams },
  start,
  end,
  reason: 'unconfirmed',
});
const base = (overrides: Record<string, unknown> = {}) =>
  plan({
    now: '2026-12-06T08:00+09:00',
    throughSeq: 3,
    tasks: [],
    released: [released()],
    ...overrides,
  });
const check = (current = base(), history: unknown[] = events()) =>
  verifyPlan({ household: household(), plan: current, events: history });
const codes = (current = base(), history: unknown[] = events()) =>
  check(current, history)
    .issues.filter((issue) => issue.kind === 'violation')
    .map((issue) => issue.code);

describe('要らなくなった引き受けの根拠', () => {
  it('消えた作業と、効かなくなった作業を本人の控えで示す', () => {
    expect(codes()).toEqual([]);
    const inactive = task('work', {
      titleKey: shown.titleKey,
      titleParams: shown.titleParams,
      start,
      end,
      commitment: 'accepted',
      live: false,
    });
    expect(
      codes(base({ tasks: [inactive], released: [{ ...released(), reason: 'notLive' }] })),
    ).toEqual([]);
  });

  it('まだ有効な承諾の作業が消えたのに本人への札が無ければ報告する', () => {
    expect(codes(base({ released: [] }))).toContain('released_missing');
    const inactive = task('work', { commitment: 'accepted', live: false });
    expect(codes(base({ tasks: [inactive], released: [] }))).toContain('released_missing');
  });

  it('効かなくなった現在の作業が変わっても、本人が受けた用件と時刻を守る', () => {
    const changedTitleParams = { ...shown.titleParams, start: '10:00' };
    const inactive = task('work', {
      titleKey: shown.titleKey,
      titleParams: changedTitleParams,
      start: '2026-12-06T09:30+09:00',
      end: '2026-12-06T10:30+09:00',
      commitment: 'accepted',
      live: false,
    });
    const wrong = {
      ...released(),
      reason: 'notLive',
      content: { titleKey: shown.titleKey, titleParams: changedTitleParams },
      start: inactive.start,
      end: inactive.end,
    };
    expect(codes(base({ tasks: [inactive], released: [wrong] }))).toContain(
      'released_snapshot_mismatch',
    );
    expect(
      codes(base({ tasks: [inactive], released: [{ ...released(), reason: 'notLive' }] })),
    ).not.toContain('released_snapshot_mismatch');
  });

  it('担当が違う札と重複した札を拒む', () => {
    expect(codes(base({ released: [{ ...released(), assigneeId: 'b' }] }))).toContain(
      'released_assignee_mismatch',
    );
    expect(codes(base({ released: [released(), released()] }))).toContain('released_duplicate');
  });

  it('今も有効な作業と違う消失理由を拒む', () => {
    const active = task('work', { commitment: 'accepted', live: true });
    expect(codes(base({ tasks: [active] }))).toContain('released_task_still_live');
    expect(codes(base({ released: [{ ...released(), reason: 'notLive' }] }))).toContain(
      'released_reason_mismatch',
    );
  });

  it('再読で同じ ID が別の種類になっても、不要と断定しない', () => {
    const sentence = { id: 'source#1', text: '練習のお知らせ' };
    const source = {
      id: 'source',
      version: 1,
      receivedAt: '2026-11-30T10:00+09:00',
      sender: 'club',
      language: 'ja',
      sentences: [sentence],
    };
    const item = {
      id: 'i',
      sourceId: 'source',
      sentenceIds: ['source#1'],
      kind: 'event',
      written: sentence.text,
      interpretation: { what: '練習' },
      evidence: 'stated',
      effects: [],
    };
    const reading = (seq: number, sourceVersion: number, value: unknown) =>
      event(seq, {
        type: 'modelOutputRecorded',
        call: 'extract',
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        sourceId: 'source',
        sourceVersion,
        output: {
          sourceId: 'source',
          items: [value],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      });
    const history = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', source }),
      reading(3, 1, item),
      event(4, { type: 'assignmentProposed', taskKey: 'work', assigneeId: 'a' }),
      event(5, {
        type: 'commitmentChanged',
        taskKey: 'work',
        assigneeId: 'a',
        action: 'accept',
        shown,
        basisItemIds: ['i'],
        basisSourceIds: ['source'],
      }),
      event(6, {
        type: 'transcriptionCorrected',
        sourceId: 'source',
        sourceVersion: 2,
        sentences: [sentence],
      }),
      reading(7, 2, { ...item, kind: 'contact' }),
    ];
    const correct = base({ throughSeq: 7 });
    expect(codes(correct, history)).not.toContain('invalid_event');
    expect(codes(correct, history)).not.toContain('invalid_extraction');
    expect(codes(correct, history)).not.toContain('released_reason_mismatch');
    expect(
      codes(base({ throughSeq: 7, released: [{ ...released(), reason: 'gone' }] }), history),
    ).toContain('released_reason_mismatch');
    const dismissedNew = [
      ...history,
      event(8, { type: 'itemDismissed', itemId: 'i', reason: 'misread' }),
    ];
    expect(codes(base({ throughSeq: 8 }), dismissedNew)).not.toContain('released_reason_mismatch');
    expect(
      codes(base({ throughSeq: 8, released: [{ ...released(), reason: 'gone' }] }), dismissedNew),
    ).toContain('released_reason_mismatch');
    const dismissedOriginal = [
      ...history.slice(0, 5),
      event(6, { type: 'itemDismissed', itemId: 'i', reason: 'misread' }),
    ];
    expect(
      codes(
        base({ throughSeq: 6, released: [{ ...released(), reason: 'gone' }] }),
        dismissedOriginal,
      ),
    ).not.toContain('released_reason_mismatch');
    const rereadSame = [
      ...history.slice(0, 6),
      reading(7, 2, item),
      event(8, { type: 'itemDismissed', itemId: 'i', reason: 'misread' }),
    ];
    expect(codes(base({ throughSeq: 8 }), rereadSame)).not.toContain('released_reason_mismatch');
    expect(
      codes(base({ throughSeq: 8, released: [{ ...released(), reason: 'gone' }] }), rereadSame),
    ).toContain('released_reason_mismatch');
    const inactive = task('work', {
      titleKey: shown.titleKey,
      titleParams: shown.titleParams,
      start,
      end,
      commitment: 'accepted',
      live: false,
    });
    expect(codes(base({ throughSeq: 7, tasks: [inactive] }), history)).not.toContain(
      'released_reason_mismatch',
    );
    expect(
      codes(
        base({
          throughSeq: 7,
          tasks: [inactive],
          released: [{ ...released(), reason: 'notLive' }],
        }),
        history,
      ),
    ).toContain('released_reason_mismatch');

    // 引き受け後に届いても、古い版の読み取りは採用されない。
    const staleAfterAcceptance = [
      history[0],
      history[1],
      history[2],
      { ...history[5], seq: 4, id: 'event-4' },
      reading(5, 2, item),
      { ...history[3], seq: 6, id: 'event-6' },
      { ...history[4], seq: 7, id: 'event-7' },
      reading(8, 1, { ...item, kind: 'contact' }),
      event(9, { type: 'itemDismissed', itemId: 'i', reason: 'misread' }),
    ];
    expect(
      codes(
        base({ throughSeq: 9, released: [{ ...released(), reason: 'gone' }] }),
        staleAfterAcceptance,
      ),
    ).not.toContain('released_reason_mismatch');

    const lostReading = {
      ...reading(7, 2, item),
      output: {
        sourceId: 'source',
        items: [],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: ['source#1'],
        ambiguities: [],
      },
    };
    const withoutItem = [...history.slice(0, 6), lostReading];
    expect(codes(base({ throughSeq: 7 }), withoutItem)).not.toContain('released_reason_mismatch');
    expect(
      codes(base({ throughSeq: 7, released: [{ ...released(), reason: 'gone' }] }), withoutItem),
    ).toContain('released_reason_mismatch');
    const cancellation = { ...source, id: 'cancel', sentences: [{ id: 'cancel#1', text: '中止' }] };
    const withEffect = [
      ...withoutItem,
      event(8, { type: 'noticeReceived', source: cancellation }),
      event(9, {
        type: 'modelOutputRecorded',
        call: 'extract',
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        sourceId: 'cancel',
        sourceVersion: 1,
        output: {
          sourceId: 'cancel',
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
          items: [
            {
              ...item,
              id: 'c',
              sourceId: 'cancel',
              sentenceIds: ['cancel#1'],
              written: '中止',
              effects: [{ type: 'cancel', itemId: 'i' }],
            },
          ],
        },
      }),
    ];
    expect(codes(base({ throughSeq: 9 }), withEffect)).not.toContain('released_reason_mismatch');
    expect(
      codes(base({ throughSeq: 9, released: [{ ...released(), reason: 'gone' }] }), withEffect),
    ).toContain('released_reason_mismatch');
    const effectWithoutReread = [
      ...history.slice(0, 5),
      { ...withEffect[7], seq: 6, id: 'event-6' },
      { ...withEffect[8], seq: 7, id: 'event-7' },
    ];
    const effectResult = check(
      base({ throughSeq: 7, released: [{ ...released(), reason: 'gone' }] }),
      effectWithoutReread,
    );
    expect(effectResult.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'released_fate_unverified',
      }),
    );
    expect(
      codes(
        base({ throughSeq: 7, released: [{ ...released(), reason: 'gone' }] }),
        effectWithoutReread,
      ),
    ).not.toContain('released_reason_mismatch');
  });

  it('引き受けていないものを不要になった承諾として出さない', () => {
    const history = events().slice(0, 2);
    expect(codes(base({ throughSeq: 2 }), history)).toContain('released_without_acceptance');
    const done = [
      ...events(),
      event(4, { type: 'commitmentChanged', taskKey: 'work', assigneeId: 'a', action: 'done' }),
    ];
    expect(codes(base({ throughSeq: 4 }), done)).toContain('released_without_acceptance');
  });

  it('終了済みの時刻を持つ約束、確認して取り下げた約束の札は要らない', () => {
    const after = base({ now: '2026-12-06T09:31+09:00', released: [] });
    expect(codes(after)).not.toContain('released_missing');
    expect(codes(base({ now: end, released: [] }))).not.toContain('released_missing');
    const withdrawn = [
      ...events(),
      event(4, { type: 'commitmentChanged', taskKey: 'work', assigneeId: 'a', action: 'withdraw' }),
    ];
    expect(codes(base({ throughSeq: 4, released: [] }), withdrawn)).not.toContain(
      'released_missing',
    );
  });

  it('時刻のない承諾は本人の確認まで残す', () => {
    const { start: _start, end: _end, ...untimed } = shown;
    const history = events().map((entry) =>
      entry.seq === 3 ? { ...entry, shown: untimed } : entry,
    );
    const { start: _rStart, end: _rEnd, ...untimedRelease } = released();
    expect(codes(base({ released: [untimedRelease] }), history)).toEqual([]);
    expect(codes(base({ released: [] }), history)).toContain('released_missing');
  });

  it('古い控えや欠けた事象からは、間違いを断定しない', () => {
    const noShown = events().map((entry) =>
      entry.seq === 3 ? { ...entry, shown: undefined } : entry,
    );
    const result = check(
      base({ released: [{ taskKey: 'work', assigneeId: 'a', reason: 'unconfirmed' }] }),
      noShown,
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'released_snapshot_unverified' }),
    );
    expect(
      result.issues.some(
        (issue) => issue.kind === 'violation' && issue.code.startsWith('released_'),
      ),
    ).toBe(false);
    expect(codes(base(), noShown)).toContain('released_content_without_snapshot');
    const missing = [events()[0], events()[2]];
    expect(codes(base(), missing)).not.toContain('released_without_acceptance');
    const partial = base({
      released: [
        {
          ...released(),
          assigneeId: 'b',
          content: {
            titleKey: 'task.other',
            titleParams: {},
          },
        },
      ],
    });
    const partialResult = check(partial, missing);
    expect(partialResult.issues).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'released_acceptance_unverified',
      }),
    );
    expect(
      partialResult.issues.some(
        (issue) =>
          issue.kind === 'violation' &&
          ['released_assignee_mismatch', 'released_snapshot_mismatch'].includes(issue.code),
      ),
    ).toBe(false);
  });

  it('消した出典に頼る控えは出さず、出典が不明な旧い控えも安全側に扱う', () => {
    const purge = event(4, {
      type: 'sourceContentPurged',
      sourceId: 'source',
      scope: 'all',
      actorId: 'system',
    });
    const deleted = [...events(), purge];
    expect(codes(base({ throughSeq: 4 }), deleted)).toContain('released_purged_content');
    const correct = base({
      throughSeq: 4,
      released: [{ taskKey: 'work', assigneeId: 'a', reason: 'unconfirmed' }],
    });
    expect(codes(correct, deleted)).not.toContain('released_purged_content');
    const legacy = deleted.map((entry) =>
      entry.seq === 3 ? { ...entry, basisSourceIds: undefined } : entry,
    );
    expect(
      codes(base({ throughSeq: 4, released: [{ ...released(), reason: 'unconfirmed' }] }), legacy),
    ).toContain('released_purged_content');
    expect(codes(correct, legacy)).not.toContain('released_purged_content');
  });
});
