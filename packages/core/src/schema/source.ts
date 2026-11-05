// 出典・事項・未定の値・条件の式（docs/design/01-model.md §3）。
// 事項は、どの文から（文 ID）、どの条件の時に、どれだけ確かか（証拠の状態）を持つ。
import { z } from 'zod';
import { DateTime, LocalDate, LocalTime, Weekday } from '../time';
import { Id, Language } from './household';

export const SourceSender = z.enum([
  'school',
  'nursery',
  'afterSchoolCare',
  /** 習い事・塾・スポーツのクラブ。 */
  'club',
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
  /** 届いた形。photo なら、文は写真から書き起こした物（家族が写真と並べて確かめる）。 */
  medium: z.enum(['text', 'photo']).default('text'),
  sentences: z.array(Sentence).min(1),
  /** 訂正なら、元の出典。 */
  correctsSourceId: Id.optional(),
});
export type Source = z.infer<typeof Source>;

/** 証拠の状態。推定と食い違いは、家族が確かめるまで必須の要件を作らない（§3）。 */
export const EvidenceState = z.enum(['stated', 'confirmed', 'inferred', 'conflicting']);
export type EvidenceState = z.infer<typeof EvidenceState>;

export const ItemKind = z.enum([
  /** 行事・試合・発表会（学習発表会、サッカーの練習試合）。 */
  'event',
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
  /** テスト・小テスト・検定（漢字テスト）。 */
  'test',
  /** 宿題と、家の人のサイン（音読カード）。 */
  'homework',
  /** 当番（お茶当番、配車、係）。 */
  'duty',
  /** 配られたプリント（「おてがみ 1まい」のように、枚数だけ書かれた物）。 */
  'handout',
  /**
   * 通用の「すること」：ほかの種類に入らず、家族の行動が要る事（家族の言明も同じ形）。形（shape）で、締切まで
   * に済ませる事か、窓の間だれか・どこかが受け持つ事かを分ける。場面の種類ではない。
   */
  'need',
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
  /**
   * 締切の時刻が、指した文に見つからない（「12月4日まで」。書き方を読み取れなかった時もある）。deadline の
   * 時刻は、その日の朝の目安（仕組みが決めた物）で、画面は日だけを見せる。false は、家族が直して時刻を入れた
   * 印（読み取りの「日だけ」を、直しで外す。直しは前の欄に重ねるので、消すには false が要る）。
   */
  deadlineDayOnly: z.boolean().optional(),
  /**
   * 読み取りの始まりの時刻が、指した文に見つからず、落とした（書き方を読み取れなかっただけで、時刻は
   * 書かれているかもしれない）。画面は「書かれていない」と言わず、元の文で確かめてもらう。
   */
  startTimeUnconfirmed: z.literal(true).optional(),
  /**
   * 読み取りの終わりの時刻が、指した文に見つからず、落とした（startTimeUnconfirmed と同じ。送り迎えの迎えは、
   * 「時刻は書かれていない」と言わず、元の文で確かめてもらう）。
   */
  endTimeUnconfirmed: z.literal(true).optional(),
  /** 対象（例：1年生、陽菜さん・ゆいさんのおうち）。 */
  audience: z.string().optional(),
  /** 書かれた場所（例：若洲のグラウンド）。 */
  place: z.string().optional(),
  /** 「あした」「きょう」のように書かれていた時。日付はコードが、出典の日から決める。 */
  relativeDay: z.enum(['today', 'tomorrow']).optional(),
  /**
   * 家の人がすること（音読カードのサイン、丸つけ、お茶当番、配車）。宿題（homework）と当番（duty）で、
   * これがある物だけを家族の作業にする。子どもだけでする宿題や子の当番には無い（読んだだけ）。
   */
  familyAction: z.literal(true).optional(),
  /**
   * 「すること」（need）の形。by：締切（deadline）までに済ませる。window：日（date）の始まり–終わり（startTime–
   * endTime）の間、だれか・どこかが受け持つ。一つの「すること」はどちらか一つ。
   */
  shape: z.enum(['by', 'window']).optional(),
  /**
   * 「すること」がだれのためか（家庭の成員の ID。家族が選んだ時だけ。原文の audience とは別に持つ）。選んで
   * いない・一人に決まらない時は無い（分からない）。替われば、前の選び・引き受け・返事を当てない。
   */
  forMemberId: z.string().min(1).optional(),
  /**
   * 窓の「すること」で、窓の間ずっと、だれかが受け持つ必要があるか（家族が言う）。子を見てもらう等は要る（true）。
   * 練習や集まりの時間のように、その事が起きる時間というだけなら要らない（false）。無いのは古い事象か読み取りで、
   * 要るとして扱う（今までの意味）。無い時に値を補って書かない（控えの要約の形を変えない）。要らない時は、
   * 受け持ちの確かめ（覆う）をしない。人数の答え・場所が使えるか・申し込みが通ったかは、別の事実のまま。
   */
  holdNeeded: z.boolean().optional(),
});
export type Interpretation = z.infer<typeof Interpretation>;

/**
 * 家族の直し（correctItem・itemCorrected）の欄。直しは前の欄に重ねるので、「だれのため」を外すには null が要る
 * （null は、読み取りと前の直しの forMemberId を外す。事項の解釈には null を残さない）。
 */
export const CorrectedInterpretation = Interpretation.extend({
  forMemberId: z.string().min(1).nullable().optional(),
});
export type CorrectedInterpretation = z.infer<typeof CorrectedInterpretation>;

/** 直しを解釈に重ねる（null の「だれのため」は外す）。 */
export function applyCorrection(
  base: Interpretation,
  correction: CorrectedInterpretation,
): Interpretation {
  const { forMemberId, ...rest } = { ...base, ...correction };
  return forMemberId === null || forMemberId === undefined ? rest : { ...rest, forMemberId };
}

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
  /**
   * 家族に確かめてほしい文：事項にならなかった文、検査で外した・食い違った事項の文、二通りに読める文。
   * ここに無い文も、読み取りが正しいとは限らない（文が事項に結ばれただけ）。無いのは古い形。
   */
  checkSentenceIds: z.array(Id).optional(),
  /** どの文の問題か分からない物があった（出典の全体を確かめてもらう）。無いのは false。 */
  checkAll: z.boolean().optional(),
});
export type Extraction = z.infer<typeof Extraction>;
