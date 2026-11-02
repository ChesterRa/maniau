// 地基の見直し（docs/design/02-foundation.md §5.2・§5.6）で見つけた不具合の戻りの試験。
// 確かでない事項は要件も作用も起こさない。作用は条件の三つの値で効く。依頼は送った時の控えから作る。
import { describe, expect, it } from 'vitest';
import { basisCondition, computePlan, foldEvents, liveItems, requestSnapshot } from '../src/engine';
import type { RequestSnapshot } from '../src/schema/events';
import type { Extraction, Item } from '../src/schema/source';
import { todayCards } from '../src/view/today';
import { type EventLog, extraction1, extraction2, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const ASK = `task:${GRANDMA}:ask`;

/** 最初の読み取りを、この試験だけの写しに替えて返す（試験の材料は他の試験と共有しているため）。 */
function ownRead(log: EventLog): Extraction {
  const read = log.events.find((e) => e.type === 'modelOutputRecorded');
  if (read?.type !== 'modelOutputRecorded') throw new Error('読み取りが無い');
  const extraction = structuredClone(read.output as Extraction);
  read.output = extraction;
  return extraction;
}

/** 祖母に頼んで、送ったと記録した所まで（送った時の控えを付ける。edit で控えを変えられる）。 */
function grandmaAsked(edit: (s: RequestSnapshot) => RequestSnapshot = (s) => s): EventLog {
  const log = noticeArrived()
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ASK, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ASK,
      assigneeId: 'b',
      action: 'accept',
    });
  return log.add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
    taskKey: ASK,
    requestId: 'r-grandma',
    snapshot: edit(requestSnapshot(log.events, '2026-11-25T19:39+09:00', ASK)),
  });
}

/** 架空の三通目のお知らせ（n3）を、与えた読み取りで届ける。 */
function third(log: EventLog, at: string, read: Omit<Extraction, 'sourceId'>): EventLog {
  return log
    .add('noticeReceived', at, 'b', {
      source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
    })
    .add('modelOutputRecorded', at, 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: `fixture-n3-${at}`,
      sourceId: 'n3',
      output: { sourceId: 'n3', ...read },
    });
}

const n3Item = (over: Partial<Item> & Pick<Item, 'id'>): Item => ({
  sourceId: 'n3',
  sentenceIds: ['n3#1'],
  kind: 'event',
  written: '（架空）',
  interpretation: {},
  evidence: 'stated',
  effects: [],
  ...over,
});

/** n1 を読み直す（edit で、この試験だけの写しを変える）。 */
function rereadN1(log: EventLog, at: string, edit: (read: Extraction) => void): EventLog {
  const read = structuredClone(extraction1);
  edit(read);
  return log.add('modelOutputRecorded', at, 'system', {
    call: 'extract',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: `fixture-n1-reread-${at}`,
    sourceId: 'n1',
    output: read,
  });
}

const n4Item = (over: Partial<Item> & Pick<Item, 'id'>): Item =>
  n3Item({ sourceId: 'n4', sentenceIds: ['n4#1'], ...over });

/** 架空の四通目のお知らせ（n4）。条件の節点は n3 の物を使う。 */
function fourthNotice(log: EventLog, at: string, items: Item[]): EventLog {
  return log
    .add('noticeReceived', at, 'b', {
      source: { ...notice2, id: 'n4', sentences: [{ id: 'n4#1', text: '（架空）' }] },
    })
    .add('modelOutputRecorded', at, 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: `fixture-n4-${at}`,
      sourceId: 'n4',
      output: {
        sourceId: 'n4',
        unknowns: [],
        conditions: [],
        items,
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    });
}

const extra = {
  unknowns: [{ id: 'u-extra', label: '条件', values: ['yes', 'no'], kind: 'other' as const }],
  conditions: [{ id: 'c-extra', kind: 'eq' as const, unknownId: 'u-extra', value: 'yes' }],
  irrelevantSentenceIds: [],
  ambiguities: [],
};

