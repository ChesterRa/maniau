// 読み取りの、モデルに返させる形（構造化出力）と、コードの検査（docs/design/01-model.md §1 の3、§10）。
// 構造化出力は、再帰・数の範囲・文字数の制約を受けないので、モデルに返させる形は平らにし、
// 日付・文 ID・参照・条件は、ここで確かめる。通らない物は捨てずに「問題」として残し、家族に見せる。
import { z } from 'zod';
import { validateConditions } from '../schema/condition';
import {
  type ConditionNode,
  DayType,
  type Effect,
  Extraction,
  type Item,
  ItemKind,
  type Source,
  type Unknown,
} from '../schema/source';
import {
  addBusinessDays,
  isValidDateTime,
  isValidLocalDate,
  localDateOf,
  toEpochMinutes,
  weekdayOf,
} from '../time';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** モデルに返させる形。欄はすべて必須で、無い時は null。 */
export const ExtractionOutput = z.object({
  items: z.array(
    z.object({
      id: z.string().describe('この出典の中の事項の ID（例：i1）'),
      sentenceIds: z.array(z.string()).describe('根拠の文 ID（与えた文の ID だけ）'),
      kind: ItemKind,
      written: z.string().describe('原文のまま'),
      date: z.string().nullable().describe('YYYY-MM-DD。書かれていなければ null'),
      writtenWeekday: z.enum([...WEEKDAYS, 'none']).describe('原文に書かれた曜日。無ければ none'),
      startTime: z.string().nullable().describe('HH:MM'),
      endTime: z.string().nullable().describe('HH:MM'),
      what: z.string().nullable().describe('行事・品物・宛先の名前（原文の言葉）'),
      dayType: DayType.nullable(),
      deadline: z.string().nullable().describe('締切。YYYY-MM-DDTHH:MM+09:00'),
      audience: z.string().nullable(),
      place: z.string().nullable().describe('書かれた場所。無ければ null'),
      relativeDay: z
        .enum(['none', 'today', 'tomorrow'])
        .describe('「あした」「きょう」と書かれ、日付が無い時。日付はコードが決める'),
      conditionNodeId: z.string().nullable().describe('適用の条件の根の節点の ID'),
      inferred: z.boolean().describe('原文に書かれておらず推定した事なら true'),
      effects: z.array(
        z.object({
          type: z.enum(['resolveUnknown', 'replace', 'cancel']),
          unknownId: z.string().nullable(),
          value: z.string().nullable(),
          itemId: z.string().nullable().describe('前の出典の事項の ID（与えた物だけ）'),
        }),
      ),
    }),
  ),
  unknowns: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      values: z.array(z.string()),
      kind: z.enum(['schedule', 'atHome', 'family', 'other']),
    }),
  ),
  conditions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['eq', 'and', 'or', 'not']),
      unknownId: z.string().nullable(),
      value: z.string().nullable(),
      childIds: z.array(z.string()),
    }),
  ),
  irrelevantSentenceIds: z.array(z.string()),
  ambiguities: z.array(z.object({ sentenceId: z.string(), note: z.string() })),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export interface ReadingIssue {
  problem:
    | 'unknownSentence'
    | 'uncoveredSentence'
    | 'badDate'
    | 'weekdayMismatch'
    | 'badTime'
    | 'badCondition'
    | 'unknownEffectTarget'
    | 'duplicateId';
  ref: string;
  detail?: string;
}

export interface ReadingContext {
  /** 前の出典の、今の事項（変更の連絡の作用が指してよい物）。 */
  priorItems: readonly Item[];
  /** 前の出典で宣言された未定の値。 */
  priorUnknowns: readonly Unknown[];
  /** 家族の時区（「あした」を日付にする時の、届いた日を決める）。無ければ Asia/Tokyo。 */
  timeZone?: string;
}

/**
 * モデルの出力を、検査を通った読み取りにする。事項の ID には出典の ID を前に付け、出典をまたいで重ならないようにする。
 * 日付と曜日の食い違いは、事項を「食い違い」にして残す（家族に確かめる）。参照の誤りは、その事項を外して問題に残す。
 */
