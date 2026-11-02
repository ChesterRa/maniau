import {
  type ConditionNode,
  type DomainEvent,
  Extraction,
  type Item,
  MAX_CONDITION_NODES,
  type Source,
  type Truth,
  type Unknown,
  validateConditions,
} from '@maniau/core';
import type { Collector } from './report';
import { weekday } from './time';

export interface FactState {
  items: Map<string, Item>;
  active: Map<string, Truth>;
  unknowns: Map<string, Unknown>;
}

interface Extracted extends Extraction {
  seq: number;
  sourceSeq: number;
  eventId: string;
  source: Source | undefined;
}

function checkCoverage(
  source: Source,
  extraction: ReturnType<typeof Extraction.parse>,
  report: Collector,
): void {
  const sentenceIds = new Set(source.sentences.map((sentence) => sentence.id));
  if (sentenceIds.size !== source.sentences.length) {
    report.violation('duplicate_sentence', source.id, '出典の文 ID が重複している。');
  }
  const covered = new Set(extraction.irrelevantSentenceIds);
  for (const item of extraction.items) {
    for (const id of item.sentenceIds) {
      if (extraction.irrelevantSentenceIds.includes(id)) {
        report.violation(
          'sentence_classification_conflict',
          id,
          '事項に使う文が関係なしにも入っている。',
        );
      }
      covered.add(id);
    }
  }
  for (const id of covered) {
    if (!sentenceIds.has(id))
      report.violation('unknown_sentence', id, '出典にない文を参照している。');
  }
  for (const id of sentenceIds) {
    if (!covered.has(id))
      report.violation('sentence_uncovered', id, '事項にも関係なしにも分けられていない。');
  }
}