/** 延期の連絡を、どの事項も「u-extra が yes の時だけ」の条件付きにして届ける。 */
function conditionalChange(log: EventLog): EventLog {
  ownRead(log).unknowns.push({
    id: 'u-extra',
    label: '条件',
    values: ['yes', 'no'],
    kind: 'other',
  });
  const second = structuredClone(extraction2);
  second.conditions.push({ id: 'c-extra', kind: 'eq', unknownId: 'u-extra', value: 'yes' });
  for (const item of second.items) item.conditionNodeId = 'c-extra';
  return log
    .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
    .add('modelOutputRecorded', '2026-12-04T17:53+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n2-conditional',
      sourceId: 'n2',
      output: second,
    });
}

describe('確かでない事項は、要件を作らない', () => {
  it('推定の持ち物からは、家族が確かめるまで買い物の要件も手配も作らない', () => {
    const log = noticeArrived();
    const shirt = ownRead(log).items.find((i) => i.id === 'i3');
    if (!shirt) throw new Error('シャツが無い');
    shirt.evidence = 'inferred';
    const plan = computePlan(log.events, '2026-11-25T19:31+09:00');
    expect(plan.requirements.some((r) => r.key === 'req:belongings:i3')).toBe(false);
    expect(plan.arrangements.some((a) => a.key === 'arr:purchase:i3')).toBe(false);
    // 画面は「確かめてください」として出せる。
    const item = liveItems(foldEvents(log.events)).find((i) => i.item.id === 'i3');
    expect(item).toMatchObject({ trusted: false, live: true });
  });
});

