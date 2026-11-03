// 家族への問いを、読み取りの条件と答えの候補から独立に照らす。
import type { ConditionNode, PlanResult, Truth } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { instantMinute } from './time';

interface ConditionResult {
  truth: Truth;
  depends: boolean;
  complete: boolean;
}

/** ほかの未定値は、事象から一意に決まった場合だけ使う。 */
function condition(
  id: string | undefined,
  target: string,
  answer: string,
  facts: FactState,
): ConditionResult {
  if (id === undefined) return { truth: true, depends: false, complete: true };
  const visiting = new Set<string>();
  let steps = 0;
  const evaluate = (nodeId: string): ConditionResult => {
    if (++steps > 512 || visiting.has(nodeId))
      return { truth: 'unknown', depends: false, complete: false };
    const node: ConditionNode | undefined = facts.conditions.get(nodeId);
    if (!node) return { truth: 'unknown', depends: false, complete: false };
    visiting.add(nodeId);
    let result: ConditionResult;
    if (node.kind === 'eq') {
      const declared = facts.unknowns.get(node.unknownId);
      const current = node.unknownId === target ? answer : facts.resolvedValues.get(node.unknownId);
      result = {
        truth: current === undefined ? 'unknown' : current === node.value,
        depends: node.unknownId === target,
        complete: declared?.values.includes(node.value) ?? false,
      };
    } else if (node.kind === 'not') {
      const child = evaluate(node.childId);
      result = {
        truth: child.truth === 'unknown' ? 'unknown' : !child.truth,
        depends: child.depends,
        complete: child.complete,
      };
    } else if (node.childIds.length > 512) {
      result = { truth: 'unknown', depends: false, complete: false };
    } else {
      const children = node.childIds.map(evaluate);
      const truths = children.map((child) => child.truth);
      const truth: Truth =
        node.kind === 'and'
          ? truths.includes(false)
            ? false
            : truths.includes('unknown')
              ? 'unknown'
              : true
          : truths.includes(true)
            ? true
            : truths.includes('unknown')
              ? 'unknown'
              : false;
      result = {
        truth,
        depends: children.some((child) => child.depends),
        complete: children.every((child) => child.complete),
      };
    }
    visiting.delete(nodeId);
    return result;
  };
  return evaluate(id);
}

