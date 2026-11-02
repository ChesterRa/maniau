// 引き受けの控えに、根拠の条件の形を入れる。画面は条件を添えて見せるので、条件も本人が見た物に入る。
// 式が替われば見せ直し、条件の未定の値に答えが出ただけなら、引き受けをそのまま残す。
import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  proposalSnapshot,
  type Source,
  sameProposal,
  splitSentences,
} from '../src';
import { computePlan } from '../src/engine';
import { extraction1, noticeArrived } from './fixtures/demo';

const TEXT = '発表会が12月5日なら、11月27日(金)までに出欠票を提出してください。';
const notice3: Source = {
  id: 'n3',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '出欠票',
  sentences: splitSentences(TEXT, 'n3'),
};
/** 出欠票は、発表会の日（初めのお知らせの未定の値 u-date）が value の時だけ要る。 */
const reading = (value: string | undefined): Extraction => ({
  sourceId: 'n3',
  unknowns: [],
  conditions: value === undefined ? [] : [{ id: 'n3:c1', kind: 'eq', unknownId: 'u-date', value }],
  items: [
    {
      id: 's1',
      sourceId: 'n3',
      sentenceIds: ['n3#1'],
      kind: 'submission',
      written: TEXT,
      interpretation: { what: '出欠票', date: '2026-11-27', writtenWeekday: 5 },
      ...(value === undefined ? {} : { conditionNodeId: 'n3:c1' }),
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
});

const TASK = 'task:submit:s1';
const LABEL = '学習発表会の実施日';
/** 作業の condition：式の形と、式が使う未定の値の名前。 */
const cond = (value: string, label: string | null = LABEL) =>
  JSON.stringify([JSON.stringify(['eq', 'u-date', value]), [['u-date', label]]]);
const NOW = '2026-11-25T20:05+09:00';
const proposed = (value: string | undefined) =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice3 })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n3',
      sourceId: 'n3',
      sourceVersion: 1,
      output: reading(value),
    })
    .add('assignmentProposed', '2026-11-25T20:01+09:00', 'b', { taskKey: TASK, assigneeId: 'b' });

/** 本人が今の提案を見て引き受ける。 */
function accepted(value: string | undefined) {
  const log = proposed(value);
  const task = computePlan(log.events, NOW).tasks.find((t) => t.key === TASK);
  const shown = task && proposalSnapshot(task);
  if (!shown) throw new Error('提案を置けない');
  return {
    shown,
    log: log.add('commitmentChanged', '2026-11-25T20:02+09:00', 'b', {
      taskKey: TASK,
      assigneeId: 'b',
      action: 'accept',
      shown,
    }),
  };
}

