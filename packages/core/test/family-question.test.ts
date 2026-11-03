// 家族が決める値の問い（参加するか等）：答えで要る物が変わる時だけ聞く。値ごとに代入して条件を三値で
// 求め、どの値でも同じ確かな結果なら聞かない。答えが要る最後の時（until）は、変わる要件のまだ過ぎていない
// 最も早い期限。答えるまで、それで変わる作業は「だれがやるか」に出さない。答えは、答えた時の問いの形
// （名前・値・使う事項の中身）が今と同じ時だけ使う。
import { describe, expect, it } from 'vitest';
import {
  type ConditionNode,
  type Extraction,
  type Item,
  notificationIntents,
  type Source,
  splitSentences,
  todayCards,
  type Unknown,
} from '../src';
import { computePlan, familyQuestionBasis, foldEvents } from '../src/engine';
import { EventLog, household } from './fixtures/demo';

const TEXT = [
  '12月13日(日)9:00から親子清掃を行います。',
  '参加される方は、11月30日(月)17:00までに申込書を提出してください。',
].join('\n');

const notice: Source = {
  id: 'p1',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '親子清掃のお知らせ',
  sentences: splitSentences(TEXT, 'p1'),
};

const JOIN: Unknown = {
  id: 'u-join',
  label: '親子清掃に参加するか',
  values: ['yes', 'no'],
  kind: 'family',
};

/** 申込書（提出物）。条件の節点を付けると、その条件しだいになる。 */
const form = (conditionNodeId?: string, deadline = '2026-11-30T17:00+09:00'): Item => ({
  id: 's1',
  sourceId: 'p1',
  sentenceIds: ['p1#2'],
  kind: 'submission',
  written: '参加される方は、11月30日(月)17:00までに申込書を提出してください。',
  interpretation: { what: '申込書', deadline },
  evidence: 'stated',
  effects: [],
  ...(conditionNodeId ? { conditionNodeId } : {}),
});

const extraction = (
  unknowns: Unknown[],
  conditions: ConditionNode[],
  items: Item[],
): Extraction => ({
  sourceId: 'p1',
  unknowns,
  conditions,
  items,
  ambiguities: [],
  irrelevantSentenceIds: [],
});

const JOIN_YES: ConditionNode = { id: 'c-join', kind: 'eq', unknownId: 'u-join', value: 'yes' };

const arrived = (output: Extraction = extraction([JOIN], [JOIN_YES], [form('c-join')])) =>
  new EventLog()
    .add('householdSet', '2026-11-24T21:00+09:00', 'a', { household })
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-p1',
      sourceId: 'p1',
      output,
    });

const NOW = '2026-11-25T20:05+09:00';
const REQ = 'req:submission:s1';
const TASK = 'task:submit:s1';

