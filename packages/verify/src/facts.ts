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
  conditions: Map<string, ConditionNode>;
  changes: Map<string, { kind: 'replace' | 'cancel'; itemId: string; active: Truth }[]>;
}

/** 送信時の根拠は、確かな一対一の置き換えをたどる。競合や循環は決めつけない。 */
export function historicalItem(
  facts: FactState,
  originalId: string,
): { itemId: string; active: Truth } {
  const seen = new Set<string>();
  let itemId = originalId;
  for (;;) {
    if (seen.has(itemId)) return { itemId, active: 'unknown' };
    seen.add(itemId);
    if (!facts.items.has(itemId)) return { itemId, active: 'unknown' };
    const changes = facts.changes.get(itemId) ?? [];
    if (changes.some((change) => change.active === 'unknown')) return { itemId, active: 'unknown' };
    const effective = changes.filter((change) => change.active === true);
    if (effective.length > 1) return { itemId, active: 'unknown' };
    const only = effective[0];
    if (!only) return { itemId, active: facts.active.get(itemId) ?? 'unknown' };
    if (only.kind === 'cancel') return { itemId, active: false };
    itemId = only.itemId;
  }
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
  // 未定値ごとに、最後に効く可能性のある答えを列挙する。条件が不明なら「効く」と「効かない」の両方を
  // 残す。値の集合を全候補から徐々に絞るので、出典の後に家族が条件へ答えても作用を再評価できる。
  type Candidate = { value: string; seq: number; order: number; item?: Item };
  const candidates = new Map<string, Candidate[]>();
  let order = 0;
  const addCandidate = (id: string, candidate: Candidate) => {
    const list = candidates.get(id) ?? [];
    list.push(candidate);
    candidates.set(id, list);
  };
  for (const event of events) {
    if (event.type === 'answered') {
      addCandidate(event.unknownId, { value: event.value, seq: event.seq, order: order++ });
    }
  }
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      for (const effect of item.effects) {
        if (effect.type === 'resolveUnknown') {
          addCandidate(effect.unknownId, {
            value: effect.value,
            seq: extraction.sourceSeq,
            order: order++,
            item,
          });
        }
      }
    }
  }
  for (const list of candidates.values()) list.sort((a, b) => b.seq - a.seq || b.order - a.order);
  const domains = new Map<string, Set<string | undefined>>();
  for (const id of new Set([...unknowns.keys(), ...candidates.keys()])) {
    domains.set(
      id,
      new Set([
        undefined,
        ...(unknowns.get(id)?.values ?? []),
        ...(candidates.get(id) ?? []).map((c) => c.value),
      ]),
    );
  }
  const memo = new Map<string, Truth>();
  const evaluate = (id: string): Truth => {
    const saved = memo.get(id);
    if (saved !== undefined) return saved;
    if (invalidNodes.has(id)) return 'unknown';
    const node = nodes.get(id);
    if (!node) return 'unknown';
    let result: Truth = 'unknown';
    if (node.kind === 'eq') {
      const possible = domains.get(node.unknownId);
      if (possible && !possible.has(undefined)) {
        if (possible.size === 1 && possible.has(node.value)) result = true;
        else if (!possible.has(node.value)) result = false;
      }
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
  const changes = new Map<string, Item[]>();
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      for (const effect of item.effects) {
        if (effect.type === 'resolveUnknown') continue;
        if (
          !items.has(effect.itemId) ||
          (itemSeq.get(effect.itemId) ?? Infinity) > extraction.sourceSeq
        )
          continue;
        const list = changes.get(effect.itemId) ?? [];
        list.push(item);
        changes.set(effect.itemId, list);
      }
    }
  }
  const baseActivity = (item: Item): Truth => {
    const condition = conditionOf(item);
    if (condition === false) return false;
    return item.evidence === 'inferred' || item.evidence === 'conflicting' ? 'unknown' : condition;
  };
  const sourceActivity = (item: Item): Truth => {
    const base = baseActivity(item);
    if (base === false) return false;
    let uncertain = base === 'unknown';
    for (const change of changes.get(item.id) ?? []) {
      const truth = baseActivity(change);
      if (truth === false) continue;
      // 変更した事項にも別の変更が及ぶ時は、古い事項が復活するかを決めつけない。
      const changedAgain = (changes.get(change.id) ?? []).some(
        (later) => baseActivity(later) !== false,
      );
      if (truth === 'unknown' || changedAgain) uncertain = true;
      else return false;
    }
    return uncertain ? 'unknown' : true;
  };
  const possibleFor = (id: string): Set<string | undefined> => {
    const possible = new Set<string | undefined>();
    const list = candidates.get(id) ?? [];
    let index = 0;
    while (index < list.length) {
      const seq = list[index]?.seq;
      let certainAtThisSeq = false;
      while (index < list.length && list[index]?.seq === seq) {
        const candidate = list[index];
        index += 1;
        if (!candidate) continue;
        const truth: Truth = candidate.item ? sourceActivity(candidate.item) : true;
        if (truth === false) continue;
        possible.add(candidate.value);
        if (truth === true) certainAtThisSeq = true;
      }
      // 同じ通知に異なる答えが複数あれば、配列の後ろを「後に届いた」とは扱わない。
      if (certainAtThisSeq) return possible;
    }
    possible.add(undefined);
    return possible;
  };
  const maxRounds = Math.min(
    256,
    1 + [...domains.values()].reduce((sum, set) => sum + set.size, 0),
  );
  let converged = false;
  for (let round = 0; round < maxRounds; round++) {
    memo.clear();
    const next = new Map<string, Set<string | undefined>>();
    for (const [id, previous] of domains) {
      const possible = possibleFor(id);
      next.set(id, new Set([...previous].filter((value) => possible.has(value))));
    }
    converged = [...next].every(([id, set]) => {
      const previous = domains.get(id);
      return previous?.size === set.size && [...set].every((value) => previous.has(value));
    });
    for (const [id, set] of next) domains.set(id, set);
    if (converged) break;
  }
  memo.clear();
  const inconsistent = [...domains.values()].some((possible) => possible.size === 0);
  if (!converged || inconsistent) {
    report.undetermined('resolution_graph_limit', 'events', '条件つきの答えを確認し切れない。');
    // 絞り込みが破綻した時は、途中で得た一意の値も根拠にしない。
    for (const id of domains.keys()) domains.set(id, new Set([undefined]));
  }
  const assignments = new Map<string, string>();
  for (const [id, possible] of domains) {
    const only = possible.size === 1 ? [...possible][0] : undefined;
    if (only !== undefined) assignments.set(id, only);
  }
  memo.clear();
  for (const [id, list] of candidates) {
    const possible = domains.get(id);
    if (possible?.size === 1 && !possible.has(undefined)) continue;
    for (const candidate of list) {
      if (candidate.item && sourceActivity(candidate.item) !== false) {
        report.undetermined(
          'resolution_unconfirmed',
          candidate.item.id,
          '未定の値を決める作用を確かめられない。',
        );
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
    active.set(item.id, sourceActivity(item));
  }
  const itemChanges: FactState['changes'] = new Map();
  for (const extraction of extracted) {
    for (const item of extraction.items) {
      for (const effect of item.effects) {
        if (effect.type === 'resolveUnknown') continue;
        if (
          !items.has(effect.itemId) ||
          (itemSeq.get(effect.itemId) ?? Infinity) > extraction.sourceSeq
        )
          continue;
        let activity = sourceActivity(item);
        // 作用を持つ事項が後の変更を受けた時、元の事項がどうなるかは保守的に扱う。
        if (activity === false && changes.has(item.id)) activity = 'unknown';
        const list = itemChanges.get(effect.itemId) ?? [];
        list.push({ kind: effect.type, itemId: item.id, active: activity });
        itemChanges.set(effect.itemId, list);
      }
    }
  }
  for (const extraction of extracted) {
    for (const item of extraction.items) {
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
        }
      }
    }
  }
  return { items, active, unknowns, conditions: nodes, changes: itemChanges };
}
