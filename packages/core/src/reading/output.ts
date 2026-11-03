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
  formatDateTime,
  isValidDateTime,
  isValidLocalDate,
  localDateOf,
  toEpochMinutes,
  weekdayOf,
  zonedToEpochMinutes,
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
      deadline: z
        .string()
        .nullable()
        .describe(
          '締切。時刻が書かれていれば YYYY-MM-DDTHH:MM+09:00、日だけなら YYYY-MM-DD（書かれていない時刻を付けない）',
        ),
      audience: z.string().nullable(),
      place: z.string().nullable().describe('書かれた場所。無ければ null'),
      relativeDay: z
        .enum(['none', 'today', 'tomorrow'])
        .describe('「あした」「きょう」と書かれ、日付が無い時。日付はコードが決める'),
      conditionNodeId: z.string().nullable().describe('適用の条件の根の節点の ID'),
      inferred: z.boolean().describe('原文に書かれておらず推定した事なら true'),
      familyAction: z
        .boolean()
        .describe(
          '宿題・当番で、家の人がすること（サイン、丸つけ、お茶当番、配車）なら true。子どもだけでする事は false',
        ),
      shape: z
        .enum(['none', 'by', 'window'])
        .describe(
          'need の形。by：締切までに済ませる。window：その日のある時間に、家のだれかが要る。need でなければ none',
        ),
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

/**
 * 録った出力と手で書いた形を、今の形で読む。extract.v2 までの物には familyAction の欄が無く（v3 で足した）、
 * extract.v3 までの物には shape の欄が無い（v4 で足した）。前の版は家の人がすることを分けておらず、「すること」
 * （need）も出さなかったので、無い欄は false と none として読む（録った物そのものは書き換えない）。
 */