describe('作用は、確かな事項で条件が真の時だけ効く', () => {
  it('条件が偽の延期の連絡は、日付を決めず、前の事項を置き換えない', () => {
    const log = conditionalChange(noticeArrived());
    log.add('answered', '2026-12-04T18:00+09:00', 'a', { unknownId: 'u-extra', value: 'no' });
    const state = foldEvents(log.events);
    expect(state.resolved.has('u-date')).toBe(false);
    expect(state.effects.get('j3')).toBe('off');
    const plan = computePlan(log.events, '2026-12-04T18:01+09:00');
    const shirt = plan.requirements.find((r) => r.key === 'req:belongings:i3');
    expect(shirt?.basis.itemIds).toEqual(['i3']);
    expect(plan.arrangements.find((a) => a.key === CARE)?.live).toBe(true);
  });

  it('条件が分からない間は、前の事項を消さず「条件しだい」で残す。答えが来れば効く', () => {
    const log = conditionalChange(noticeArrived());
    const before = foldEvents(log.events);
    expect(before.resolved.has('u-date')).toBe(false);
    expect(before.effects.get('j3')).toBe('unknown');
    const items = liveItems(before);
    expect(items.find((i) => i.item.id === 'i3')).toMatchObject({
      conditional: true,
      rootId: 'i3',
    });
    // 分からない置き換えの後の事項は、系譜を継がない（前と後を別の物として残す）。
    expect(items.find((i) => i.item.id === 'j3')).toMatchObject({
      conditional: true,
      rootId: 'j3',
    });

    log.add('answered', '2026-12-04T18:00+09:00', 'a', { unknownId: 'u-extra', value: 'yes' });
    const after = foldEvents(log.events);
    expect(after.resolved.get('u-date')?.value).toBe('2026-12-08');
    const shirt = liveItems(after).filter((i) => i.item.kind === 'belongings');
    expect(shirt.map((i) => [i.item.id, i.rootId])).toEqual([['j3', 'i3']]);
  });

  it('食い違いの事項の作用は効かない', () => {
    const log = noticeArrived();
    const second = structuredClone(extraction2);
    for (const item of second.items) item.evidence = 'conflicting';
    log
      .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
      .add('modelOutputRecorded', '2026-12-04T17:53+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n2-conflicting',
        sourceId: 'n2',
        output: second,
      });
    const state = foldEvents(log.events);
    expect(state.resolved.has('u-date')).toBe(false);
    expect(liveItems(state).some((i) => i.item.id === 'i6')).toBe(true);
  });

  it('作用と条件が互いを頼って回り続ける時は、未判定にして止める', () => {
    const log = noticeArrived().add('answered', '2026-11-26T08:00+09:00', 'a', {
      unknownId: 'u-x',
      value: 'no',
    });
    const loop: Extraction = {
      sourceId: 'n3',
      unknowns: [{ id: 'u-x', label: '回る値', values: ['yes', 'no'], kind: 'other' }],
      conditions: [
        { id: 'c-x', kind: 'eq', unknownId: 'u-x', value: 'yes' },
        { id: 'c-not-x', kind: 'not', childId: 'c-x' },
      ],
      items: [
        {
          id: 'k1',
          sourceId: 'n3',
          sentenceIds: ['n3#1'],
          kind: 'event',
          written: '（架空）',
          interpretation: {},
          conditionNodeId: 'c-not-x',
          evidence: 'stated',
          effects: [{ type: 'resolveUnknown', unknownId: 'u-x', value: 'yes' }],
        },
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    log
      .add('noticeReceived', '2026-11-26T09:00+09:00', 'b', {
        source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
      })
      .add('modelOutputRecorded', '2026-11-26T09:00+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n3-loop',
        sourceId: 'n3',
        output: loop,
      });
    const state = foldEvents(log.events);
    expect(state.effects.get('k1')).toBe('unknown');
    // 後の、効くか分からない作用が別の値を言うので、家族の答えも確かとは言えない。
    expect(state.resolved.has('u-x')).toBe(false);
    expect(state.doubted.has('u-x')).toBe(true);
  });
  it('効いていた作用の事項が、後ではっきり取り消されたら、その作用で決まった値も外れる', () => {
    // n3 の k1「A が yes なら B は yes」。家族が A に yes と答えた後、n4 が k1 に作用する。
    const answeredA = () => {
      const log = noticeArrived();
      third(log, '2026-11-26T09:00+09:00', {
        unknowns: [
          { id: 'u-a', label: 'A', values: ['yes', 'no'], kind: 'other' },
          { id: 'u-b', label: 'B', values: ['yes', 'no'], kind: 'other' },
          ...extra.unknowns,
        ],
        conditions: [
          { id: 'c-a-yes', kind: 'eq', unknownId: 'u-a', value: 'yes' },
          ...extra.conditions,
        ],
        items: [
          n3Item({
            id: 'k1',
            conditionNodeId: 'c-a-yes',
            effects: [{ type: 'resolveUnknown', unknownId: 'u-b', value: 'yes' }],
          }),
        ],
        irrelevantSentenceIds: [],
        ambiguities: [],
      });
      return log.add('answered', '2026-11-26T10:00+09:00', 'a', { unknownId: 'u-a', value: 'yes' });
    };
    const before = foldEvents(answeredA().events);
    expect(before.effects.get('k1')).toBe('on');
    expect(before.resolved.get('u-b')?.value).toBe('yes');

    const fourth = (effect: Item['effects'][number], conditionNodeId?: string) =>
      fourthNotice(answeredA(), '2026-11-27T09:00+09:00', [
        n4Item({ id: 'm1', effects: [effect], ...(conditionNodeId ? { conditionNodeId } : {}) }),
      ]);

    const cancelled = foldEvents(fourth({ type: 'cancel', itemId: 'k1' }).events);
    expect(cancelled.effects.get('k1')).toBe('off');
    expect(cancelled.resolved.has('u-b')).toBe(false);

    // 取り消すか分からない（条件の分からない取り消し）なら、その作用で決まった値も確かでない。
    const unsure = foldEvents(fourth({ type: 'cancel', itemId: 'k1' }, 'c-extra').events);
    expect(unsure.effects.get('k1')).toBe('unknown');
    expect(unsure.resolved.has('u-b')).toBe(false);

    // 置き換えでも同じ：置き換えられた事項の作用は、もう効かない（後の事項に作用が無ければ、値は決まらない）。
    const replaced = foldEvents(fourth({ type: 'replace', itemId: 'k1' }).events);
    expect(replaced.effects.get('k1')).toBe('off');
    expect(replaced.resolved.has('u-b')).toBe(false);
  });

  it('取り消しの事項が取り消されたら、元の事項は戻る', () => {
    const log = grandmaAsked();
    third(log, '2026-11-27T17:00+09:00', {
      unknowns: [],
      conditions: [],
      items: [n3Item({ id: 'k1', kind: 'dayChange', effects: [{ type: 'cancel', itemId: 'i4' }] })],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    expect(computePlan(log.events, '2026-11-27T17:01+09:00').requests[0]?.live).toBe(false);
    fourthNotice(log, '2026-11-28T09:00+09:00', [
      n4Item({ id: 'm1', effects: [{ type: 'cancel', itemId: 'k1' }] }),
    ]);
    expect(foldEvents(log.events).effects.get('k1')).toBe('off');
    const plan = computePlan(log.events, '2026-11-28T09:01+09:00');
    expect(plan.arrangements.some((a) => a.key === CARE)).toBe(true);
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(true);
  });
  it('同じお知らせの中で、確かな作用が同じ未定の値に違う値を言えば、並びの順によらず決めない', () => {
    const resolve = (reverse: boolean) => {
      const items = ['2026-12-05', '2026-12-08'].map((value, index) =>
        n3Item({
          id: `k${index + 1}`,
          effects: [{ type: 'resolveUnknown', unknownId: 'u-date', value }],
        }),
      );
      if (reverse) items.reverse();
      const log = third(noticeArrived(), '2026-11-27T17:00+09:00', {
        unknowns: [],
        conditions: [],
        items,
        irrelevantSentenceIds: [],
        ambiguities: [],
      });
      return foldEvents(log.events);
    };
    for (const state of [resolve(false), resolve(true)]) {
      expect(state.resolved.has('u-date')).toBe(false);
      expect(state.doubted.has('u-date')).toBe(true);
    }
    // 同じ値を二度言うだけなら、食い違いではない。
    const same = third(noticeArrived(), '2026-11-27T17:00+09:00', {
      unknowns: [],
      conditions: [],
      items: ['k1', 'k2'].map((id) =>
        n3Item({
          id,
          effects: [{ type: 'resolveUnknown', unknownId: 'u-date', value: '2026-12-08' }],
        }),
      ),
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    expect(foldEvents(same.events).resolved.get('u-date')?.value).toBe('2026-12-08');
  });
  it('別々のお知らせが同じ事項を置き換え、読み取りの終わる順が逆でも、読み終わりの順で系譜を決めない', () => {
    const read = (sourceId: string, id: string, what: string): Extraction => ({
      sourceId,
      unknowns: [],
      conditions: [],
      items: [
        n3Item({
          id,
          sourceId,
          sentenceIds: [`${sourceId}#1`],
          kind: 'belongings',
          interpretation: { what },
          effects: [{ type: 'replace', itemId: 'i3' }],
        }),
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    const source = (id: string) => ({
      ...notice2,
      id,
      sentences: [{ id: `${id}#1`, text: '（架空）' }],
    });
    const output = (extraction: Extraction) =>
      ({
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: `fixture-${extraction.sourceId}`,
        sourceId: extraction.sourceId,
        output: extraction,
      }) as const;
    const log = noticeArrived()
      .add('noticeReceived', '2026-11-27T17:00+09:00', 'b', { source: source('n3') })
      .add('noticeReceived', '2026-11-27T17:05+09:00', 'b', { source: source('n4') })
      // 後のお知らせ（n4）の読み取りが先に終わる。
      .add(
        'modelOutputRecorded',
        '2026-11-27T17:06+09:00',
        'system',
        output(read('n4', 'm1', '青い長袖シャツ')),
      )
      .add(
        'modelOutputRecorded',
        '2026-11-27T17:07+09:00',
        'system',
        output(read('n3', 'k1', '赤い長袖シャツ')),
      );
    const items = liveItems(foldEvents(log.events));
    for (const [id, root] of [
      ['i3', 'i3'],
      ['k1', 'k1'],
      ['m1', 'm1'],
    ]) {
      expect(items.find((i) => i.item.id === id)).toMatchObject({
        conditional: true,
        rootId: root,
      });
    }
  });

  it('一つの事項を、確かな置き換えが二つ言う時は、並びの順によらず、どちらにも系譜を継がせない', () => {
    const replaced = (reverse: boolean) => {
      const items = ['青', '赤'].map((color, index) =>
        n3Item({
          id: `k${index + 1}`,
          kind: 'belongings',
          interpretation: { what: `${color}い長袖シャツ` },
          effects: [{ type: 'replace', itemId: 'i3' }],
        }),
      );
      if (reverse) items.reverse();
      const log = third(noticeArrived(), '2026-11-27T17:00+09:00', {
        unknowns: [],
        conditions: [],
        items,
        irrelevantSentenceIds: [],
        ambiguities: [],
      });
      return liveItems(foldEvents(log.events));
    };
    for (const items of [replaced(false), replaced(true)]) {
      // 前の事項も、言い合う後の二つも、確かな必需品としては出さない（条件しだい）。
      expect(items.find((i) => i.item.id === 'i3')).toMatchObject({
        doubted: true,
        conditional: true,
        rootId: 'i3',
      });
      for (const id of ['k1', 'k2']) {
        expect(items.find((i) => i.item.id === id)).toMatchObject({
          doubted: true,
          conditional: true,
          rootId: id,
        });
      }
    }
  });
});

describe('依頼は、送った時の控えから作る', () => {
  it('読み直しで根拠の事項が見つからなくなっても、依頼は残し、要るかを確かめる（取り消しは作らない）', () => {
    const log = grandmaAsked();
    const reread = structuredClone(extraction1);
    reread.items = reread.items.filter((i) => i.id !== 'i4');
    reread.irrelevantSentenceIds.push('n1#9');
    log.add('modelOutputRecorded', '2026-11-25T19:42+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n1-reread',
      sourceId: 'n1',
      output: reread,
    });
    const plan = computePlan(log.events, '2026-11-25T19:43+09:00');
    expect(plan.requests).toEqual([
      expect.objectContaining({ requestId: 'r-grandma', to: 'g', live: true, needsCheck: true }),
    ]);
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(false);
  });

  it('根拠の事項がはっきり取り消されたら、作業が消えても控えから取り消しの連絡を作る', () => {
    const log = grandmaAsked();
    const cancel: Extraction = {
      sourceId: 'n3',
      unknowns: [],
      conditions: [],
      items: [
        {
          id: 'k1',
          sourceId: 'n3',
          sentenceIds: ['n3#1'],
          kind: 'dayChange',
          written: '（架空）12月7日の振替休業日は取りやめます。',
          interpretation: { date: '2026-12-07' },
          evidence: 'stated',
          effects: [{ type: 'cancel', itemId: 'i4' }],
        },
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    log
      .add('noticeReceived', '2026-11-27T17:00+09:00', 'b', {
        source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
      })
      .add('modelOutputRecorded', '2026-11-27T17:00+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n3-cancel',
        sourceId: 'n3',
        output: cancel,
      });
    const plan = computePlan(log.events, '2026-11-27T17:01+09:00');
    expect(plan.arrangements.some((a) => a.key === CARE)).toBe(false);
    const request = plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(request).toMatchObject({ live: false, to: 'g' });
    expect(request?.needsCheck).toBeUndefined();
    expect(plan.tasks).toContainEqual(
      expect.objectContaining({ cancels: 'r-grandma', assigneeId: 'b', live: true }),
    );
  });
});

describe('条件しだいは、計画の出力まで伝わる', () => {
  it('お知らせが届いた夜の 12/7 の手配は、5日に行うかが分からないので条件しだい', () => {
    const plan = computePlan(noticeArrived().events, '2026-11-25T19:31+09:00');
    expect(plan.arrangements.find((a) => a.key === CARE)).toMatchObject({
      conditional: true,
      status: 'decidable',
    });
    expect(plan.requirements.find((r) => r.key === 'req:childCare:i4:c')?.conditional).toBe(true);
    // 白い長袖シャツは条件が無いので、確かな要件のまま。
    expect(
      plan.requirements.find((r) => r.key === 'req:belongings:i3')?.conditional,
    ).toBeUndefined();
  });

  it('家族の答えの後に、条件の分からない変更が来たら、その答えは確かでない', () => {
    const log = noticeArrived().add('answered', '2026-11-26T08:00+09:00', 'a', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    third(log, '2026-11-27T17:00+09:00', {
      ...extra,
      items: [
        n3Item({
          id: 'k1',
          conditionNodeId: 'c-extra',
          effects: [{ type: 'resolveUnknown', unknownId: 'u-date', value: '2026-12-08' }],
        }),
      ],
    });
    const state = foldEvents(log.events);
    expect(state.effects.get('k1')).toBe('unknown');
    expect(state.doubted.has('u-date')).toBe(true);
    expect(state.resolved.has('u-date')).toBe(false);
    const plan = computePlan(log.events, '2026-11-27T17:01+09:00');
    expect(plan.arrangements.find((a) => a.key === CARE)?.conditional).toBe(true);

    // 変更の後に家族がもう一度答えれば、その答えが確か（事象の順に従う）。
    log.add('answered', '2026-11-27T18:00+09:00', 'a', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    const after = foldEvents(log.events);
    expect(after.doubted.has('u-date')).toBe(false);
    expect(after.resolved.get('u-date')?.value).toBe('2026-12-05');
  });

  it('回り続ける作用は、前提ごと未判定に戻す（前提の崩れた作用を効かせない）', () => {
    const log = noticeArrived().add('answered', '2026-11-26T08:00+09:00', 'a', {
      unknownId: 'u-a',
      value: 'no',
    });
    third(log, '2026-11-27T17:00+09:00', {
      unknowns: [
        { id: 'u-a', label: 'A', values: ['yes', 'no'], kind: 'other' },
        { id: 'u-b', label: 'B', values: ['yes', 'no'], kind: 'other' },
      ],
      conditions: [
        { id: 'c-a-no', kind: 'eq', unknownId: 'u-a', value: 'no' },
        { id: 'c-b-yes', kind: 'eq', unknownId: 'u-b', value: 'yes' },
      ],
      items: [
        n3Item({
          id: 'k1',
          conditionNodeId: 'c-a-no',
          effects: [{ type: 'resolveUnknown', unknownId: 'u-b', value: 'yes' }],
        }),
        n3Item({
          id: 'k2',
          conditionNodeId: 'c-b-yes',
          effects: [{ type: 'resolveUnknown', unknownId: 'u-a', value: 'yes' }],
        }),
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    const state = foldEvents(log.events);
    expect([state.effects.get('k1'), state.effects.get('k2')]).toEqual(['unknown', 'unknown']);
    expect(state.resolved.has('u-a')).toBe(false);
    expect(state.resolved.has('u-b')).toBe(false);
  });
});

describe('根拠が分からなくなった依頼は、頼んだ本人に要るかを確かめる', () => {
  it('送った時から条件しだいだった依頼は、条件しだいと示すだけで、確かめは求めない', () => {
    const plan = computePlan(grandmaAsked().events, '2026-11-26T08:00+09:00');
    const request = plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(request).toMatchObject({ live: true, conditional: true });
    expect(request?.needsCheck).toBeUndefined();
    expect(todayCards(plan, 'b').quiet.map((c) => c.kind)).toContain('waiting');
  });

  it('手配が残っていても、根拠の事項に条件の分からない取り消しが来たら、要確認', () => {
    const log = grandmaAsked().add('answered', '2026-11-26T08:00+09:00', 'b', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    third(log, '2026-11-27T17:00+09:00', {
      ...extra,
      items: [
        n3Item({
          id: 'k1',
          kind: 'dayChange',
          conditionNodeId: 'c-extra',
          effects: [{ type: 'cancel', itemId: 'i4' }],
        }),
      ],
    });
    const plan = computePlan(log.events, '2026-11-27T17:01+09:00');
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(false);
    const cards = todayCards(plan, 'b');
    expect(cards.main.map((c) => c.kind)).toContain('check');
    // ふつうの返事待ちとしては並べず、予備も勧めない。
    expect(cards.quiet.some((c) => c.kind === 'waiting')).toBe(false);
    expect(cards.main.some((c) => c.kind === 'backup')).toBe(false);
  });
});

describe('送った後に、頼んだ時の条件や時間が替わったら、要るかを確かめる', () => {
  const grandma = (plan: ReturnType<typeof computePlan>) =>
    plan.requests.find((r) => r.requestId === 'r-grandma');

  it('控えには、送った時の条件の形と、頼んだ時間を写す', () => {
    const log = grandmaAsked();
    const sent = log.events.find((e) => e.type === 'externalRequestSent');
    expect(sent?.type === 'externalRequestSent' && sent.snapshot).toMatchObject({
      conditional: true,
      condition: '["eq","u-date","2026-12-05"]',
      window: {
        start: expect.stringContaining('2026-12-07'),
        end: expect.stringContaining('2026-12-07'),
      },
    });
  });

  it('読み直しで節点の ID はそのままに式が替わったら、要確認。後でその条件に答えが出ても要確認のまま', () => {
    const log = rereadN1(grandmaAsked(), '2026-11-26T09:00+09:00', (read) => {
      const node = read.conditions.find((c) => c.id === 'c-held-5');
      if (node?.kind !== 'eq') throw new Error('条件が無い');
      node.value = '2026-12-08';
    });
    expect(grandma(computePlan(log.events, '2026-11-26T09:01+09:00'))).toMatchObject({
      live: true,
      conditional: true,
      needsCheck: true,
    });
    // 新しい条件が真になっても、相手が新しい前提で引き受けたことにはならない。
    log.add('answered', '2026-11-26T10:00+09:00', 'b', {
      unknownId: 'u-date',
      value: '2026-12-08',
    });
    const plan = computePlan(log.events, '2026-11-26T10:01+09:00');
    expect(grandma(plan)).toMatchObject({ live: true, needsCheck: true });
    expect(grandma(plan)?.conditional).toBeUndefined();
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(false);
  });

  it('読み直しで節点の ID だけが替わり、式が同じなら、確かめは求めない', () => {
    const log = rereadN1(grandmaAsked(), '2026-11-26T09:00+09:00', (read) => {
      for (const node of read.conditions) node.id = `r-${node.id}`;
      for (const item of read.items) {
        if (item.conditionNodeId) item.conditionNodeId = `r-${item.conditionNodeId}`;
      }
    });
    const request = grandma(computePlan(log.events, '2026-11-26T09:01+09:00'));
    expect(request).toMatchObject({ live: true, conditional: true });
    expect(request?.needsCheck).toBeUndefined();
  });

  it('根拠の事項が別の日に置き換えられたら（手配のキーは系譜で同じ）、頼んだ時間が違うので要確認', () => {
    // 5日に行うと決まった後に、振替休業日が別の日に変わったと届く（条件も式も同じ。時間だけが違う）。
    const log = grandmaAsked().add('answered', '2026-11-26T10:00+09:00', 'b', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    third(log, '2026-11-27T17:00+09:00', {
      unknowns: [],
      conditions: [],
      items: [
        n3Item({
          id: 'k1',
          kind: 'dayChange',
          interpretation: { date: '2026-12-14', dayType: 'noSchool' },
          conditionNodeId: 'c-held-5',
          effects: [{ type: 'replace', itemId: 'i4' }],
        }),
      ],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    const plan = computePlan(log.events, '2026-11-27T17:01+09:00');
    expect(plan.arrangements.find((a) => a.key === CARE)?.start).toContain('2026-12-14');
    expect(grandma(plan)).toMatchObject({ live: true, needsCheck: true });
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(false);
  });

  // v0 のエンジンが作る根拠は一つの事項だが、型は複数を許すので、二つの根拠の控えを合成する。
  const twoBases = () => {
    const base = noticeArrived();
    const condition = basisCondition(foldEvents(base.events), ['i4', 'i1']);
    return grandmaAsked((snapshot) => ({
      ...snapshot,
      basis: { ...snapshot.basis, itemIds: ['i4', 'i1'] },
      condition,
    }));
  };

  it('根拠が二つあり、手配を作らない方の事項の条件だけが読み直しで替わっても、要確認', () => {
    const log = rereadN1(twoBases(), '2026-11-26T09:00+09:00', (read) => {
      const supporting = read.items.find((i) => i.id === 'i1');
      if (!supporting) throw new Error('i1 が無い');
      supporting.conditionNodeId = 'c-held-8';
    });
    const plan = computePlan(log.events, '2026-11-26T09:01+09:00');
    expect(grandma(plan)).toMatchObject({ live: true, needsCheck: true });
  });

  it('根拠が二つあり、読み直しで一つだけ見つからなくても、手配が残っていても要確認', () => {
    const log = twoBases();
    expect(grandma(computePlan(log.events, '2026-11-26T08:00+09:00'))?.needsCheck).toBeUndefined();
    rereadN1(log, '2026-11-26T09:00+09:00', (read) => {
      read.items = read.items.filter((i) => i.id !== 'i1');
      read.irrelevantSentenceIds.push('n1#6');
    });
    const plan = computePlan(log.events, '2026-11-26T09:01+09:00');
    expect(plan.arrangements.some((a) => a.key === CARE)).toBe(true);
    expect(grandma(plan)).toMatchObject({ live: true, needsCheck: true });
  });

  it('条件に答えが出ただけなら疑いではない（行うなら続け、行わないなら取り消しの連絡）', () => {
    const held = grandmaAsked().add('answered', '2026-11-26T10:00+09:00', 'b', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    const request = grandma(computePlan(held.events, '2026-11-26T10:01+09:00'));
    expect(request).toMatchObject({ live: true });
    expect(request?.needsCheck).toBeUndefined();
    expect(request?.conditional).toBeUndefined();

    const postponed = grandmaAsked().add('answered', '2026-11-26T10:00+09:00', 'b', {
      unknownId: 'u-date',
      value: '2026-12-08',
    });
    const plan = computePlan(postponed.events, '2026-11-26T10:01+09:00');
    expect(grandma(plan)).toMatchObject({ live: false });
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(true);
  });

  it('控えに条件と時間の無い古い事象では、条件と時間からは決めない', () => {
    const log = grandmaAsked(({ to, kind, basis }) => ({ to, kind, basis }));
    rereadN1(log, '2026-11-26T09:00+09:00', (read) => {
      const node = read.conditions.find((c) => c.id === 'c-held-5');
      if (node?.kind !== 'eq') throw new Error('条件が無い');
      node.value = '2026-12-08';
    });
    const request = grandma(computePlan(log.events, '2026-11-26T09:01+09:00'));
    expect(request).toMatchObject({ live: true, conditional: true });
    expect(request?.needsCheck).toBeUndefined();
  });
});