export function toExtraction(
  output: ExtractionOutput,
  source: Source,
  context: ReadingContext,
): { extraction: Extraction; issues: ReadingIssue[] } {
  const issues: ReadingIssue[] = [];
  const sentenceIds = new Set(source.sentences.map((s) => s.id));
  const local = (id: string) => `${source.id}:${id}`;
  const localUnknowns = new Map(output.unknowns.map((u) => [u.id, local(u.id)]));
  const localNodes = new Map(output.conditions.map((c) => [c.id, local(c.id)]));
  const priorItemIds = new Set(context.priorItems.map((i) => i.id));
  const unknownId = (id: string) =>
    localUnknowns.get(id) ?? (context.priorUnknowns.some((u) => u.id === id) ? id : undefined);

  const unknowns: Unknown[] = output.unknowns
    .filter((u) => u.values.length >= 2)
    .map((u) => ({ id: local(u.id), label: u.label, values: u.values, kind: u.kind }));

  const conditions: ConditionNode[] = [];
  for (const c of output.conditions) {
    const id = local(c.id);
    if (c.kind === 'eq') {
      const target = c.unknownId === null ? undefined : unknownId(c.unknownId);
      if (target === undefined || c.value === null) {
        issues.push({ problem: 'badCondition', ref: id, detail: '未定の値か値が無い' });
        continue;
      }
      conditions.push({ id, kind: 'eq', unknownId: target, value: c.value });
    } else if (c.kind === 'not') {
      const child = c.childIds[0];
      if (child === undefined || c.childIds.length !== 1) {
        issues.push({ problem: 'badCondition', ref: id, detail: 'not の子は一つ' });
        continue;
      }
      conditions.push({ id, kind: 'not', childId: localNodes.get(child) ?? local(child) });
    } else {
      if (c.childIds.length < 2) {
        issues.push({ problem: 'badCondition', ref: id, detail: `${c.kind} の子は二つ以上` });
        continue;
      }
      conditions.push({
        id,
        kind: c.kind,
        childIds: c.childIds.map((child) => localNodes.get(child) ?? local(child)),
      });
    }
  }
  const allUnknowns = [...context.priorUnknowns, ...unknowns];
  for (const problem of validateConditions(conditions, allUnknowns)) {
    issues.push({ problem: 'badCondition', ref: problem.nodeId, detail: problem.problem });
  }
  const badNodes = new Set(issues.filter((i) => i.problem === 'badCondition').map((i) => i.ref));
  // 使えない節点を子に持つ節点も使えない（祖先へ広げる）。広げないと、使える根から消えた節点をたどる。
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of conditions) {
      if (badNodes.has(node.id)) continue;
      const children =
        node.kind === 'not' ? [node.childId] : node.kind === 'eq' ? [] : node.childIds;
      if (children.some((child) => badNodes.has(child))) {
        badNodes.add(node.id);
        issues.push({ problem: 'badCondition', ref: node.id, detail: '使えない子を持つ' });
        changed = true;
      }
    }
  }

  const items: Item[] = [];
  const seen = new Set<string>();
  for (const raw of output.items) {
    const id = local(raw.id);
    if (seen.has(id)) {
      issues.push({ problem: 'duplicateId', ref: id });
      continue;
    }
    seen.add(id);
    const unknownSentences = raw.sentenceIds.filter((s) => !sentenceIds.has(s));
    if (unknownSentences.length > 0 || raw.sentenceIds.length === 0) {
      issues.push({ problem: 'unknownSentence', ref: id, detail: unknownSentences.join(',') });
      continue;
    }
    let evidence: Item['evidence'] = raw.inferred ? 'inferred' : 'stated';
    if (raw.date !== null && !isValidLocalDate(raw.date)) {
      issues.push({ problem: 'badDate', ref: id, detail: raw.date });
      continue;
    }
    if (raw.deadline !== null && !isValidDateTime(raw.deadline)) {
      issues.push({ problem: 'badDate', ref: id, detail: raw.deadline });
      continue;
    }
    const times = [raw.startTime, raw.endTime].filter((t) => t !== null);
    if (times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      issues.push({ problem: 'badTime', ref: id, detail: times.join(',') });
      continue;
    }
    // 「あした」は、出典が届いた日の次の登校日（土日・祝日を飛ばす）。「きょう」は届いた日。
    const relativeDay = raw.relativeDay === 'none' ? undefined : raw.relativeDay;
    const receivedOn = localDateOf(
      toEpochMinutes(source.receivedAt),
      context.timeZone ?? 'Asia/Tokyo',
    );
    const date =
      raw.date ??
      (relativeDay === 'tomorrow'
        ? addBusinessDays(receivedOn, 1)
        : relativeDay === 'today'
          ? receivedOn
          : null);
    const writtenWeekday =
      raw.writtenWeekday === 'none' ? undefined : WEEKDAYS.indexOf(raw.writtenWeekday) + 1;
    if (date !== null && writtenWeekday !== undefined && weekdayOf(date) !== writtenWeekday) {
      issues.push({ problem: 'weekdayMismatch', ref: id, detail: date });
      evidence = 'conflicting';
    }
    const condition = raw.conditionNodeId === null ? undefined : local(raw.conditionNodeId);
    if (
      condition !== undefined &&
      (!localNodes.has(raw.conditionNodeId ?? '') || badNodes.has(condition))
    ) {
      issues.push({ problem: 'badCondition', ref: id, detail: raw.conditionNodeId ?? '' });
      continue;
    }
    const effects: Effect[] = [];
    let effectsOk = true;
    for (const e of raw.effects) {
      if (e.type === 'resolveUnknown') {
        const target = e.unknownId === null ? undefined : unknownId(e.unknownId);
        const declared = allUnknowns.find((u) => u.id === target);
        if (!target || e.value === null || !declared?.values.includes(e.value)) {
          effectsOk = false;
          break;
        }
        effects.push({ type: 'resolveUnknown', unknownId: target, value: e.value });
      } else {
        if (e.itemId === null || !priorItemIds.has(e.itemId)) {
          effectsOk = false;
          break;
        }
        effects.push({ type: e.type, itemId: e.itemId });
      }
    }
    if (!effectsOk) {
      issues.push({ problem: 'unknownEffectTarget', ref: id });
      continue;
    }
    items.push({
      id,
      sourceId: source.id,
      sentenceIds: raw.sentenceIds,
      kind: raw.kind,
      written: raw.written,
      interpretation: {
        ...(date === null ? {} : { date }),
        ...(writtenWeekday === undefined ? {} : { writtenWeekday }),
        ...(raw.startTime === null ? {} : { startTime: raw.startTime }),
        ...(raw.endTime === null ? {} : { endTime: raw.endTime }),
        ...(raw.what === null ? {} : { what: raw.what }),
        ...(raw.dayType === null ? {} : { dayType: raw.dayType }),
        ...(raw.deadline === null ? {} : { deadline: raw.deadline }),
        ...(raw.audience === null ? {} : { audience: raw.audience }),
        ...(raw.place === null ? {} : { place: raw.place }),
        ...(relativeDay === undefined ? {} : { relativeDay }),
      },
      ...(condition === undefined ? {} : { conditionNodeId: condition }),
      evidence,
      effects,
    });
  }

  const irrelevant = output.irrelevantSentenceIds.filter((s) => sentenceIds.has(s));
  const covered = new Set([...items.flatMap((i) => i.sentenceIds), ...irrelevant]);
  for (const sentence of source.sentences) {
    if (!covered.has(sentence.id)) issues.push({ problem: 'uncoveredSentence', ref: sentence.id });
  }

  const extraction = Extraction.parse({
    sourceId: source.id,
    items,
    unknowns,
    conditions: conditions.filter((c) => !badNodes.has(c.id)),
    irrelevantSentenceIds: irrelevant,
    ambiguities: output.ambiguities.filter((a) => sentenceIds.has(a.sentenceId)),
  });
  return { extraction, issues };
}