export function parseStoredExtraction(raw: unknown): ExtractionOutput {
  const items = (raw as { items?: unknown }).items;
  return ExtractionOutput.parse({
    ...(raw as object),
    items: Array.isArray(items)
      ? items.map((item: unknown) => ({
          familyAction: false,
          shape: 'none',
          ...(item as object),
        }))
      : items,
  });
}

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
    | 'dateMismatch'
    /**
     * 時刻を使えない：指した文に見つからない時刻（「12月4日まで」から作った 8:00、「午後8時」を 8:00 と読んだ物）
     * は落とす（締切は日だけにする）。日だけで読んだ締切でも、指した文に時刻らしい書き方（読める時刻、朝・夕方
     * などの言葉）があれば、読み落としかもしれない（日の終わりまでと緩めて黙らない）。どちらも、その文を家族に
     * 確かめてもらう。
     */
    | 'unwrittenTime'
    /**
     * 「すること」（need）の形が足りない：形が無い、窓の日・始まり・終わりのどれかが無い（書かれた時刻だけを数える）、
     * 終わりが始まりより前、締切の形に締切が無い。事項は残し（家族の用事を落とさない）、計算は家族が確かめて欄を
     * 埋めるまで作業を作らない（時刻を作らない・別の形に変えない）。その文を家族に確かめてもらう。
     */
    | 'needIncomplete';
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
    if (
      raw.deadline !== null &&
      !isValidDateTime(raw.deadline) &&
      !isValidLocalDate(raw.deadline)
    ) {
      issues.push({ problem: 'badDate', ref: id, detail: raw.deadline });
      continue;
    }
    const times = [raw.startTime, raw.endTime].filter((t) => t !== null);
    if (times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      issues.push({ problem: 'badTime', ref: id, detail: times.join(',') });
      continue;
    }
    // 指した文（原文の順につなぐ。日付の照らし合わせと、引用の確かめに使う）。
    const cited = quoteForm(
      source.sentences
        .filter((s) => raw.sentenceIds.includes(s.id))
        .map((s) => s.text)
        .join(''),
    );
    // 「あした」は、出典が届いた日の次の日（暦どおり。習い事の金曜の連絡の「あした」は土曜）。
    // 「きょう」は届いた日。書かれた曜日と食い違えば、下で「食い違い」にして家族に確かめてもらう。
    const relativeDay = raw.relativeDay === 'none' ? undefined : raw.relativeDay;
    const tz = context.timeZone ?? 'Asia/Tokyo';
    const receivedOn = localDateOf(toEpochMinutes(source.receivedAt), tz);
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
    // 締切も同じ：相対の言い方だけで日付の書かれていない文（「あしたまでに」）では、締切の日はコードの日のはず。
    // 違えば取らずに「食い違い」にする（日付が書かれていれば、下の日付の照らし合わせが締切も見る）。
    if (
      relativeDate !== null &&
      raw.deadline !== null &&
      raw.deadline.slice(0, 10) !== relativeDate &&
      writtenDates(cited).length === 0
    ) {
      issues.push({ problem: 'relativeDayMismatch', ref: id, detail: raw.deadline });
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
    // 指した文は、原文の順につなぐ（モデルが文を逆の順に挙げても、引用の続きが切れないように）。上でつないだ物。
    const quote = quoteForm(raw.written);
    if (quote === '' || !cited.includes(quote)) {
      issues.push({ problem: 'quoteMismatch', ref: id });
      evidence = 'conflicting';
    }
    // 時刻も、指した文に書かれた物だけを使う（「12月4日まで」から 8:00 を作らない。書かれた午前・午後は
    // 守らせ、書かれていない時だけ、文の前後からのモデルの読みを許す）。書かれていない始まり・終わりは落とす。締切は、その日の朝（日だけの締切と
    // 同じ目安）にして、日だけが書かれていたと印を付ける（画面は時刻を書かれた物として見せない）。
    const citedTexts = source.sentences
      .filter((s) => raw.sentenceIds.includes(s.id))
      .map((s) => s.text);
    const clocks = writtenClock(citedTexts);
    const written = (time: string) => clocks.has(clockKey(time));
    const startTime = raw.startTime !== null && written(raw.startTime) ? raw.startTime : null;
    const endTime = raw.endTime !== null && written(raw.endTime) ? raw.endTime : null;
    // 日だけで読んだ締切（時刻を付けていない）は、指した文に時刻らしい書き方が無い時だけ、確かめを求めない。
    // 有れば読み落としかもしれない（「17:00までに」を日だけで読むと、日の終わりまでに緩む）。時刻の書き方は数え
    // 切れないので、無いとは言えない：見つかる書き方だけは見落とさない。
    const readDayOnly = raw.deadline !== null && isValidLocalDate(raw.deadline);
    const timeLike =
      clocks.size > 0 || citedTexts.some((text) => TIME_WORDS.test(text.normalize('NFKC')));
    const deadlineDayOnly =
      raw.deadline !== null && (readDayOnly || !written(raw.deadline.slice(11, 16)));
    // 締切の時刻が確かでない：書かれていない時刻を落とした、または日だけで読んだのに文に時刻らしい書き方がある。
    // 日だけの締切は、その日の朝を目安にする（早めに出す側に寄せる）。「すること」（need）は、お知らせから読んだ
    // 物を家族が確かめるまで計画に入れない（エンジン）ので、ここでは読みを残して、確かめる画面に見せる。
    const unsureTime = deadlineDayOnly && (!readDayOnly || timeLike);
    const deadline =
      raw.deadline === null
        ? null
        : !deadlineDayOnly
          ? raw.deadline
          : formatDateTime(zonedToEpochMinutes(raw.deadline.slice(0, 10), '08:00', tz), tz);
    // 落とした時刻（始まり・終わり・締切）は、その文を家族に確かめてもらう。時刻の書き方は数え切れない
    // （「午後八時」「夕方まで」）ので、見つからないことを「書かれていない」証拠にしない。
    const unwritten = [
      startTime === raw.startTime ? null : raw.startTime,
      endTime === raw.endTime ? null : raw.endTime,
      // 締切の「すること」は、原文から確かめた締切なら、モデルの付けた時刻を落としても確かめを求めない。
      unsureTime ? raw.deadline : null,
    ].filter((t) => t !== null);
    if (unwritten.length > 0) {
      issues.push({ problem: 'unwrittenTime', ref: id, detail: unwritten.join(',') });
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
    // 「すること」の形は need だけに付ける（ほかの種類に付いても使わない）。形に要る欄は、書かれた物だけで数える
    // （落とした時刻は無い物として）。足りなければ、その文を家族に確かめてもらう。
    const shape = raw.kind === 'need' && raw.shape !== 'none' ? raw.shape : undefined;
    if (raw.kind === 'need') {
      const missing =
        shape === undefined
          ? 'shape'
          : shape === 'window'
            ? date === null || startTime === null || endTime === null
              ? 'window'
              : startTime >= endTime
                ? 'overnight'
                : undefined
            : deadline === null
              ? 'deadline'
              : undefined;
      if (missing !== undefined)
        issues.push({ problem: 'needIncomplete', ref: id, detail: missing });
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
        ...(startTime === null ? {} : { startTime }),
        ...(endTime === null ? {} : { endTime }),
        ...(raw.what === null ? {} : { what: raw.what }),
        ...(raw.dayType === null ? {} : { dayType: raw.dayType }),
        ...(deadline === null ? {} : { deadline }),
        ...(deadline !== null && deadlineDayOnly ? { deadlineDayOnly: true as const } : {}),
        ...(raw.startTime !== null && startTime === null
          ? { startTimeUnconfirmed: true as const }
          : {}),
        ...(raw.endTime !== null && endTime === null ? { endTimeUnconfirmed: true as const } : {}),
        ...(raw.audience === null ? {} : { audience: raw.audience }),
        ...(raw.place === null ? {} : { place: raw.place }),
        ...(relativeDay === undefined ? {} : { relativeDay }),
        // 家の人がすることは、宿題と当番の物だけを使う（ほかの種類に付いても、作業は作らない）。
        ...(raw.familyAction && (raw.kind === 'homework' || raw.kind === 'duty')
          ? { familyAction: true as const }
          : {}),
        ...(shape === undefined ? {} : { shape }),
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

/** 午前・午後を表す言葉（前に付く物と、後ろに付く am・pm）。 */
const MARKER = '(午前|午後|朝|夜|夕方)?\\|?';
const SUFFIX = '\\|?(am|pm|a\\.m\\.|p\\.m\\.)?';
/** 時刻の数（前の数字の続きや、分を時と読まない）。 */
const HOUR = '(?<![\\d:])(\\d{1,2})';
/** 時の後ろ：「:30」「時」「時30分」「時半」。 */
const UNIT = '(?::(\\d{2})|時(?:(\\d{1,2})分|(半))?)';
const RANGE = new RegExp(
  `${MARKER}${HOUR}${UNIT}?\\|?[〜~\\-ー―‐–—]\\|?${MARKER}${HOUR}${UNIT}${SUFFIX}`,
  'gi',
);
const SINGLE = new RegExp(`${MARKER}${HOUR}${UNIT}${SUFFIX}`, 'gi');
const SUFFIX_ONLY = new RegExp(`${HOUR}\\|?(am|pm|a\\.m\\.|p\\.m\\.)`, 'gi');

/**
 * 時刻らしい言葉（読める時刻のほか）。日だけで読んだ締切の文にあれば、確かめてもらう。余分に当たる（「朝顔」）
 * のは確かめが一つ増えるだけで、見落とすより良い。
 */
const TIME_WORDS =
  /午前|午後|正午|朝|昼|夕方|夕刻|夜|放課後|登校|下校|登園|降園|始業|終業|開庁|閉庁|開館|閉館|受付時間|営業時間|時間目|時限|noon|morning|afternoon|evening|night|end of (?:the )?day|close of business/i;

/** 時刻の読みを前から受け継がせない区切り：読点・句点などと、書かれた日付（別の日・別の事の時刻）。 */
const CLAUSE_BREAK = /[、，,。；;]|(?:\d{1,2}月)?\d{1,2}日|\d{1,2}\/\d{1,2}/g;

/**
 * 文に書かれた時刻（0〜23 時の「時:分」）。「8:30」「8時半」「8時30分」「13時」「午後8時」「朝8時」「正午」
 * 「8pm」「9〜10時」「午後1時〜3時」。
 * - 午前・午後（朝・夜・夕方、am・pm、正午）の付いた時刻は、その時刻だけ。
 * - 24 時制で書いた時刻（「09:00」のような前の 0、13〜23 時、0 時）は、書いたままの時刻だけ。
 * - 印の無い 1〜12 時は、同じ句（読点・句点・日付で区切る）の前に、印のある時刻か 24 時制の時刻があれば、
 *   それに合わせる。印なら午前・午後を受け（前より早くなれば半日後。「午前9時から10時まで」の 10 時は
 *   10:00 だけ）、24 時制なら書いたままにする（「08:30〜10:00」の 10 時は 10:00 だけ）。つなぎの言葉を
 *   見分けられなくても、外れた読みを書かれたとしない。別の日・別の句の時刻からは受けない。
 * - 前に何も無い 1〜12 時は、午前と午後の両方にする（どちらかは、文の前後からのモデルの読みに任せる）。
 * 文は全角・半角をそろえ、空白は一つにした形で読む（空白を除くと、「12/13 9:00」の数がつながる）。
 */
function writtenClock(sentences: readonly string[]): Set<string> {
  const found = new Set<string>();
  const half = (word: string | undefined) =>
    word === undefined || word === '' ? undefined : /午前|朝|am|a\.m\./i.test(word) ? 'am' : 'pm';
  const minuteOf = (colon?: string, minutes?: string, halfHour?: string) =>
    colon ? Number(colon) : minutes ? Number(minutes) : halfHour ? 30 : 0;
  const put = (minute: number) => found.add(clock(Math.floor(minute / 60), minute % 60));
  /** 前に 0 を付けた時（「09」）。24 時制で書いた印。 */
  const zero = (hour: string | undefined) => hour !== undefined && /^0\d$/.test(hour);
  type Written = {
    at: number;
    hour: number;
    minute: number;
    which: 'am' | 'pm' | undefined;
    twentyFour: boolean;
  };
  for (const sentence of sentences) {
    // 空白の前後の数がつながらないよう、空白のあった所には区切り（|）を残す。漢数字（八時、十二時半）は数字に
    // する。
    let text = arabic(sentence.normalize('NFKC').replace(/\s+/g, '|'));
    /** 文の中の位置と、書かれた時・分・午前か午後（書かれていれば）・24 時制で書いたか。 */
    const times: Written[] = [];
    const written = (at: number, hour: string, minute: number, which: 'am' | 'pm' | undefined) =>
      times.push({
        at,
        hour: Number(hour),
        minute,
        which,
        twentyFour: zero(hour) || Number(hour) === 0 || Number(hour) >= 13,
      });
    for (const m of text.matchAll(RANGE)) {
      const [, m1, h1 = '', c1, n1, half1, m2, h2 = '', c2, n2, half2, suffix] = m;
      // 後ろだけに付いた am・pm は、前にも効く（「9-10am」）。前に付いた午前・午後は、後ろが受ける（下で）。
      written(
        m.index,
        h1,
        minuteOf(c1, n1, half1),
        half(m1) ?? (m2 === undefined ? half(suffix) : undefined),
      );
      written(m.index + m[0].length - 1, h2, minuteOf(c2, n2, half2), half(m2) ?? half(suffix));
      // 範囲の数を、一つの時刻として読み直さない。
      text = `${text.slice(0, m.index)}${' '.repeat(m[0].length)}${text.slice(m.index + m[0].length)}`;
    }
    for (const m of text.matchAll(SINGLE)) {
      written(m.index, m[2] ?? '', minuteOf(m[3], m[4], m[5]), half(m[1]) ?? half(m[6]));
    }
    for (const m of text.matchAll(SUFFIX_ONLY)) written(m.index, m[1] ?? '', 0, half(m[2]));
    for (const m of text.matchAll(/正午/g)) written(m.index, '12', 0, 'pm');
    const breaks = [...text.matchAll(CLAUSE_BREAK)].map((m) => m.index);
    // 文の順に読む。anchor は、同じ句の前の時刻のうち、午前・午後か 24 時制の分かった物（0 時からの分）。
    let anchor: { minute: number; twentyFour: boolean } | undefined;
    let at = 0;
    for (const t of times.sort((a, b) => a.at - b.at)) {
      if (breaks.some((b) => b >= at && b < t.at)) anchor = undefined;
      at = t.at;
      if (t.hour > 24 || t.minute >= 60) continue;
      if (t.which !== undefined) {
        anchor = {
          minute: ((t.hour % 12) + (t.which === 'pm' ? 12 : 0)) * 60 + t.minute,
          twentyFour: false,
        };
        put(anchor.minute);
      } else if (t.twentyFour || anchor?.twentyFour) {
        // 24 時制の続きは、書いたままの時刻。
        anchor = { minute: (t.hour % 24) * 60 + t.minute, twentyFour: true };
        put(anchor.minute);
      } else if (anchor !== undefined) {
        // 前の午前・午後を受ける。前より早くなる時は、半日後（「午前10時〜1時」の 1 時は 13 時）。日をまたぐ
        // 物は見つけない（書かれたとしないので、確かめてもらう）。
        const same = (t.hour % 12) * 60 + (anchor.minute >= 720 ? 720 : 0) + t.minute;
        const later = same > anchor.minute ? same : same + 720;
        if (later < 1440) {
          anchor = { minute: later, twentyFour: false };
          put(later);
        }
      } else {
        put((t.hour % 12) * 60 + t.minute);
        put(((t.hour % 12) + 12) * 60 + t.minute);
      }
    }
  }
  return found;
}

/** 漢数字（〇〜五十九）を数字にする（時と分に使う範囲だけ）。 */
function arabic(text: string): string {
  const digit = '〇一二三四五六七八九';
  return text.replace(/[〇一二三四五六七八九十]+/g, (word) => {
    const ones = (c: string | undefined) => (c === undefined ? 0 : digit.indexOf(c));
    if (!word.includes('十')) {
      return [...word].map((c) => digit.indexOf(c)).join('');
    }
    const [tens, rest] = word.split('十');
    if (rest === undefined || rest.length > 1 || (tens ?? '').length > 1) return word;
    return String((tens === '' ? 1 : ones(tens)) * 10 + ones(rest === '' ? undefined : rest));
  });
}

const clock = (hour: number, minute: number) => `${hour}:${minute}`;
/** 時刻（HH:MM）を、書かれた時刻と比べる形にする。 */
const clockKey = (time: string) => clock(Number(time.slice(0, 2)), Number(time.slice(3, 5)));

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
