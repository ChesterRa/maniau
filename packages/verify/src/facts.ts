import {
  type Arrangement,
  type ConditionNode,
  type DomainEvent,
  Extraction,
  type Interpretation,
  type Item,
  MAX_CONDITION_NODES,
  type PlanResult,
  type Source,
  type SourceSender,
  type Truth,
  type Unknown,
  validateConditions,
} from '@maniau/core';
import type { Collector } from './report';
import { weekday } from './time';

export interface FactState {
  items: Map<string, Item>;
  /** 出典の内容を持ち越さず、送り手だけを要件の検査に使う。 */
  sourceSenders: Map<string, SourceSender>;
  /** 古い版・型の違う読み取りを除き、各出典で採用された読み取りの通し番号。 */
  sourceReadingSeq: Map<string, number>;
  /** 出典の指定された文を照らすためだけに保持する（検証結果に文を出さない）。 */
  sourceSentences: Map<string, Map<string, string>>;
  active: Map<string, Truth>;
  unknowns: Map<string, Unknown>;
  /** 条件付きの作用もたどり、事象から一意と確認できた答えだけ。 */
  resolvedValues: Map<string, string>;
  /** 名前や事項の内容が今と異なり、使えないと確認できた答えの通し番号。 */
  inapplicableAnswers: Set<number>;
  conditions: Map<string, ConditionNode>;
  changes: Map<string, { kind: 'replace' | 'cancel'; itemId: string; active: Truth }[]>;
  staleItems: Set<string>;
  staleUnknowns: Set<string>;
  corrections: Map<string, Interpretation>;
  /** 有効な大人が当番の帰属を言った時の内容。読み取りの確認とは分ける。 */
  turns: Map<string, { ours: boolean; what: string; audience: string | null }>;
  /** 送り・迎えの意向。読み取りや事項の作用とは分ける。 */
  escorts: Map<
    string,
    {
      needed: boolean;
      childId: string;
      what: string;
      date: string;
      at: string | null;
      place: string | null;
    }
  >;
}

/** 通用の手配の形は、計画ではなく、その根拠の確かな事項からたどる。 */
export function needShape(
  arrangement: Arrangement,
  plan: PlanResult,
  facts: FactState,
): 'by' | 'window' | undefined {
  if (arrangement.kind !== 'need') return undefined;
  const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
  if (requirement?.kind !== 'need' || requirement.basis.itemIds.length !== 1) return undefined;
  const id = requirement.basis.itemIds[0];
  if (!id || facts.active.get(id) !== true || facts.staleItems.has(id)) return undefined;
  const item = facts.items.get(id);
  return item?.kind === 'need' ? item.interpretation.shape : undefined;
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
  sourceVersion: number;
}