export function checkFamilyQuestions(
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const questions = plan.questions;
  const requirements = new Map(
    plan.requirements.map((requirement) => [requirement.key, requirement]),
  );
  for (const question of questions) {
    const declared = facts.unknowns.get(question.unknownId);
    const stale = facts.staleUnknowns.has(question.unknownId);
    if (history.complete && stale && (question.family || declared?.kind === 'family')) {
      report.violation(
        'family_question_stale_reading',
        question.key,
        '書き直し前の読み取りを、今答えられる問いにしている。',
      );
      continue;
    }
    const declarationCertain = history.complete && !stale;
    if (!question.family) {
      if (declared?.kind === 'family') {
        if (declarationCertain)
          report.violation(
            'family_question_display_missing',
            question.key,
            '家族への問いの表示がない。',
          );
        else
          report.undetermined(
            'family_question_unknown_unverified',
            question.key,
            '問いの候補を確認できない。',
          );
      }
      continue;
    }
    if (question.fallbackValue !== undefined || question.askBy !== undefined)
      report.violation(
        'family_question_default_invalid',
        question.key,
        '家族の判断に既定の答えや聞く時を補っている。',
      );
    if (!declared) {
      report.undetermined(
        'family_question_unknown_unverified',
        question.key,
        '問いの候補を確認できない。',
      );
      continue;
    }
    if (!declarationCertain) {
      report.undetermined(
        'family_question_unknown_unverified',
        question.key,
        '問いの候補を確認できない。',
      );
      continue;
    }
    if (declared.kind !== 'family')
      report.violation(
        'family_question_kind_mismatch',
        question.key,
        '家族の判断ではない値を尋ねている。',
      );
    if (question.family.label !== declared.label)
      report.violation(
        'family_question_label_mismatch',
        question.key,
        '問いの文が読み取った値と違う。',
      );
    if (facts.resolvedValues.has(question.unknownId))
      report.violation(
        'family_question_already_answered',
        question.key,
        '答えの決まった値をもう一度尋ねている。',
      );

    const values = new Set(declared.values);
    if (values.size !== declared.values.length) {
      report.undetermined(
        'family_question_duplicate_values',
        question.key,
        '候補の区別を確認できない。',
      );
      continue;
    }
    const choices = question.family.choices;
    if (
      choices.length !== values.size ||
      new Set(choices.map((choice) => choice.value)).size !== choices.length ||
      choices.some((choice) => !values.has(choice.value))
    )
      report.violation(
        'family_question_choices_mismatch',
        question.key,
        '答えの候補が読み取りと違う。',
      );
    if (question.affects.length === 0 || new Set(question.affects).size !== question.affects.length)
      report.violation(
        'family_question_targets_invalid',
        question.key,
        '影響先の要件が無いか重複している。',
      );
    const targets = question.affects.map((key) => requirements.get(key));
    if (targets.some((target) => !target?.live))
      report.violation(
        'family_question_target_inactive',
        question.key,
        '今は要らない要件を問いの影響先にしている。',
      );
    const now = instantMinute(plan.now);
    if (targets.some((target) => target?.by !== undefined && instantMinute(target.by) <= now))
      report.violation(
        'family_question_target_expired',
        question.key,
        '期限が過ぎた要件を問いの影響先にしている。',
      );
    const deadlines = targets.flatMap((target) => (target?.by ? [instantMinute(target.by)] : []));
    const until = deadlines.length > 0 ? Math.min(...deadlines) : undefined;
    if ((question.until === undefined ? undefined : instantMinute(question.until)) !== until)
      report.violation(
        'family_question_until_mismatch',
        question.key,
        '問いの期限が影響先の要件と違う。',
      );
    for (const choice of choices) {
      if (
        new Set(choice.requirementKeys).size !== choice.requirementKeys.length ||
        choice.requirementKeys.some((key) => !question.affects.includes(key)) ||
        new Set(choice.conditionalKeys).size !== choice.conditionalKeys.length ||
        choice.conditionalKeys.some((key) => !choice.requirementKeys.includes(key))
      )
        report.violation(
          'family_question_choice_target_invalid',
          question.key,
          '候補の影響先が問いの要件と違う。',
        );
    }
    if (question.affects.length * choices.length > 256) {
      report.undetermined(
        'family_question_scope_unverified',
        question.key,
        '候補と要件が多く、全ての条件を照らせない。',
      );
      continue;
    }
    for (const target of targets) {
      if (!target?.live || target.basis.itemIds.length !== 1) {
        report.undetermined(
          'family_question_basis_unverified',
          question.key,
          '問いの影響先の根拠を一つに決められない。',
        );
        continue;
      }
      const item = facts.items.get(target.basis.itemIds[0] ?? '');
      if (
        !item ||
        !history.complete ||
        facts.staleItems.has(item.id) ||
        item.evidence === 'inferred' ||
        item.evidence === 'conflicting' ||
        (facts.changes.get(item.id)?.length ?? 0) > 0
      ) {
        report.undetermined(
          'family_question_basis_unverified',
          target.key,
          '要件の条件を確かめられない。',
        );
        continue;
      }
      const results = choices.map((choice) =>
        condition(item.conditionNodeId, question.unknownId, choice.value, facts),
      );
      if (results.some((result) => !result.complete)) {
        report.undetermined(
          'family_question_condition_unverified',
          target.key,
          '要件の条件を確かめられない。',
        );
        continue;
      }
      if (!results.some((result) => result.depends)) {
        report.undetermined(
          'family_question_dependency_unverified',
          target.key,
          '問いと要件の関係を確かめられない。',
        );
        continue;
      }
      if (
        (results.length > 0 && results.every((result) => result.truth === true)) ||
        (results.length > 0 && results.every((result) => result.truth === false))
      )
        report.violation(
          'family_question_target_unchanged',
          target.key,
          'どの答えでも変わらない要件を問いの影響先にしている。',
        );
      for (const [index, choice] of choices.entries()) {
        const truth = results[index]?.truth;
        const expected = truth !== false;
        if (choice.requirementKeys.includes(target.key) !== expected)
          report.violation(
            'family_question_choice_effect_mismatch',
            target.key,
            '答えごとの影響が要件の条件と違う。',
          );
        if (choice.conditionalKeys.includes(target.key) !== (truth === 'unknown'))
          report.violation(
            'family_question_choice_certainty_mismatch',
            target.key,
            '答えた後も条件しだいの要件を、確かな物と区別できない。',
          );
      }
    }
  }

  // 計画に残った確かな単一事項について、家族の答えが変わり得るのに問い自体が無い場合も調べる。
  // 未定値を変える作用や欠けた事象がある時は、現時点の未回答を独立に証明できない。
  if (!history.complete) return;
  const families = [...facts.unknowns.values()].filter((unknown) => unknown.kind === 'family');
  if (families.length * Math.max(plan.requirements.length, 1) > 256) {
    report.undetermined(
      'family_question_coverage_unverified',
      'plan',
      '家族への問いを全て照らせない。',
    );
    return;
  }
  const now = instantMinute(plan.now);
  for (const unknown of families) {
    if (facts.resolvedValues.has(unknown.id) || facts.staleUnknowns.has(unknown.id)) continue;
    const possibleAnswer =
      history.events.some(
        (event) =>
          event.type === 'answered' &&
          event.unknownId === unknown.id &&
          !facts.inapplicableAnswers.has(event.seq),
      ) ||
      [...facts.items.values()].some((item) =>
        item.effects.some(
          (effect) => effect.type === 'resolveUnknown' && effect.unknownId === unknown.id,
        ),
      );
    if (possibleAnswer) {
      report.undetermined(
        'family_question_coverage_unverified',
        unknown.id,
        '家族の値が未回答か確かめきれない。',
      );
      continue;
    }
    const values = [...new Set(unknown.values)];
    if (values.length < 2 || values.length > 32) {
      report.undetermined(
        'family_question_coverage_unverified',
        unknown.id,
        '答えの候補を全て照らせない。',
      );
      continue;
    }
    const indirect = [...facts.items.values()].some((item) => {
      if (item.effects.length === 0) return false;
      const result = condition(item.conditionNodeId, unknown.id, values[0] ?? '', facts);
      return result.complete && result.depends;
    });
    if (indirect)
      report.undetermined(
        'family_question_indirect_unverified',
        unknown.id,
        '家族の値が他の事項への作用を通して影響するか確かめられない。',
      );
    for (const target of plan.requirements) {
      if (
        !target.live ||
        (target.by && instantMinute(target.by) <= now) ||
        target.basis.itemIds.length !== 1
      )
        continue;
      const item = facts.items.get(target.basis.itemIds[0] ?? '');
      if (
        !item ||
        facts.staleItems.has(item.id) ||
        item.evidence === 'inferred' ||
        item.evidence === 'conflicting' ||
        (facts.changes.get(item.id)?.length ?? 0) > 0
      )
        continue;
      const results = values.map((value) =>
        condition(item.conditionNodeId, unknown.id, value, facts),
      );
      if (results.some((result) => !result.complete) || !results.some((result) => result.depends))
        continue;
      if (
        results.every((result) => result.truth === true) ||
        results.every((result) => result.truth === false)
      )
        continue;
      if (
        !questions.some(
          (question) =>
            question.unknownId === unknown.id &&
            question.family &&
            question.affects.includes(target.key),
        )
      )
        report.violation(
          'family_question_missing',
          target.key,
          '家族の答えで変わり得る要件の問いがない。',
        );
    }
  }
}