describe('引き受けの控えと条件', () => {
  it('条件付きの作業は条件の形を持ち、控えにも入る。条件の無い作業には付けない', () => {
    const conditional = computePlan(proposed('2026-12-05').events, NOW).tasks.find(
      (t) => t.key === TASK,
    );
    expect(conditional?.condition).toBe(cond('2026-12-05'));
    expect(conditional && proposalSnapshot(conditional)?.condition).toBe(conditional?.condition);
    const plain = computePlan(proposed(undefined).events, NOW).tasks.find((t) => t.key === TASK);
    expect(plain).toBeDefined();
    expect(plain?.condition).toBeUndefined();
    expect(plain && proposalSnapshot(plain)).not.toHaveProperty('condition');
  });

  it('同じ時刻・用件でも、条件の式が違えば別の提案。条件の無い古い控えも、条件付きの今とは違う', () => {
    const shown = accepted('2026-12-05').shown;
    expect(sameProposal(shown, { ...shown, condition: cond('2026-12-08') })).toBe(false);
    const { condition: _, ...old } = shown;
    expect(sameProposal(old, shown)).toBe(false);
    expect(sameProposal(shown, structuredClone(shown))).toBe(true);
  });

  it('条件の値に答えが出ただけなら、引き受けをそのまま残す', () => {
    const { log } = accepted('2026-12-05');
    const answered = log.add('answered', '2026-11-26T08:00+09:00', 'a', {
      unknownId: 'u-date',
      value: '2026-12-05',
    });
    const task = computePlan(answered.events, '2026-11-26T08:05+09:00').tasks.find(
      (t) => t.key === TASK,
    );
    expect(task).toMatchObject({ commitment: 'accepted', live: true });
    expect(task?.reconfirm).toBeUndefined();
  });

  it('文を直して読み直し、条件の式が替わったら、引き受けた本人に見せ直す', () => {
    const { log } = accepted('2026-12-05');
    const corrected = log
      .add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'a', {
        sourceId: 'n3',
        sourceVersion: 2,
        sentences: [{ id: 'n3#1', text: TEXT.replace('12月5日', '12月8日') }],
      })
      .add('modelOutputRecorded', '2026-11-26T08:01+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n3-v2',
        sourceId: 'n3',
        sourceVersion: 2,
        output: reading('2026-12-08'),
      });
    const task = computePlan(corrected.events, '2026-11-26T08:05+09:00').tasks.find(
      (t) => t.key === TASK,
    );
    expect(task).toMatchObject({
      commitment: 'accepted',
      condition: cond('2026-12-08'),
      reconfirm: true,
    });
  });

  /** 引き受けた後、条件の未定の値を出した初めのお知らせ（n1）の文を直す。 */
  const correctedN1 = () =>
    accepted('2026-12-05').log.add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'a', {
      sourceId: 'n1',
      sourceVersion: 2,
      sentences: [{ id: 'n1#1', text: '（直した文）' }],
    });
  const rereadN1 = (label: string) => {
    const output = structuredClone(extraction1);
    const unknown = output.unknowns.find((u) => u.id === 'u-date');
    if (!unknown) throw new Error('未定の値が無い');
    unknown.label = label;
    return correctedN1().add('modelOutputRecorded', '2026-11-26T08:01+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: `fixture-n1-v2-${label}`,
      sourceId: 'n1',
      sourceVersion: 2,
      output,
    });
  };
  const AT = '2026-11-26T08:05+09:00';
  const taskIn = (events: Parameters<typeof computePlan>[0]) =>
    computePlan(events, AT).tasks.find((t) => t.key === TASK);

  it('条件の式が同じでも、未定の値の名前が替われば見せ直す（読み直す前の、名前の確かでない間も）', () => {
    expect(taskIn(correctedN1().events)).toMatchObject({
      condition: cond('2026-12-05', null),
      reconfirm: true,
    });
    expect(taskIn(rereadN1('音楽発表会の実施日').events)).toMatchObject({
      commitment: 'accepted',
      condition: cond('2026-12-05', '音楽発表会の実施日'),
      reconfirm: true,
    });
    // 名前も式も同じに読み直せば、元の引き受けのまま（見せ直さない）。
    const kept = taskIn(rereadN1(LABEL).events);
    expect(kept).toMatchObject({ commitment: 'accepted', condition: cond('2026-12-05') });
    expect(kept?.reconfirm).toBeUndefined();
  });

  it('名前を出したお知らせを取り下げたら、名前の確かでない条件になり、見せ直す', () => {
    const withdrawn = accepted('2026-12-05').log.add(
      'sourceWithdrawn',
      '2026-11-26T08:00+09:00',
      'a',
      { sourceId: 'n1' },
    );
    expect(taskIn(withdrawn.events)).toMatchObject({
      commitment: 'accepted',
      live: true,
      condition: cond('2026-12-05', null),
      reconfirm: true,
    });
  });

  it('作業の元のお知らせの文を直し、まだ読み直していない間は、確かでない条件として見せ直す', () => {
    const corrected = (value: string | undefined) =>
      accepted(value).log.add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'a', {
        sourceId: 'n3',
        sourceVersion: 2,
        sentences: [{ id: 'n3#1', text: TEXT.replace('12月5日', '12月8日') }],
      });
    const doubted = (value: string) =>
      JSON.stringify([JSON.stringify(['eq', 'u-date', value]), [['u-date', LABEL]], 'doubted']);
    expect(taskIn(corrected('2026-12-05').events)).toMatchObject({
      commitment: 'accepted',
      condition: doubted('2026-12-05'),
      reconfirm: true,
    });
    // 条件の無い作業も、元の文を直した後は確かでない（画面は「条件しだい」と添える）。
    expect(taskIn(corrected(undefined).events)).toMatchObject({
      commitment: 'accepted',
      condition: JSON.stringify(['true', [], 'doubted']),
      reconfirm: true,
    });
    // 同じ中身に読み直せば、元の引き受けのまま。
    const same = corrected('2026-12-05').add(
      'modelOutputRecorded',
      '2026-11-26T08:01+09:00',
      'system',
      {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n3-v2-same',
        sourceId: 'n3',
        sourceVersion: 2,
        output: reading('2026-12-05'),
      },
    );
    const kept = taskIn(same.events);
    expect(kept).toMatchObject({ commitment: 'accepted', condition: cond('2026-12-05') });
    expect(kept?.reconfirm).toBeUndefined();
  });
});