/** JSON の値を、オブジェクトの欄の順に依らず照らす。中身を検証結果には出さない。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => sameValue(value, right[i]))
    );
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a)
    .filter((key) => a[key] !== undefined)
    .sort();
  return (
    sameValue(
      keys,
      Object.keys(b)
        .filter((key) => b[key] !== undefined)
        .sort(),
    ) && keys.every((key) => sameValue(a[key], b[key]))
  );
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
  const correctedSources = new Set<string>();
  const withdrawnSources = new Set<string>();
  const purgedSources = new Set<string>();
  const statedSources = new Set<string>();
  const declaredBySource = new Map<string, Set<string>>();
  const seenItems = new Set<string>();
  const invalidExtractions: { eventId: string; sourceId?: string }[] = [];
  const corrections = new Map<string, Interpretation>();
  const verdicts = new Map<string, 'confirmed' | 'dismissed'>();
  const turns = new Map<string, { ours: boolean; what: string; audience: string | null }>();
  const escorts: FactState['escorts'] = new Map();
  for (const event of events) {
    if (event.type === 'noticeReceived') {
      if (purgedSources.has(event.source.id)) {
        report.violation(
          'purged_source_id_reused',
          event.id,
          '中身を消した出典の ID を再び使っている。',
        );
        continue;
      }
      sources.set(event.source.id, { source: event.source, seq: event.seq });
      continue;
    }
    if (event.type === 'transcriptionCorrected') {
      if (statedSources.has(event.sourceId)) {
        report.violation(
          'stated_source_transcription_invalid',
          event.id,
          '家族の言葉を読み取りの書き起こしとして直している。',
        );
        continue;
      }
      const entry = sources.get(event.sourceId);
      if (!entry || purgedSources.has(event.sourceId)) {
        report.undetermined(
          'transcription_source_unverified',
          event.id,
          '直す出典を確認できない。',
        );
      } else if (event.sourceVersion <= entry.source.version) {
        report.violation(
          'transcription_version_invalid',
          event.id,
          '書き起こしの版が進んでいない。',
        );
      } else {
        sources.set(event.sourceId, {
          ...entry,
          source: { ...entry.source, version: event.sourceVersion, sentences: event.sentences },
        });
        correctedSources.add(event.sourceId);
      }
      continue;
    }
    if (event.type === 'sourceWithdrawn') {
      if (sources.has(event.sourceId)) withdrawnSources.add(event.sourceId);
      else
        report.undetermined('source_event_unverified', event.id, '取り下げる出典を確認できない。');
      continue;
    }
    if (event.type === 'sourceContentPurged') {
      if (event.actorId !== 'system') continue;
      if (!sources.has(event.sourceId)) {
        report.undetermined('source_event_unverified', event.id, '消す出典を確認できない。');
      } else if (event.scope === 'all') {
        purgedSources.add(event.sourceId);
      }
      continue;
    }
    if (
      event.type === 'itemConfirmed' ||
      event.type === 'itemCorrected' ||
      event.type === 'itemDismissed' ||
      event.type === 'turnStated' ||
      event.type === 'escortStated' ||
      event.type === 'needWaysSet'
    ) {
      if (!seenItems.has(event.itemId)) {
        report.undetermined(
          'item_action_target_unverified',
          event.id,
          '操作する事項を確認できない。',
        );
        continue;
      }
      // やり方の選択は、事項の読み取りを確かめたり排除したりしない。
      if (event.type === 'needWaysSet') {
        const target = [...latestBySource.values()]
          .filter(
            (entry) => !withdrawnSources.has(entry.sourceId) && !purgedSources.has(entry.sourceId),
          )
          .flatMap((entry) => entry.items)
          .find((item) => item.id === event.itemId);
        if (!target)
          report.undetermined(
            'item_action_target_unverified',
            event.id,
            'その時の事項を確認できない。',
          );
        else if (target.kind !== 'need')
          report.violation(
            'need_choice_target_invalid',
            event.id,
            'すること以外にやり方を選んでいる。',
          );
        continue;
      }
      // 帰属の言明は、読み取りを確認したり、事項の作用を外したりしない。
      if (event.type === 'turnStated') {
        turns.set(event.itemId, { ours: event.ours, what: event.what, audience: event.audience });
        continue;
      }
      if (event.type === 'escortStated') {
        escorts.set(`${event.itemId}:${event.leg}`, {
          needed: event.needed,
          childId: event.childId,
          what: event.what,
          date: event.date,
          at: event.at,
          place: event.place,
        });
        continue;
      }
      if (event.type === 'itemCorrected') {
        corrections.set(event.itemId, {
          ...corrections.get(event.itemId),
          ...event.interpretation,
        });
      }
      verdicts.set(event.itemId, event.type === 'itemDismissed' ? 'dismissed' : 'confirmed');
      continue;
    }
    if (event.type === 'itemsStated') {
      const received = sources.get(event.sourceId);
      if (!received) {
        report.undetermined('source_missing', event.id, '言明の出典を確認できない。');
        continue;
      }
      if (
        received.source.sender !== 'family' ||
        withdrawnSources.has(event.sourceId) ||
        purgedSources.has(event.sourceId) ||
        latestBySource.has(event.sourceId)
      ) {
        report.violation('stated_source_invalid', event.id, '家族の言明に使えない出典。');
        continue;
      }
      let valid = true;
      for (const item of event.items) {
        if (item.sourceId !== event.sourceId) {
          report.violation('item_source_mismatch', item.id, '事項の出典と言明の出典が違う。');
          valid = false;
        }
        if (item.evidence !== 'stated') {
          report.violation('stated_item_evidence_invalid', item.id, '家族の言明の証拠が違う。');
          valid = false;
        }
      }
      if (!valid) continue;
      statedSources.add(event.sourceId);
      for (const item of event.items) seenItems.add(item.id);
      latestBySource.set(event.sourceId, {
        sourceId: event.sourceId,
        items: event.items,
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        seq: event.seq,
        sourceSeq: received.seq,
        eventId: event.id,
        source: received.source,
        sourceVersion: received.source.version,
      });
      continue;
    }
    if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') continue;
    if (event.sourceId && statedSources.has(event.sourceId)) {
      report.violation(
        'stated_source_reading_invalid',
        event.id,
        '家族の言葉を読み取りで置き換えている。',
      );
      continue;
    }
    if (event.sourceId && purgedSources.has(event.sourceId)) {
      report.undetermined(
        'purged_source_reading_ignored',
        event.id,
        '消した出典の読み取りを使わない。',
      );
      continue;
    }
    const parsed = Extraction.safeParse(event.output);
    if (!parsed.success) {
      invalidExtractions.push({
        eventId: event.id,
        ...(event.sourceId ? { sourceId: event.sourceId } : {}),
      });
      continue;
    }
    const extraction = parsed.data;
    if (statedSources.has(extraction.sourceId)) {
      report.violation(
        'stated_source_reading_invalid',
        event.id,
        '家族の言葉を読み取りで置き換えている。',
      );
      continue;
    }
    if (purgedSources.has(extraction.sourceId)) continue;
    if (event.sourceId && event.sourceId !== extraction.sourceId) {
      report.violation('extraction_source_mismatch', event.id, '事象と読み取り結果の出典が違う。');
      continue;
    }
    const inconsistentItems = extraction.items.filter(
      (item) => item.sourceId !== extraction.sourceId,
    );
    if (inconsistentItems.length > 0) {
      for (const item of inconsistentItems)
        report.violation('item_source_mismatch', item.id, '事項の出典と読み取りの出典が違う。');
      continue;
    }
    const received = sources.get(extraction.sourceId);
    if (!received) {
      report.undetermined('source_missing', event.id, '読み取り時に届いていた出典を確認できない。');
      continue;
    }
    if (event.sourceVersion === undefined && correctedSources.has(extraction.sourceId)) {
      report.undetermined(
        'extraction_version_unknown',
        event.id,
        '読み取った文の版を確認できない。',
      );
      continue;
    }
    const sourceVersion = event.sourceVersion ?? received?.source.version ?? 1;
    if (received && sourceVersion > received.source.version) {
      report.violation('extraction_version_future', event.id, 'まだ存在しない版の文を読んでいる。');
      continue;
    }
    const previous = latestBySource.get(extraction.sourceId);
    if (previous && sourceVersion < previous.sourceVersion) continue;
    const declared = declaredBySource.get(extraction.sourceId) ?? new Set<string>();
    for (const unknown of extraction.unknowns) declared.add(unknown.id);
    declaredBySource.set(extraction.sourceId, declared);
    for (const entry of extraction.items) seenItems.add(entry.id);
    const entry = {
      ...extraction,
      seq: event.seq,
      sourceSeq: received?.seq ?? event.seq,
      eventId: event.id,
      source: received?.source,
      sourceVersion,
    };
    latestBySource.set(extraction.sourceId, entry);
  }

  for (const invalid of invalidExtractions) {
    if (
      (invalid.sourceId && purgedSources.has(invalid.sourceId)) ||
      (!invalid.sourceId && purgedSources.size > 0)
    ) {
      report.undetermined(
        'purged_extraction_unavailable',
        invalid.eventId,
        '消した出典の読み取り内容を検査できない。',
      );
    } else {
      report.violation('invalid_extraction', invalid.eventId, '読み取り結果の型が不正。');
    }
  }
  const retired = new Set<string>();
  for (const sourceId of new Set([...withdrawnSources, ...purgedSources])) {
    for (const id of declaredBySource.get(sourceId) ?? []) retired.add(id);
  }
  const extracted = [...latestBySource.values()]
    .filter((entry) => !purgedSources.has(entry.sourceId))
    .sort((a, b) => a.sourceSeq - b.sourceSeq);
  const staleItems = new Set<string>();
  const staleUnknowns = new Set<string>();
  for (const extraction of extracted) {
    const currentVersion = sources.get(extraction.sourceId)?.source.version;
    if (currentVersion !== undefined && extraction.sourceVersion < currentVersion) {
      for (const entry of extraction.items) staleItems.add(entry.id);
      for (const entry of extraction.unknowns) staleUnknowns.add(entry.id);
    }
  }
  // 再読は通知を新しくしない。家族の後の答えを、再読しただけで上書きしない。
  for (const extraction of extracted) {
    for (const item of extraction.items) {
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
    for (const raw of extraction.items) {
      if (items.has(raw.id))
        report.violation('duplicate_item', raw.id, '事項の ID が重複している。');
      const correction = corrections.get(raw.id);
      const item: Item = {
        ...raw,
        ...(correction ? { interpretation: { ...raw.interpretation, ...correction } } : {}),
        ...(verdicts.get(raw.id) === 'confirmed' ? { evidence: 'confirmed' } : {}),
      };
      items.set(raw.id, item);
      itemSeq.set(raw.id, extraction.sourceSeq);
    }
    if (withdrawnSources.has(extraction.sourceId)) continue;
    for (const node of extraction.conditions) {
      if (nodes.has(node.id)) {
        report.violation('duplicate_condition', node.id, '条件の ID が重複している。');
        invalidNodes.add(node.id);
      }
      nodes.set(node.id, node);
    }
    for (const unknown of extraction.unknowns) {
      if (retired.has(unknown.id)) continue;
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
    if (withdrawnSources.has(extraction.sourceId)) continue;
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
      if (
        problem.problem === 'undeclaredUnknown' &&
        (retired.has(problem.detail ?? '') || purgedSources.size > 0)
      ) {
        report.undetermined(
          'condition_source_unavailable',
          problem.nodeId,
          '条件の出典を確認できない。',
        );
      } else {
        report.violation('invalid_condition', problem.nodeId, '条件の参照・値・循環が不正。');
      }
    }
  }
  // 未定値ごとに、最後に効く可能性のある答えを列挙する。条件が不明なら「効く」と「効かない」の両方を
  // 残す。値の集合を全候補から徐々に絞るので、出典の後に家族が条件へ答えても作用を再評価できる。
  type Candidate = { value: string; seq: number; order: number; item?: Item; validity?: Truth };
  const candidates = new Map<string, Candidate[]>();
  const inapplicableAnswers = new Set<number>();
  let order = 0;
  const addCandidate = (id: string, candidate: Candidate) => {
    const list = candidates.get(id) ?? [];
    list.push(candidate);
    candidates.set(id, list);
  };
  for (const event of events) {
    if (event.type === 'answered') {
      if (retired.has(event.unknownId)) continue;
      if (purgedSources.size > 0 && !unknowns.has(event.unknownId)) {
        report.undetermined(
          'answer_source_unverified',
          event.unknownId,
          '答えの出典を確認できない。',
        );
        continue;
      }
      let validity: Truth = true;
      const unknown = unknowns.get(event.unknownId);
      if (unknown?.kind === 'family') {
        // 以前の答えに問いの控えがあれば、今と明らかに違う名前・候補・事項には当てない。
        // 中身を比較できない控えや、その後の読み直し等で条件が変わったか不明な時は決めつけない。
        let about: unknown;
        if (event.about !== undefined) {
          try {
            about = JSON.parse(event.about) as unknown;
          } catch {
            about = undefined;
          }
        }
        const snapshot =
          about && typeof about === 'object' && !Array.isArray(about)
            ? (about as Record<string, unknown>)
            : undefined;
        if (snapshot && typeof snapshot.label === 'string' && Array.isArray(snapshot.values)) {
          if (snapshot.label !== unknown.label || !sameValue(snapshot.values, unknown.values)) {
            validity = false;
          } else if (Array.isArray(snapshot.items)) {
            for (const entry of snapshot.items) {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                validity = 'unknown';
                break;
              }
              const saved = entry as Record<string, unknown>;
              const current = typeof saved.id === 'string' ? items.get(saved.id) : undefined;
              if (!current) {
                validity = 'unknown';
                break;
              }
              if (
                saved.kind !== current.kind ||
                saved.written !== current.written ||
                !sameValue(saved.interpretation, current.interpretation)
              ) {
                validity = false;
                break;
              }
              // 控えが単純な等式で、今も単純な等式なら、値や対象の違いを独立に確かめられる。
              // 複雑な式や読めない控えの同値性は決めつけない。
              if (typeof saved.condition === 'string' && current.conditionNodeId) {
                try {
                  const previous = JSON.parse(saved.condition) as unknown;
                  const node = nodes.get(current.conditionNodeId);
                  if (
                    Array.isArray(previous) &&
                    previous.length === 3 &&
                    previous[0] === 'eq' &&
                    node?.kind === 'eq' &&
                    (previous[1] !== node.unknownId || previous[2] !== node.value)
                  ) {
                    validity = false;
                    break;
                  }
                } catch {
                  validity = 'unknown';
                }
              }
            }
          } else {
            validity = 'unknown';
          }
        } else if (event.about !== undefined) {
          validity = 'unknown';
        }
        if (
          validity === true &&
          events.some(
            (later) =>
              later.seq > event.seq &&
              (later.type === 'modelOutputRecorded' ||
                later.type === 'itemCorrected' ||
                later.type === 'transcriptionCorrected' ||
                later.type === 'sourceWithdrawn' ||
                later.type === 'sourceContentPurged'),
          )
        )
          validity = 'unknown';
        if (staleUnknowns.has(event.unknownId) && validity === true) validity = 'unknown';
        if (validity === 'unknown')
          report.undetermined(
            'family_answer_basis_unverified',
            event.unknownId,
            '前の答えが今の問いにも当てはまるか確認できない。',
          );
        if (validity === false) inapplicableAnswers.add(event.seq);
      }
      addCandidate(event.unknownId, {
        value: event.value,
        seq: event.seq,
        order: order++,
        validity,
      });
    }
  }
  for (const extraction of extracted) {
    for (const raw of extraction.items) {
      const item = items.get(raw.id);
      if (!item) continue;
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
    for (const raw of extraction.items) {
      const item = items.get(raw.id);
      if (!item) continue;
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
    if (withdrawnSources.has(item.sourceId) || verdicts.get(item.id) === 'dismissed') return false;
    if (staleItems.has(item.id)) return 'unknown';
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
        const truth: Truth = candidate.item
          ? sourceActivity(candidate.item)
          : (candidate.validity ?? true);
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
    for (const raw of extraction.items) {
      const item = items.get(raw.id);
      if (!item) continue;
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
  return {
    items,
    sourceReadingSeq: new Map(extracted.map((entry) => [entry.sourceId, entry.seq])),
    sourceSenders: new Map(
      [...sources]
        .filter(([id]) => !purgedSources.has(id))
        .map(([id, entry]) => [id, entry.source.sender]),
    ),
    sourceSentences: new Map(
      [...sources]
        .filter(([id]) => !purgedSources.has(id))
        .map(([id, entry]) => [
          id,
          new Map(entry.source.sentences.map((sentence) => [sentence.id, sentence.text])),
        ]),
    ),
    active,
    unknowns,
    resolvedValues: assignments,
    inapplicableAnswers,
    conditions: nodes,
    changes: itemChanges,
    staleItems,
    staleUnknowns,
    corrections,
    turns,
    escorts,
  };
}
