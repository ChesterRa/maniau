// 出典・事項・未定の値・条件の式（docs/design/01-model.md §3）。
// 事項は、どの文から（文 ID）、どの条件の時に、どれだけ確かか（証拠の状態）を持つ。
import { z } from 'zod';
import { DateTime, LocalDate, LocalTime, Weekday } from '../time';
import { Id, Language } from './household';

export const SourceSender = z.enum([
  'school',
  'nursery',
  'afterSchoolCare',
  'workplace',
  'family',
  'other',
]);
export type SourceSender = z.infer<typeof SourceSender>;

export const Sentence = z.object({
  /** 出典の中で一意（例：n1#3）。 */
  id: Id,
  text: z.string().min(1),
});
export type Sentence = z.infer<typeof Sentence>;

/** お知らせ等。原文はいつも残す。訳を出すなら訳と示す（§13）。 */
export const Source = z.object({
  id: Id,
  version: z.number().int().positive(),
  receivedAt: DateTime,
  sender: SourceSender,
  senderPlaceId: Id.optional(),
  /** 原文の言葉。 */
  language: Language,
  title: z.string().optional(),
  sentences: z.array(Sentence).min(1),
  /** 訂正なら、元の出典。 */
  correctsSourceId: Id.optional(),
});
export type Source = z.infer<typeof Source>;

/** 証拠の状態。推定と食い違いは、家族が確かめるまで必須の要件を作らない（§3）。 */
export const EvidenceState = z.enum(['stated', 'confirmed', 'inferred', 'conflicting']);
export type EvidenceState = z.infer<typeof EvidenceState>;

export const ItemKind = z.enum([
  /** 行事（学習発表会）。 */
  'schoolEvent',
  /** 持ち物・用意する物（白い長袖シャツ）。 */
  'belongings',
  /** 提出物。 */
  'submission',
  /** 日課の変更（振替休業日、通常授業、短縮授業）。 */
  'dayChange',
  /** 締切。 */
  'deadline',
  /** 問い合わせ先。 */
  'contact',
]);
export type ItemKind = z.infer<typeof ItemKind>;

export const DayType = z.enum(['noSchool', 'normalSchool', 'shortDay', 'eventDay']);
export type DayType = z.infer<typeof DayType>;

/** 書かれた表現の解釈。種類ごとに使う欄が違う（平らにして、構造化出力にも合わせる）。 */
export const Interpretation = z.object({
  date: LocalDate.optional(),
  /** 原文に曜日が書いてあれば、その曜日（月曜が 1）。書いていなければ無い（作らない）。 */
  writtenWeekday: Weekday.optional(),
  startTime: LocalTime.optional(),
  endTime: LocalTime.optional(),
  /** 行事や品物の名前（原文の言葉）。 */
  what: z.string().optional(),
  dayType: DayType.optional(),
  deadline: DateTime.optional(),
  /** 対象（例：1年生）。 */
  audience: z.string().optional(),
});
export type Interpretation = z.infer<typeof Interpretation>;

/** 前の事項への作用（変更の連絡）。ID で返させ、コードが実在を確かめる（§4）。 */
export const Effect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resolveUnknown'), unknownId: Id, value: z.string().min(1) }),
  z.object({ type: z.literal('replace'), itemId: Id }),
  z.object({ type: z.literal('cancel'), itemId: Id }),
]);
export type Effect = z.infer<typeof Effect>;

export const Item = z.object({
  id: Id,
  sourceId: Id,
  sentenceIds: z.array(Id).min(1),
  kind: ItemKind,
  /** 書かれたままの表現。 */
  written: z.string().min(1),
  interpretation: Interpretation,
  /** 適用の条件（条件の式の根の節点）。無ければ、いつも適用。 */
  conditionNodeId: Id.optional(),
  evidence: EvidenceState,
  /** 前の事項への作用。 */
  effects: z.array(Effect).default([]),
});
export type Item = z.infer<typeof Item>;

/** 未定の値（分かれ目）。例：発表会の実施日 ∈ {2026-12-05, 2026-12-08}。 */
export const Unknown = z.object({
  id: Id,
  label: z.string().min(1),
  values: z.array(z.string().min(1)).min(2),
  kind: z.enum(['schedule', 'atHome', 'family', 'other']),
});
export type Unknown = z.infer<typeof Unknown>;

/**
 * 条件の式の節点。構造化出力は再帰の schema を受けないので、平らな一覧で持つ（§3）。
 * 子は ID で指す。参照・循環・宣言の無い値は validateConditions が見つける。
 */
export const ConditionNode = z.discriminatedUnion('kind', [
  z.object({ id: Id, kind: z.literal('eq'), unknownId: Id, value: z.string().min(1) }),
  z.object({ id: Id, kind: z.literal('and'), childIds: z.array(Id).min(2) }),
  z.object({ id: Id, kind: z.literal('or'), childIds: z.array(Id).min(2) }),
  z.object({ id: Id, kind: z.literal('not'), childId: Id }),
]);
export type ConditionNode = z.infer<typeof ConditionNode>;

/** 一つの出典を読んだ結果（モデルの出力を、コードが検査した後の形）。 */
export const Extraction = z.object({
  sourceId: Id,
  items: z.array(Item),
  unknowns: z.array(Unknown),
  conditions: z.array(ConditionNode),
  /** どの事項にも入らない文（挨拶など）。文の網羅を確かめるのに使う（§9）。 */
  irrelevantSentenceIds: z.array(Id),
  /** 二通りに読める所。未定の値として足すか、問いにする。 */
  ambiguities: z.array(z.object({ sentenceId: Id, note: z.string().min(1) })).default([]),
});
export type Extraction = z.infer<typeof Extraction>;