describe('家族が決める値の問い', () => {
  it('参加するなら申込書が要る時、参加するかを聞き、値ごとに要る物と期限を添える', () => {
    const plan = computePlan(arrived().events, NOW);
    expect(plan.questions).toEqual([
      {
        key: 'q:u-join',
        unknownId: 'u-join',
        until: '2026-11-30T17:00+09:00',
        affects: [REQ],
        family: {
          label: '親子清掃に参加するか',
          choices: [
            { value: 'yes', requirementKeys: [REQ], conditionalKeys: [] },
            { value: 'no', requirementKeys: [], conditionalKeys: [] },
          ],
        },
      },
    ]);
    // 安全な既定の答えは無い。聞く目安（askBy）も付けない（知らせは until で決める）。
    expect(plan.questions[0]?.fallbackValue).toBeUndefined();
    expect(plan.questions[0]?.askBy).toBeUndefined();
  });

  it('答えるまで、申込書の作業を「だれがやるか」に出さず、二人に問いの札を出す', () => {
    const plan = computePlan(arrived().events, NOW);
    expect(plan.tasks.some((t) => t.key === TASK)).toBe(true);
    for (const member of ['a', 'b']) {
      const main = todayCards(plan, member).main;
      expect(main.some((c) => c.kind === 'question' && c.question.unknownId === 'u-join')).toBe(
        true,
      );
      expect(main.some((c) => c.kind === 'unowned' && c.task.key === TASK)).toBe(false);
    }
  });

  it('参加するなら要る持ち物は、決めるまで家にあるかを聞かない（先に参加するかを聞く）', () => {
    const shoes: Item = {
      id: 'b1',
      sourceId: 'p1',
      sentenceIds: ['p1#1'],
      kind: 'belongings',
      written: '上履き',
      interpretation: { what: '上履き', date: '2026-12-13' },
      evidence: 'stated',
      effects: [],
      conditionNodeId: 'c-join',
    };
    const log = () => arrived(extraction([JOIN], [JOIN_YES], [form('c-join'), shoes]));
    const plan = computePlan(log().events, NOW);
    expect(plan.questions.map((q) => q.unknownId).sort()).toEqual(['u-atHome:b1', 'u-join']);
    const asked = (p: typeof plan) =>
      todayCards(p, 'a')
        .main.flatMap((c) => (c.kind === 'question' ? [c.question.unknownId] : []))
        .sort();
    expect(asked(plan)).toEqual(['u-join']);
    const yes = log().add('answered', '2026-11-25T20:06+09:00', 'b', {
      unknownId: 'u-join',
      value: 'yes',
    });
    expect(asked(computePlan(yes.events, NOW))).toEqual(['u-atHome:b1']);
  });

  it('参加すると答えれば問いは消えて作業が出る。参加しないなら要件も作業も生きていない', () => {
    const yes = arrived().add('answered', '2026-11-25T20:06+09:00', 'b', {
      unknownId: 'u-join',
      value: 'yes',
    });
    const after = computePlan(yes.events, NOW);
    expect(after.questions).toEqual([]);
    expect(
      todayCards(after, 'a').main.some((c) => c.kind === 'unowned' && c.task.key === TASK),
    ).toBe(true);
    const no = arrived().add('answered', '2026-11-25T20:06+09:00', 'b', {
      unknownId: 'u-join',
      value: 'no',
    });
    const skipped = computePlan(no.events, NOW);
    expect(skipped.questions).toEqual([]);
    expect(skipped.requirements.find((r) => r.key === REQ)?.live).toBe(false);
    expect(todayCards(skipped, 'a').main.some((c) => c.kind === 'unowned')).toBe(false);
  });

  it('ほかの値で結果が決まっていれば聞かず、ほかの値が分からなければ聞く（A か B）', () => {
    const other: Unknown = {
      id: 'u-sib',
      label: 'きょうだいが参加するか',
      values: ['yes', 'no'],
      kind: 'other',
    };
    const either: ConditionNode[] = [
      JOIN_YES,
      { id: 'c-sib', kind: 'eq', unknownId: 'u-sib', value: 'yes' },
      { id: 'c-or', kind: 'or', childIds: ['c-join', 'c-sib'] },
    ];
    const open = arrived(extraction([JOIN, other], either, [form('c-or')]));
    const asked = computePlan(open.events, NOW).questions;
    expect(asked.map((q) => q.unknownId)).toEqual(['u-join']);
    // 参加するなら確かに要る。参加しないなら、きょうだいしだい（確かに要るとは書かない）。
    expect(asked[0]?.family?.choices).toEqual([
      { value: 'yes', requirementKeys: [REQ], conditionalKeys: [] },
      { value: 'no', requirementKeys: [REQ], conditionalKeys: [REQ] },
    ]);
    const settled = arrived(extraction([JOIN, other], either, [form('c-or')])).add(
      'answered',
      '2026-11-25T20:06+09:00',
      'b',
      { unknownId: 'u-sib', value: 'yes' },
    );
    expect(computePlan(settled.events, NOW).questions).toEqual([]);
  });

  it('二つの家族の値が組み合わさる条件では、どちらも聞く（片方だけでは分からないを、効かないとしない）', () => {
    const tool: Unknown = {
      id: 'u-tool',
      label: '道具を持って行くか',
      values: ['yes', 'no'],
      kind: 'family',
    };
    const both: ConditionNode[] = [
      JOIN_YES,
      { id: 'c-tool', kind: 'eq', unknownId: 'u-tool', value: 'yes' },
      { id: 'c-join-no', kind: 'eq', unknownId: 'u-join', value: 'no' },
      { id: 'c-tool-no', kind: 'eq', unknownId: 'u-tool', value: 'no' },
      { id: 'c-same-yes', kind: 'and', childIds: ['c-join', 'c-tool'] },
      { id: 'c-same-no', kind: 'and', childIds: ['c-join-no', 'c-tool-no'] },
      { id: 'c-same', kind: 'or', childIds: ['c-same-yes', 'c-same-no'] },
    ];
    const plan = computePlan(arrived(extraction([JOIN, tool], both, [form('c-same')])).events, NOW);
    expect(plan.questions.map((q) => q.unknownId).sort()).toEqual(['u-join', 'u-tool']);
    // どちらの値でも、もう一つの答えしだい（「はいなら要る」と断定しない）。
    expect(plan.questions.find((q) => q.unknownId === 'u-join')?.family?.choices).toEqual([
      { value: 'yes', requirementKeys: [REQ], conditionalKeys: [REQ] },
      { value: 'no', requirementKeys: [REQ], conditionalKeys: [REQ] },
    ]);
  });

  it('値が三つあれば三つとも代入する（三つ目の値でだけ要る物も聞く）', () => {
    const three: Unknown = { ...JOIN, values: ['午前', '午後', '両方'] };
    const third: ConditionNode = { id: 'c-both', kind: 'eq', unknownId: 'u-join', value: '両方' };
    const plan = computePlan(arrived(extraction([three], [third], [form('c-both')])).events, NOW);
    expect(plan.questions[0]?.family?.choices).toEqual([
      { value: '午前', requirementKeys: [], conditionalKeys: [] },
      { value: '午後', requirementKeys: [], conditionalKeys: [] },
      { value: '両方', requirementKeys: [REQ], conditionalKeys: [] },
    ]);
  });

  it('家族の決める値でない（天気など）、使う事項が無い、期限が過ぎた、取り下げたお知らせの値は聞かない', () => {
    const weather = arrived(extraction([{ ...JOIN, kind: 'other' }], [JOIN_YES], [form('c-join')]));
    expect(computePlan(weather.events, NOW).questions).toEqual([]);
    const unused = arrived(extraction([JOIN], [JOIN_YES], [form()]));
    expect(computePlan(unused.events, NOW).questions).toEqual([]);
    expect(computePlan(arrived().events, '2026-11-30T17:00+09:00').questions).toEqual([]);
    const withdrawn = arrived().add('sourceWithdrawn', '2026-11-25T20:06+09:00', 'a', {
      sourceId: 'p1',
    });
    expect(computePlan(withdrawn.events, NOW).questions).toEqual([]);
  });

  it('期限の分からない問いは札だけで知らせず、期限のある問いは期限の 26 時間前から知らせる', () => {
    const undated = arrived(
      extraction([JOIN], [JOIN_YES], [{ ...form('c-join'), interpretation: { what: '申込書' } }]),
    );
    const plan = computePlan(undated.events, NOW);
    expect(plan.questions[0]).toMatchObject({ unknownId: 'u-join', affects: [REQ] });
    expect(plan.questions[0]?.until).toBeUndefined();
    expect(notificationIntents(plan, household).filter((i) => i.kind === 'question')).toEqual([]);
    const intentsAt = (now: string) =>
      notificationIntents(computePlan(arrived().events, now), household).filter(
        (i) => i.kind === 'question',
      );
    expect(intentsAt('2026-11-29T14:00+09:00')).toEqual([]);
    expect(intentsAt('2026-11-29T16:00+09:00')).toEqual(
      ['a', 'b'].map((member) =>
        expect.objectContaining({
          toMemberId: member,
          key: `question:u-join:${member}`,
          subject: { type: 'question', id: 'u-join' },
          titleKey: 'notify.question',
          until: '2026-11-30T17:00+09:00',
        }),
      ),
    );
  });

  it('答えで要る物が無い値でも、同じお知らせの条件の無い作業は隠さない（問いは変わる要件だけ）', () => {
    const always: Item = {
      ...form(),
      id: 's0',
      sentenceIds: ['p1#1'],
      written: '出欠票を11月30日(月)までに提出してください。',
      interpretation: { what: '出欠票', deadline: '2026-11-30T08:00+09:00', deadlineDayOnly: true },
    };
    const plan = computePlan(
      arrived(extraction([JOIN], [JOIN_YES], [always, form('c-join')])).events,
      NOW,
    );
    expect(plan.questions[0]?.affects).toEqual([REQ]);
    const unowned = todayCards(plan, 'a').main.flatMap((c) =>
      c.kind === 'unowned' ? [c.task.key] : [],
    );
    expect(unowned).toContain('task:submit:s0');
    expect(unowned).not.toContain(TASK);
  });

  describe('答えた後に、問いや事項が替わった時', () => {
    /** 答えた時の問いの形を控えた答え（サーバーが付ける about と同じ物）。 */
    const answered = (log: EventLog, value = 'yes') => {
      const about = familyQuestionBasis(foldEvents(log.events), JOIN);
      return log.add('answered', '2026-11-25T20:06+09:00', 'b', {
        unknownId: 'u-join',
        value,
        about,
      });
    };
    const reread = (log: EventLog, output: Extraction, text = TEXT) =>
      log
        .add('transcriptionCorrected', '2026-11-25T20:10+09:00', 'b', {
          sourceId: 'p1',
          sourceVersion: 2,
          sentences: splitSentences(text, 'p1'),
        })
        .add('modelOutputRecorded', '2026-11-25T20:10+09:00', 'system', {
          call: 'extract',
          model: 'hand-written',
          promptVersion: 'fixture',
          inputHash: 'fixture-p1-v2',
          sourceId: 'p1',
          sourceVersion: 2,
          output,
        });

    it('読み直して同じ ID が別の問い（参加→欠席）になれば、前の答えを当てず、前の答えを添えて聞き直す', () => {
      const absent = '欠席される方は、11月30日(月)17:00までに欠席届を提出してください。';
      const output = extraction(
        [{ ...JOIN, label: '親子清掃を欠席するか' }],
        [JOIN_YES],
        [
          {
            ...form('c-join'),
            written: absent,
            interpretation: { what: '欠席届', deadline: '2026-11-30T17:00+09:00' },
          },
        ],
      );
      const log = reread(answered(arrived()), output, absent);
      const plan = computePlan(log.events, NOW);
      expect(plan.questions).toMatchObject([
        { unknownId: 'u-join', family: { label: '親子清掃を欠席するか', previous: 'yes' } },
      ]);
      // 欠席届は、決めるまで「だれがやるか」に出さない（前の「はい」を欠席の答えにしない）。
      expect(
        todayCards(plan, 'a').main.some((c) => c.kind === 'unowned' && c.task.key === TASK),
      ).toBe(false);
    });

    it('読み直して事項の中身も名前も同じでも、条件の式が替われば（参加なら→参加しないなら）聞き直す', () => {
      const flipped: ConditionNode = { ...JOIN_YES, value: 'no' };
      const log = reread(answered(arrived()), extraction([JOIN], [flipped], [form('c-join')]));
      expect(computePlan(log.events, NOW).questions).toMatchObject([
        { unknownId: 'u-join', family: { previous: 'yes' } },
      ]);
    });

    it('読み直しても、問いとそれを使う事項の中身が同じなら、前の答えをそのまま使う', () => {
      const log = reread(answered(arrived()), extraction([JOIN], [JOIN_YES], [form('c-join')]));
      const plan = computePlan(log.events, NOW);
      expect(plan.questions).toEqual([]);
      expect(plan.requirements.find((r) => r.key === REQ)?.live).toBe(true);
    });

    it('家族が事項の中身（締切）を直せば、前の答えを当てず聞き直す。時が進んだだけでは聞き直さない', () => {
      const corrected = answered(arrived()).add('itemCorrected', '2026-11-25T20:10+09:00', 'a', {
        itemId: 's1',
        interpretation: { deadline: '2026-12-04T17:00+09:00' },
      });
      const plan = computePlan(corrected.events, NOW);
      expect(plan.questions).toMatchObject([
        { unknownId: 'u-join', until: '2026-12-04T17:00+09:00', family: { previous: 'yes' } },
      ]);
      expect(computePlan(answered(arrived()).events, '2026-11-29T09:00+09:00').questions).toEqual(
        [],
      );
    });

    it('文を直して読み直す前は、前の読み取りの名前で聞かない（読み直した後に聞く）', () => {
      const pending = arrived().add('transcriptionCorrected', '2026-11-25T20:10+09:00', 'b', {
        sourceId: 'p1',
        sourceVersion: 2,
        sentences: splitSentences(TEXT, 'p1'),
      });
      expect(computePlan(pending.events, NOW).questions).toEqual([]);
      const done = pending.add('modelOutputRecorded', '2026-11-25T20:11+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-p1-v2',
        sourceId: 'p1',
        sourceVersion: 2,
        output: extraction([JOIN], [JOIN_YES], [form('c-join')]),
      });
      expect(computePlan(done.events, NOW).questions.map((q) => q.unknownId)).toEqual(['u-join']);
    });
  });
});