/** 提出された事象までを読み、作業の live とは別に事項の適用を組み立てる。 */
export function collectFacts(events: readonly DomainEvent[], report: Collector): FactState {
  const sources = new Map<string, { source: Source; seq: number }>();
  const latestBySource = new Map<string, Extracted>();
  for (const event of events) {
    if (event.type === 'noticeReceived')
      sources.set(event.source.id, { source: event.source, seq: event.seq });
    if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') continue;
    const parsed = Extraction.safeParse(event.output);
    if (!parsed.success) {
      report.violation('invalid_extraction', event.id, '読み取り結果の型が不正。');
      continue;
    }
    const extraction = parsed.data;
    if (event.sourceId && event.sourceId !== extraction.sourceId) {
      report.violation('extraction_source_mismatch', event.id, '事象と読み取り結果の出典が違う。');
    }
    const received = sources.get(extraction.sourceId);
    const entry = {
      ...extraction,
      seq: event.seq,
      sourceSeq: received?.seq ?? event.seq,
      eventId: event.id,
      source: received?.source,
    };
    latestBySource.set(extraction.sourceId, entry);
  }

  const extracted = [...latestBySource.values()].sort((a, b) => a.sourceSeq - b.sourceSeq);
  // 再読は通知を新しくしない。家族の後の答えを、再読しただけで上書きしない。
  const extractionByEvent = new Map(extracted.map((entry) => [entry.sourceSeq, entry]));
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      if (item.sourceId !== extraction.sourceId)
        report.violation('item_source_mismatch', item.id, '事項の出典と読み取りの出典が違う。');
      const { date, writtenWeekday } = item.interpretation;
      if (writtenWeekday !== undefined && date === undefined) {
        report.undetermined('weekday_date_missing', item.id, '書かれた曜日と照らす日付がない。');
      } else if (writtenWeekday !== undefined && date && weekday(date) !== writtenWeekday) {
        report.violation('weekday_mismatch', item.id, '原文に書かれた曜日と日付が合わない。');
      }
    }
    if (extraction.source) checkCoverage(extraction.source, extraction, report);
    else
      report.undetermined(
        'source_missing',
        extraction.eventId,
        '原文の文と読み取り結果を照らせない。',
      );
  }

  const items = new Map<string, Item>();
  const itemSeq = new Map<string, number>();
  const nodes = new Map<string, ConditionNode>();
  const invalidNodes = new Set<string>();
  const unknowns = new Map<string, Unknown>();
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      if (items.has(item.id))
        report.violation('duplicate_item', item.id, '事項の ID が重複している。');
      items.set(item.id, item);
      itemSeq.set(item.id, extraction.sourceSeq);
    }
    for (const node of extraction.conditions) {
      if (nodes.has(node.id)) {
        report.violation('duplicate_condition', node.id, '条件の ID が重複している。');
        invalidNodes.add(node.id);
      }
      nodes.set(node.id, node);
    }
    for (const unknown of extraction.unknowns) {
      const old = unknowns.get(unknown.id);
      if (old && JSON.stringify(old.values) !== JSON.stringify(unknown.values)) {
        report.violation(
          'unknown_values_conflict',
          unknown.id,
          '同じ未定の値の候補が食い違っている。',
        );
      }
      unknowns.set(unknown.id, unknown);
    }
  }
  // 節点の上限は、複数のお知らせの合計ではなく一つの読み取りごと。
  for (const extraction of extracted) {
    const edges = extraction.conditions.reduce(
      (count, node) =>
        count +
        (node.kind === 'and' || node.kind === 'or'
          ? node.childIds.length
          : node.kind === 'not'
            ? 1
            : 0),
      0,
    );
    if (extraction.conditions.length > MAX_CONDITION_NODES || edges > 5000) {
      report.undetermined(
        'condition_graph_too_large',
        extraction.sourceId,
        '条件の式が検証できる大きさを超える。',
      );
      for (const node of extraction.conditions) invalidNodes.add(node.id);
      continue;
    }
    for (const problem of validateConditions(extraction.conditions, [...unknowns.values()])) {
      invalidNodes.add(problem.nodeId);
      report.violation('invalid_condition', problem.nodeId, '条件の参照・値・循環が不正。');
    }
  }
  const assignments = new Map<string, string>();
  const memo = new Map<string, Truth>();
  const evaluate = (id: string): Truth => {
    const saved = memo.get(id);
    if (saved !== undefined) return saved;
    if (invalidNodes.has(id)) return 'unknown';
    const node = nodes.get(id);
    if (!node) return 'unknown';
    let result: Truth = 'unknown';
    if (node.kind === 'eq') {
      const value = assignments.get(node.unknownId);
      result = value === undefined ? 'unknown' : value === node.value;
    } else if (node.kind === 'not') {
      const value = evaluate(node.childId);
      result = value === 'unknown' ? 'unknown' : !value;
    } else {
      const values = node.childIds.map(evaluate);
      if (node.kind === 'and')
        result = values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
      else result = values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
    }
    memo.set(id, result);
    return result;
  };
  const conditionOf = (item: Item): Truth => {
    if (!item.conditionNodeId) return true;
    if (!nodes.has(item.conditionNodeId)) return 'unknown';
    return evaluate(item.conditionNodeId);
  };
  for (const event of events) {
    if (event.type === 'answered') {
      assignments.set(event.unknownId, event.value);
      memo.clear();
    }
    const extraction = extractionByEvent.get(event.seq);
    if (!extraction) continue;
    for (const item of extraction.items) {
      for (const effect of item.effects) {
        if (effect.type !== 'resolveUnknown') continue;
        const condition = conditionOf(item);
        if (condition === false) continue;
        if (
          item.evidence === 'inferred' ||
          item.evidence === 'conflicting' ||
          condition === 'unknown'
        ) {
          assignments.delete(effect.unknownId);
          memo.clear();
          report.undetermined(
            'resolution_unconfirmed',
            item.id,
            '未定の値を決める作用を確かめられない。',
          );
        } else if (condition) {
          assignments.set(effect.unknownId, effect.value);
          memo.clear();
        }
      }
    }
  }
  for (const [id, value] of assignments) {
    const declared = unknowns.get(id);
    if (!declared)
      report.undetermined('unknown_not_declared', id, '答えに対応する未定の値がない。');
    else if (!declared.values.includes(value))
      report.violation('answer_outside_values', id, '答えが宣言された候補にない。');
  }

  const active = new Map<string, Truth>();
  for (const item of items.values()) {
    if (item.conditionNodeId && !nodes.has(item.conditionNodeId)) {
      report.undetermined('item_condition_missing', item.id, '事項の適用条件がない。');
    }
    const condition = conditionOf(item);
    active.set(
      item.id,
      condition === false
        ? false
        : item.evidence === 'inferred' || item.evidence === 'conflicting'
          ? 'unknown'
          : condition,
    );
  }
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      const effectTruth = active.get(item.id) ?? 'unknown';
      for (const effect of item.effects) {
        if (effect.type === 'resolveUnknown') continue;
        const target = items.get(effect.itemId);
        if (
          !target ||
          (itemSeq.get(effect.itemId) ?? Number.POSITIVE_INFINITY) > extraction.sourceSeq
        ) {
          report.undetermined(
            'effect_target_missing',
            item.id,
            '変更前の事項を事象から確認できない。',
          );
          continue;
        }
        if (effectTruth === true) active.set(effect.itemId, false);
        else if (effectTruth === 'unknown' && active.get(effect.itemId) !== false)
          active.set(effect.itemId, 'unknown');
      }
    }
  }
  return { items, active, unknowns };
}
