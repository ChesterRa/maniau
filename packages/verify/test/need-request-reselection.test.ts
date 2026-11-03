// 選び直し中でも、送った時の依頼と現在の用件を事象から独立に照らす。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, plan, requirement } from './fixtures';

const home = Household.parse({
  ...household(),
  ways: [
    {
      id: 'way:1',
      name: '架空のやり方',
      steps: [
        {
          id: 'step',
          name: '頼む',
          durationMin: 5,
          segments: ['home'],
          external: { to: 'helper', kind: 'reply' },
          cover: true,
        },
      ],
      cost: {},
      cancellable: true,
    },
  ],
});
const arrangementKey = 'arrangement:with:colons';
const optionKey = `opt:${arrangementKey}:way:1`;
const basis = {
  itemIds: ['item-1'],
  requirementKey: 'requirement',
  arrangementKey,
  optionKey,
};
const interpretation = {
  what: '架空の用件',
  shape: 'window' as const,
  date: '2026-12-07',
  startTime: '08:00',
  endTime: '10:00',
};
const window = { start: '2026-12-07T08:00+09:00', end: '2026-12-07T10:00+09:00' };
const about = JSON.stringify({ need: { ...interpretation, condition: 'true' }, ways: home.ways });

function check(
  args: {
    needsCheck?: boolean;
    corruptBasis?: boolean;
    corruptAbout?: boolean;
    missingSnapshot?: boolean;
    missingEvent?: boolean;
    replacement?: boolean;
  } = {},
) {
  const source = {
    id: 'source-1',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'family',
    language: 'ja',
    sentences: [{ id: 'sentence-1', text: '架空の用件' }],
  };
  const original = {
    id: 'item-1',
    sourceId: 'source-1',
    sentenceIds: ['sentence-1'],
    kind: 'need',
    written: '架空の用件',
    interpretation,
    evidence: 'stated',
    effects: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: home }),
    event(2, { type: 'noticeReceived', source }),
    event(3, { type: 'itemsStated', sourceId: 'source-1', items: [original] }),
    event(4, { type: 'needWaysSet', itemId: 'item-1', wayIds: ['way:1'], about }),
    event(5, { type: 'optionChosen', arrangementKey, optionKey, role: 'primary' }),
    event(6, { type: 'assignmentProposed', taskKey: 'send', assigneeId: 'a' }),
    event(7, {
      type: 'externalRequestSent',
      taskKey: 'send',
      requestId: 'request-1',
      ...(args.missingSnapshot
        ? {}
        : {
            snapshot: {
              to: 'helper',
              kind: 'reply',
              basis,
              window,
              about: args.corruptAbout ? '{}' : about,
            },
          }),
    }),
    event(8, { type: 'externalReplyRecorded', requestId: 'request-1', reply: 'yes' }),
  ];
  let currentItem = 'item-1';
  if (args.replacement) {
    currentItem = 'item-2';
    events.push(
      event(9, {
        type: 'noticeReceived',
        source: {
          ...source,
          id: 'source-2',
          sender: 'school',
          sentences: [{ id: 'sentence-2', text: '新しい架空の用件' }],
        },
      }),
      event(10, {
        type: 'modelOutputRecorded',
        call: 'extract',
        sourceId: 'source-2',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'source-2',
          items: [
            {
              ...original,
              id: currentItem,
              sourceId: 'source-2',
              sentenceIds: ['sentence-2'],
              written: '新しい架空の用件',
              interpretation: { ...interpretation, what: '新しい架空の用件' },
              effects: [{ type: 'replace', itemId: 'item-1' }],
            },
          ],
          unknowns: [],
          conditions: [],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }),
      event(11, { type: 'itemConfirmed', itemId: currentItem }),
    );
  } else {
    // 同じ窓でも用件が変わる場合、窓の一致だけでは以前の返事を使えない。
    events.push(
      event(9, {
        type: 'itemCorrected',
        itemId: 'item-1',
        interpretation: { what: '新しい架空の用件' },
      }),
    );
  }
  const actualEvents = args.missingEvent ? events.filter((entry) => entry.seq !== 4) : events;
  return verifyPlan({
    household: home,
    events: actualEvents,
    plan: plan({
      throughSeq: events.at(-1)?.seq ?? 0,
      requirements: [
        requirement({
          kind: 'need',
          what: '新しい架空の用件',
          basis: { itemIds: [currentItem] },
        }),
      ],
      arrangements: [
        arrangement({
          key: arrangementKey,
          kind: 'need',
          needShape: 'window',
          start: window.start,
          end: window.end,
          status: 'undetermined',
          options: [],
          reasons: [{ code: 'inputMissing', refs: ['waysChanged'] }],
        }),
      ],
      requests: [
        {
          requestId: 'request-1',
          taskKey: 'send',
          to: 'helper',
          kind: 'reply',
          sentAt: '2026-11-30T10:00+09:00',
          sentBy: 'a',
          state: 'confirmed',
          basis: args.corruptBasis ? { ...basis, optionKey: 'not-the-sent-option' } : basis,
          live: true,
          window,
          ...(args.needsCheck ? { needsCheck: true } : {}),
        },
      ],
    }),
  });
}

const codes = (result: ReturnType<typeof verifyPlan>, kind: 'violation' | 'undetermined') =>
  result.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

describe('選び直しを待つ、送信済みの依頼', () => {
  it.each([false, true])('送信控えと今の事項を照らす（置き換え %s）', (replacement) => {
    const checked = check({ replacement, needsCheck: true });
    expect(codes(checked, 'violation')).not.toContain('basis_option_missing');
    expect(codes(checked, 'violation')).not.toContain('request_uncertainty_unmarked');
    const unmarked = check({ replacement });
    expect(codes(unmarked, 'violation')).toContain('request_uncertainty_unmarked');
  });

  it('送信控えと違う根拠は拒む', () => {
    const result = check({ corruptBasis: true, needsCheck: true });
    expect(codes(result, 'violation')).toContain('request_basis_mismatch');
    expect(codes(result, 'violation')).toContain('basis_option_missing');
  });

  it('送信控えや履歴が欠けたら現在の案と一致すると言わない', () => {
    for (const args of [
      { missingSnapshot: true },
      { missingEvent: true },
      { corruptAbout: true },
    ]) {
      const result = check({ ...args, needsCheck: true });
      expect(codes(result, 'undetermined')).toContain('basis_option_unverified');
      expect(codes(result, 'violation')).not.toContain('basis_option_missing');
    }
  });
});
