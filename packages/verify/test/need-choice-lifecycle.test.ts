// 家族がやり方を外した時と、内容が変わって選び直す時の依頼を区別する。
import { DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { collectFacts } from '../src/facts';
import { checkHistory, checkRequestNeed } from '../src/history';
import { Collector } from '../src/report';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const home = Household.parse({
  ...household(),
  ways: ['way-a', 'way-b'].map((id) => ({
    id,
    name: id,
    steps: [
      {
        id: 'ask',
        name: '頼む',
        durationMin: 5,
        segments: ['home'],
        external: { to: 'helper', kind: 'reply' },
        cover: true,
      },
    ],
    cost: {},
    cancellable: true,
  })),
});
const item = {
  id: 'item-1',
  sourceId: 'source-1',
  sentenceIds: ['sentence-1'],
  kind: 'need',
  written: '架空の用件',
  interpretation: { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' },
  evidence: 'stated',
  effects: [],
};
const key = (way: string) => `opt:arrangement:${way}`;
const snapshot = (ways: string[]) =>
  JSON.stringify({
    need: { ...item.interpretation, condition: 'true' },
    ways: ways.map((id) => home.ways.find((entry) => entry.id === id)),
  });

function check(args: {
  retained: string[];
  requestWay?: string;
  backup?: boolean;
  requestLive?: boolean;
  addCancellation?: boolean;
  stale?: boolean;
  corruptChoice?: boolean;
  maskOption?: boolean;
  expired?: boolean;
  corruptSnapshot?: boolean;
}) {
  const requestWay = args.requestWay ?? 'way-a';
  const basis = {
    itemIds: ['item-1'],
    requirementKey: 'requirement',
    arrangementKey: 'arrangement',
    optionKey: key(requestWay),
  };
  const raw = [
    event(1, { type: 'householdSet', household: home }),
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
    event(3, { type: 'itemsStated', sourceId: 'source-1', items: [item] }),
    event(4, {
      type: 'needWaysSet',
      itemId: 'item-1',
      wayIds: ['way-a', 'way-b'],
      about: snapshot(['way-a', 'way-b']),
    }),
    event(5, {
      type: 'optionChosen',
      arrangementKey: 'arrangement',
      optionKey: key('way-a'),
      role: 'primary',
    }),
  ];
  if (args.backup)
    raw.push(
      event(raw.length + 1, {
        type: 'optionChosen',
        arrangementKey: 'arrangement',
        optionKey: key('way-b'),
        role: 'backup',
      }),
    );
  raw.push(event(raw.length + 1, { type: 'assignmentProposed', taskKey: 'send', assigneeId: 'a' }));
  raw.push(
    event(raw.length + 1, {
      type: 'externalRequestSent',
      taskKey: 'send',
      requestId: 'request-1',
      snapshot: {
        to: 'helper',
        kind: 'reply',
        basis,
        about: args.corruptSnapshot ? '{}' : snapshot([requestWay]),
      },
    }),
  );
  raw.push(
    event(raw.length + 1, { type: 'externalReplyRecorded', requestId: 'request-1', reply: 'yes' }),
  );
  raw.push(
    event(raw.length + 1, {
      type: 'needWaysSet',
      itemId: 'item-1',
      wayIds: args.retained,
      about: args.corruptChoice ? '{}' : snapshot(args.retained),
    }),
  );
  if (args.stale)
    raw.push(
      event(raw.length + 1, {
        type: 'itemCorrected',
        itemId: 'item-1',
        interpretation: { what: '別の用件' },
      }),
    );
  const activeWays = args.stale ? [] : args.retained;
  const options = args.maskOption
    ? []
    : activeWays.map((id) => option(key(id), { templateId: id, expired: args.expired ?? false }));
  const proposed = plan({
    throughSeq: raw.length,
    requirements: [
      requirement({
        kind: 'need',
        what: args.stale ? '別の用件' : '架空の用件',
        basis: { itemIds: ['item-1'] },
      }),
    ],
    arrangements: [
      arrangement({
        kind: 'need',
        needShape: 'by',
        status: options.length ? 'decidable' : 'undetermined',
        options,
        ...(options.some((x) => x.key === key('way-a')) ? { chosenOptionKey: key('way-a') } : {}),
        backupOptionKeys:
          args.backup && options.some((x) => x.key === key('way-b')) ? [key('way-b')] : [],
      }),
    ],
    tasks: args.addCancellation ? [task('cancel', { cancels: 'request-1' })] : [],
    requests: [
      {
        requestId: 'request-1',
        taskKey: 'send',
        to: 'helper',
        kind: 'reply',
        sentAt: '2026-11-30T10:00+09:00',
        sentBy: 'a',
        state: 'confirmed',
        basis,
        live: args.requestLive ?? false,
        ...(args.stale ? { needsCheck: true } : {}),
      },
    ],
  });
  const events = raw.map((entry) => DomainEvent.parse(entry));
  const report = new Collector();
  const history = checkHistory(home, proposed, events, report);
  const facts = collectFacts(history.events, report);
  checkRequestNeed(proposed, history, facts, report, home.timeZone);
  return report.issues;
}
const violations = (issues: ReturnType<typeof check>) =>
  issues.filter((entry) => entry.kind === 'violation').map((entry) => entry.code);

describe('やり方の選びと外の依頼', () => {
  it.each([
    ['別のやり方へ', ['way-b']],
    ['全て外す', []],
  ] as const)('%s は外した本命への取消しが必要', (_label, retained) => {
    const good = check({ retained: [...retained], addCancellation: true });
    expect(violations(good)).not.toContain('option_selection_mismatch');
    expect(violations(good)).not.toContain('request_liveness_mismatch');
    expect(violations(good)).not.toContain('unexpected_cancellation');
    expect(violations(check({ retained: [...retained], requestLive: true }))).toContain(
      'request_liveness_mismatch',
    );
    expect(violations(check({ retained: [...retained] }))).toContain('cancellation_missing');
  });
  it('外した予備にも取消しが必要で、残した本命は消さない', () => {
    const result = check({
      retained: ['way-a'],
      backup: true,
      requestWay: 'way-b',
      addCancellation: true,
    });
    expect(violations(result)).not.toContain('option_selection_mismatch');
    expect(violations(result)).not.toContain('request_liveness_mismatch');
    expect(violations(result)).not.toContain('unexpected_cancellation');
    expect(
      violations(
        check({ retained: ['way-a'], backup: true, requestWay: 'way-b', requestLive: true }),
      ),
    ).toContain('request_liveness_mismatch');
  });
  it('選び続けたやり方の依頼は、勝手に取り消さない', () => {
    const result = check({ retained: ['way-a'], requestLive: true, addCancellation: true });
    expect(violations(result)).toContain('unexpected_cancellation');
  });
  it('選び続けた案は、期限が過ぎても選びから外したとは扱わない', () => {
    const result = check({ retained: ['way-a'], requestLive: true, expired: true });
    expect(violations(result)).not.toContain('request_liveness_mismatch');
    expect(violations(result)).not.toContain('cancellation_missing');
  });
  it('内容が変わって選び直し待ちなら、外したとは決めない', () => {
    const result = check({ retained: ['way-a'], stale: true, requestLive: true });
    expect(violations(result)).not.toContain('request_liveness_mismatch');
    expect(violations(result)).not.toContain('cancellation_missing');
    expect(violations(result)).not.toContain('option_selection_mismatch');
  });
  it('根拠の違う選択では、依頼の要否を決めつけない', () => {
    const result = check({
      retained: [],
      corruptChoice: true,
      requestLive: false,
      addCancellation: true,
    });
    expect(violations(result)).not.toContain('request_liveness_mismatch');
    expect(violations(result)).not.toContain('unexpected_cancellation');
    expect(
      result.some(
        (entry) => entry.kind === 'undetermined' && entry.code === 'option_selection_unknown',
      ),
    ).toBe(true);
  });
  it('外された案が送信時のやり方か確かめられない時も、取消しを決めつけない', () => {
    const result = check({
      retained: [],
      corruptSnapshot: true,
      requestLive: false,
      addCancellation: true,
    });
    expect(
      result.some(
        (entry) => entry.kind === 'undetermined' && entry.code === 'request_need_unverified',
      ),
    ).toBe(true);
    expect(violations(result)).not.toContain('unexpected_cancellation');
  });
  it('選んだやり方を案から隠して本命を消した計画は検出する', () => {
    const result = check({ retained: ['way-a'], maskOption: true, requestLive: true });
    expect(violations(result)).toContain('option_selection_mismatch');
  });
});
