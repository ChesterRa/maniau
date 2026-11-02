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
  addDays,
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
    /** 「あした」「きょう」から決めた日付と、モデルの日付が違う。 */
    | 'relativeDayMismatch'
    | 'badTime'
    | 'badCondition'
    | 'unknownEffectTarget'
    | 'duplicateId'
    /** 書かれた表現が、指した文に無い（原文に無い言葉を根拠にしている）。 */
    | 'quoteMismatch'
    /** 指した文に日付が書かれているのに、モデルの日付・期限がどれとも合わない。 */
    | 'dateMismatch';
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
  // 同じ ID を二度宣言した未定の値と条件の節点は、どちらも使わない（どちらかを選ぶと、確かめる時と
  // 答える時で別の宣言を使いかねない）。それに頼る条件と事項は、下の検査で外れ、全体を確かめてもらう。
  const repeated = (ids: readonly string[]) =>
    new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
  const twiceUnknowns = repeated(output.unknowns.map((u) => u.id));
  const twiceNodes = repeated(output.conditions.map((c) => c.id));
  for (const id of [...twiceUnknowns, ...twiceNodes]) {
    issues.push({ problem: 'duplicateId', ref: local(id) });
  }
  const declaredUnknowns = output.unknowns.filter((u) => !twiceUnknowns.has(u.id));
  const declaredConditions = output.conditions.filter((c) => !twiceNodes.has(c.id));
  const localUnknowns = new Map(declaredUnknowns.map((u) => [u.id, local(u.id)]));
  const localNodes = new Map(declaredConditions.map((c) => [c.id, local(c.id)]));
  const priorItemIds = new Set(context.priorItems.map((i) => i.id));
  const unknownId = (id: string) =>
    localUnknowns.get(id) ?? (context.priorUnknowns.some((u) => u.id === id) ? id : undefined);

  const unknowns: Unknown[] = declaredUnknowns
    .filter((u) => u.values.length >= 2)
    .map((u) => ({ id: local(u.id), label: u.label, values: u.values, kind: u.kind }));

  const conditions: ConditionNode[] = [];
  for (const c of declaredConditions) {
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
    // 「あした」は、出典が届いた日の次の日（暦どおり。習い事の金曜の連絡の「あした」は土曜）。
    // 「きょう」は届いた日。書かれた曜日と食い違えば、下で「食い違い」にして家族に確かめてもらう。
    const relativeDay = raw.relativeDay === 'none' ? undefined : raw.relativeDay;
    const receivedOn = localDateOf(
      toEpochMinutes(source.receivedAt),
      context.timeZone ?? 'Asia/Tokyo',
    );
    // 相対の言い方があれば、日付はコードが決める。モデルが別の日付を返したら、取らずに「食い違い」にする
    // （プロンプトで date を空にさせても、守られるとは限らないため）。
    const relativeDate =
      relativeDay === 'tomorrow'
        ? addDays(receivedOn, 1)
        : relativeDay === 'today'
          ? receivedOn
          : null;
    if (relativeDate !== null && raw.date !== null && raw.date !== relativeDate) {
      issues.push({ problem: 'relativeDayMismatch', ref: id, detail: raw.date });
      evidence = 'conflicting';
    }
    const date = relativeDate ?? raw.date;
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
    // 書かれた表現は、指した文の中にそのまま有るはず（空白と全角・半角の違いだけ許す）。無ければ、原文に
    // 無い言葉を根拠にしている。外さずに「食い違い」にして家族に確かめてもらい、作用（取り消し・置き換え）
    // も確かめるまで効かせない。合っても、解釈が正しいことまでは言えない。
    // 指した文は、原文の順につなぐ（モデルが文を逆の順に挙げても、引用の続きが切れないように）。
    const cited = quoteForm(
      source.sentences
        .filter((s) => raw.sentenceIds.includes(s.id))
        .map((s) => s.text)
        .join(''),
    );
    const quote = quoteForm(raw.written);
    if (quote === '' || !cited.includes(quote)) {
      issues.push({ problem: 'quoteMismatch', ref: id });
      evidence = 'conflicting';
    }
    // 指した文に「12月5日」「8日」「12/5」と書かれていれば、モデルの日付と期限の日は、そのどれかと合うはず
    // （曜日の同じ別の週に読み違えるのを、曜日の検査は見つけない）。合っても、正しく読めたとまでは言えない。
    const mentioned = writtenDates(cited);
    const read = [date, raw.deadline?.slice(0, 10) ?? null].filter((d) => d !== null);
    const unmentioned = read.find((d) => !mentioned.some((m) => sameDay(m, d)));
    if (mentioned.length > 0 && unmentioned !== undefined) {
      issues.push({ problem: 'dateMismatch', ref: id, detail: unmentioned });
      evidence = 'conflicting';
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

  const ambiguous = output.ambiguities.filter((a) => sentenceIds.has(a.sentenceId));
  // 説明の空の「二通りに読める」も、その文は確かめてもらう（説明の無い物は、説明の一覧に入れない）。
  const { checkSentenceIds, checkAll } = toCheck(issues, output, source, ambiguous);
  const ambiguities = ambiguous.filter((a) => a.note.trim() !== '');
  const extraction = Extraction.parse({
    sourceId: source.id,
    items,
    unknowns,
    conditions: conditions.filter((c) => !badNodes.has(c.id)),
    irrelevantSentenceIds: irrelevant,
    ambiguities,
    checkSentenceIds,
    checkAll,
  });
  return { extraction, issues };
}

/** 文に書かれた日付（月と日、または日だけ）。「12月5日」「8日」「12/5」。 */
function writtenDates(text: string): { month?: number; day: number }[] {
  const found: { month?: number; day: number }[] = [];
  for (const m of text.matchAll(/(?:(\d{1,2})月)?(\d{1,2})日/g)) {
    found.push({ ...(m[1] ? { month: Number(m[1]) } : {}), day: Number(m[2]) });
  }
  for (const m of text.matchAll(/(\d{1,2})\/(\d{1,2})/g)) {
    found.push({ month: Number(m[1]), day: Number(m[2]) });
  }
  return found;
}

const sameDay = (mention: { month?: number; day: number }, date: string) =>
  Number(date.slice(8, 10)) === mention.day &&
  (mention.month === undefined || Number(date.slice(5, 7)) === mention.month);

/** 引用を比べる形：全角・半角をそろえ、空白を除く。 */
const quoteForm = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

/**
 * 問題を、家族が原文で確かめる文に戻す。事項の問題は、モデルの出力のその事項の文へ（外した事項の文も、
 * 同じ文から別の事項が取れていても）。文へ戻せない問題（節点だけの条件の誤り、文の無い事項）は、全体を
 * 確かめてもらう。
 */
function toCheck(
  issues: readonly ReadingIssue[],
  output: ExtractionOutput,
  source: Source,
  ambiguities: readonly { sentenceId: string }[],
): { checkSentenceIds: string[]; checkAll: boolean } {
  const sentenceIds = new Set(source.sentences.map((s) => s.id));
  const check = new Set<string>();
  let checkAll = false;
  for (const issue of issues) {
    if (issue.problem === 'uncoveredSentence') {
      check.add(issue.ref);
      continue;
    }
    const sentences = output.items
      .filter((raw) => `${source.id}:${raw.id}` === issue.ref)
      .flatMap((raw) => raw.sentenceIds)
      .filter((s) => sentenceIds.has(s));
    if (sentences.length === 0) checkAll = true;
    for (const s of sentences) check.add(s);
  }
  for (const a of ambiguities) check.add(a.sentenceId);
  // 原文の順に並べる。
  const checkSentenceIds = source.sentences.map((s) => s.id).filter((id) => check.has(id));
  return { checkSentenceIds, checkAll };
}
