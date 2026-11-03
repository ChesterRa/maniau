import { type ConditionNode, DomainEvent, type PlanResult, type Unknown } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { collectFacts } from '../src/facts';
import { checkFamilyQuestions } from '../src/family-question';
import type { History } from '../src/history';
import { Collector } from '../src/report';
import { event, household, plan, requirement } from './fixtures';

const label = 'どうするか';
const until = '2026-12-07T09:00+09:00';
const noDeadline = Symbol('no deadline');

function check(
  options: {
    values?: string[];
    nodes?: ConditionNode[];
    root?: string;
    others?: Unknown[];
    answers?: { id: string; value: string; about?: string }[];
    correction?: Record<string, unknown>;
    choices?: { value: string; requirementKeys: string[]; conditionalKeys?: string[] }[];
    by?: string | typeof noDeadline;
    until?: string | typeof noDeadline;
    askBy?: string;
    fallback?: string;
    historyComplete?: boolean;
    staleReading?: boolean;
    familyLabel?: string;
    omitQuestion?: boolean;
    extraQuestions?: Record<string, unknown>[];
    extraItems?: Record<string, unknown>[];
  } = {},
) {
  const values = options.values ?? ['a', 'b', 'c'];
  const source = {
    id: 'source',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'school',
    language: 'ja',
    sentences: [{ id: 'source#1', text: '家族で選びます。' }],
  };
  const nodes = options.nodes ?? [{ id: 'root', kind: 'eq', unknownId: 'u', value: 'c' }];
  const unknowns = [{ id: 'u', label, values, kind: 'family' }, ...(options.others ?? [])];
  const items = [
    {
      id: 'i',
      sourceId: 'source',
      sentenceIds: ['source#1'],
      kind: 'submission',
      written: '家族で選びます。',
      evidence: 'stated',
      interpretation: { what: '提出' },
      conditionNodeId: options.root ?? 'root',
      effects: [],
    },
    ...(options.extraItems ?? []),
  ];
  const events = [
    event(1, { type: 'householdSet', household: household() }),
    event(2, { type: 'noticeReceived', source }),
    event(3, {
      type: 'modelOutputRecorded',
      call: 'extract',
      model: 'fixture',
      promptVersion: 'fixture',
      inputHash: 'fixture',
      sourceId: 'source',
      sourceVersion: 1,
      output: {
        sourceId: 'source',
        items,
        unknowns,
        conditions: nodes,
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    }),
    ...(options.answers ?? []).map((answer, index) =>
      event(4 + index, {
        type: 'answered',
        unknownId: answer.id,
        value: answer.value,
        ...(answer.about === undefined ? {} : { about: answer.about }),
      }),
    ),
    ...(options.correction
      ? [
          event(4 + (options.answers?.length ?? 0), {
            type: 'itemCorrected',
            itemId: 'i',
            interpretation: options.correction,
          }),
        ]
      : []),
    ...(options.staleReading
      ? [
          event(4 + (options.answers?.length ?? 0) + (options.correction ? 1 : 0), {
            type: 'transcriptionCorrected',
            sourceId: 'source',
            sourceVersion: 2,
            sentences: [{ id: 'source#1', text: '書き直した文。' }],
          }),
        ]
      : []),
  ].map((value) => DomainEvent.parse(value));
  const facts = collectFacts(events, new Collector());
  const by = options.by === noDeadline ? undefined : (options.by ?? until);
  const target = requirement({
    key: 'r',
    kind: 'submission',
    what: '提出',
    basis: { itemIds: ['i'] },
    ...(by ? { by } : {}),
  });
  const question = {
    key: 'q',
    unknownId: 'u',
    affects: ['r'],
    ...(options.until === noDeadline ? {} : { until: options.until ?? until }),
    ...(options.askBy === undefined ? {} : { askBy: options.askBy }),
    ...(options.fallback === undefined ? {} : { fallbackValue: options.fallback }),
    family: {
      label: options.familyLabel ?? label,
      choices: (
        options.choices ?? [
          { value: 'a', requirementKeys: [] },
          { value: 'b', requirementKeys: [] },
          { value: 'c', requirementKeys: ['r'] },
        ]
      ).map((choice) => ({ ...choice, conditionalKeys: choice.conditionalKeys ?? [] })),
    },
  };
  const value = {
    ...plan({ now: '2026-12-01T09:00+09:00', requirements: [target] }),
    questions: [...(options.omitQuestion ? [] : [question]), ...(options.extraQuestions ?? [])],
  } as unknown as PlanResult;
  const report = new Collector();
  checkFamilyQuestions(
    value,
    facts,
    { complete: options.historyComplete ?? true, events } as History,
    report,
  );
  return report.issues;
}

const violation = (code: string) => expect.objectContaining({ kind: 'violation', code });

describe('家族への問いの独立検証', () => {
  it('三つ目だけで要件が変わる時、全ての候補と影響を照らす', () => {
    expect(check()).toEqual([]);
    expect(check({ omitQuestion: true })).toContainEqual(violation('family_question_missing'));
    expect(
      check({
        choices: [
          { value: 'a', requirementKeys: [] },
          { value: 'b', requirementKeys: [] },
          { value: 'c', requirementKeys: [] },
        ],
      }),
    ).toContainEqual(violation('family_question_choice_effect_mismatch'));
    expect(
      check({
        choices: [
          { value: 'a', requirementKeys: [] },
          { value: 'b', requirementKeys: [] },
        ],
      }),
    ).toContainEqual(violation('family_question_choices_mismatch'));
  });

  it('家族の判断には勝手な既定の答えや askBy を置かない', () => {
    expect(check({ fallback: 'a' })).toContainEqual(violation('family_question_default_invalid'));
    expect(check({ askBy: until })).toContainEqual(violation('family_question_default_invalid'));
  });

  it('条件しだいの表示は候補に含む要件だけで、確実な要件には付けない', () => {
    expect(
      check({
        choices: [
          { value: 'a', requirementKeys: [], conditionalKeys: ['r'] },
          { value: 'b', requirementKeys: [] },
          { value: 'c', requirementKeys: ['r'] },
        ],
      }),
    ).toContainEqual(violation('family_question_choice_target_invalid'));
    expect(
      check({
        choices: [
          { value: 'a', requirementKeys: [] },
          { value: 'b', requirementKeys: [] },
          { value: 'c', requirementKeys: ['r'], conditionalKeys: ['r'] },
        ],
      }),
    ).toContainEqual(violation('family_question_choice_certainty_mismatch'));
  });

  it('既に決まった答え、過ぎた期限、異なる until を見つける', () => {
    expect(check({ answers: [{ id: 'u', value: 'a' }] })).toContainEqual(
      violation('family_question_already_answered'),
    );
    expect(check({ by: '2026-12-01T09:00+09:00', until: '2026-12-01T09:00+09:00' })).toContainEqual(
      violation('family_question_target_expired'),
    );
    expect(check({ until: '2026-12-08T09:00+09:00' })).toContainEqual(
      violation('family_question_until_mismatch'),
    );
    expect(check({ by: noDeadline, until: noDeadline })).toEqual([]);
  });

  it('前の答えを、訂正で違う用件になった問いへの答えとしない', () => {
    const about = JSON.stringify({
      label,
      values: ['a', 'b', 'c'],
      items: [
        {
          id: 'i',
          kind: 'submission',
          written: '家族で選びます。',
          interpretation: { what: '提出' },
        },
      ],
    });
    expect(check({ answers: [{ id: 'u', value: 'a', about }] })).toContainEqual(
      violation('family_question_already_answered'),
    );
    expect(
      check({ answers: [{ id: 'u', value: 'a', about }], correction: { what: '別の提出' } }),
    ).not.toContainEqual(violation('family_question_already_answered'));
    expect(
      check({
        answers: [{ id: 'u', value: 'a', about }],
        correction: { what: '別の提出' },
        omitQuestion: true,
      }),
    ).toContainEqual(violation('family_question_missing'));
    expect(
      check({ answers: [{ id: 'u', value: 'a' }], correction: { what: '別の提出' } }),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'family_question_coverage_unverified',
      }),
    );
  });

  it('同じ用件でも、答えと要件を結ぶ単純な条件が逆になれば聞き直しが必要', () => {
    const about = JSON.stringify({
      label,
      values: ['a', 'b', 'c'],
      items: [
        {
          id: 'i',
          kind: 'submission',
          written: '家族で選びます。',
          interpretation: { what: '提出' },
          condition: JSON.stringify(['eq', 'u', 'a']),
        },
      ],
    });
    expect(
      check({
        nodes: [{ id: 'root', kind: 'eq', unknownId: 'u', value: 'c' }],
        answers: [{ id: 'u', value: 'a', about }],
        omitQuestion: true,
      }),
    ).toContainEqual(violation('family_question_missing'));
  });

  it('A または B で B が真なら、A は要件を変えない', () => {
    const nodes: ConditionNode[] = [
      { id: 'x', kind: 'eq', unknownId: 'u', value: 'c' },
      { id: 'y', kind: 'eq', unknownId: 'v', value: 'yes' },
      { id: 'root', kind: 'or', childIds: ['x', 'y'] },
    ];
    expect(
      check({
        nodes,
        others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'family' }],
        answers: [{ id: 'v', value: 'yes' }],
        choices: ['a', 'b', 'c'].map((value) => ({ value, requirementKeys: ['r'] })),
      }),
    ).toContainEqual(violation('family_question_target_unchanged'));
    expect(
      check({
        nodes,
        omitQuestion: true,
        others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'family' }],
        answers: [{ id: 'v', value: 'yes' }],
      }),
    ).not.toContainEqual(violation('family_question_missing'));
  });

  it('もう一方も未定の複合条件は、unknown 同士を無影響と決めつけない', () => {
    const nodes: ConditionNode[] = [
      { id: 'uy', kind: 'eq', unknownId: 'u', value: 'yes' },
      { id: 'un', kind: 'eq', unknownId: 'u', value: 'no' },
      { id: 'vy', kind: 'eq', unknownId: 'v', value: 'yes' },
      { id: 'vn', kind: 'eq', unknownId: 'v', value: 'no' },
      { id: 'both', kind: 'and', childIds: ['uy', 'vy'] },
      { id: 'neither', kind: 'and', childIds: ['un', 'vn'] },
      { id: 'root', kind: 'or', childIds: ['both', 'neither'] },
    ];
    expect(
      check({
        values: ['yes', 'no'],
        nodes,
        others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'family' }],
        choices: ['yes', 'no'].map((value) => ({
          value,
          requirementKeys: ['r'],
          conditionalKeys: ['r'],
        })),
        extraQuestions: [
          {
            key: 'q-v',
            unknownId: 'v',
            affects: ['r'],
            until,
            family: {
              label: '別の値',
              choices: ['yes', 'no'].map((value) => ({
                value,
                requirementKeys: ['r'],
                conditionalKeys: ['r'],
              })),
            },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      check({
        values: ['yes', 'no'],
        nodes,
        others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'family' }],
        choices: ['yes', 'no'].map((value) => ({ value, requirementKeys: ['r'] })),
      }),
    ).toContainEqual(violation('family_question_choice_certainty_mismatch'));
    expect(
      check({
        values: ['yes', 'no'],
        nodes,
        omitQuestion: true,
        others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'family' }],
      }),
    ).toContainEqual(violation('family_question_missing'));
  });

  it('事象が不完全なら条件の照合を未判定にする', () => {
    expect(check({ historyComplete: false })).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'family_question_unknown_unverified',
      }),
    );
  });

  it('読み直し待ちに古い質問を答えさせず、古い文との違いは決めつけない', () => {
    expect(check({ familyLabel: '別の質問' })).toContainEqual(
      violation('family_question_label_mismatch'),
    );
    const stale = check({ staleReading: true, familyLabel: '別の質問' });
    expect(stale).toContainEqual(violation('family_question_stale_reading'));
    expect(stale).not.toContainEqual(violation('family_question_label_mismatch'));
  });

  it('家族の値から別の未定値を決める作用を通る影響は、未判定にする', () => {
    const nodes: ConditionNode[] = [
      { id: 'u-yes', kind: 'eq', unknownId: 'u', value: 'yes' },
      { id: 'root', kind: 'eq', unknownId: 'v', value: 'yes' },
    ];
    const result = check({
      values: ['yes', 'no'],
      nodes,
      omitQuestion: true,
      others: [{ id: 'v', label: '別の値', values: ['yes', 'no'], kind: 'schedule' }],
      extraItems: [
        {
          id: 'effect',
          sourceId: 'source',
          sentenceIds: ['source#1'],
          kind: 'event',
          written: '家族で選びます。',
          evidence: 'stated',
          interpretation: { what: '変更' },
          conditionNodeId: 'u-yes',
          effects: [{ type: 'resolveUnknown', unknownId: 'v', value: 'yes' }],
        },
      ],
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'family_question_indirect_unverified',
      }),
    );
    expect(result).not.toContainEqual(violation('family_question_missing'));
  });

  it('持ち物の問いの期限と「ない」という既定は、家族への問いと別に守る', () => {
    const target = requirement({
      kind: 'belongings',
      atHomeUnknownId: 'u',
      basis: { itemIds: [] },
    });
    const question = { key: 'q', unknownId: 'u', askBy: until, fallbackValue: 'no', affects: [] };
    const run = (entry: Record<string, unknown>) =>
      verifyPlan({
        household: household(),
        plan: plan({ requirements: [target], questions: [entry] }),
        events: [],
      }).issues;
    expect(run(question)).not.toContainEqual(violation('purchase_question_default_invalid'));
    expect(run({ ...question, fallbackValue: 'yes' })).toContainEqual(
      violation('purchase_question_default_invalid'),
    );
    const { askBy: _askBy, ...untimed } = question;
    expect(run(untimed)).toContainEqual(violation('purchase_question_ask_by_missing'));
  });
});
