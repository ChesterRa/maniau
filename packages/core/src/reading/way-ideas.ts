// 新しい「すること」に、Claude がやり方の案を出す（W4。02-foundation §3.4）。モデルは案と読み取りだけを受け持ち、
// ID・数の確かめ、文に無い名前の扱い、表に写す前の形はここで決める。家族が表で確かめ、変わることを見て保存する
// まで、何も書かない。分からない欄は分からないのまま返し、既定値（大人のだれでも・頼まない・10 分・全部の時間・
// 受け持たない）で埋めない。
// 外の事実（値段・相手の返事の早さ・締切の決まり・受け持てる時間）は、モデルの出力の形に欄を置かない（形からは
// 確かめられないので、受け取らない。家族が表で入れる）。頼める人に頼む数は、モデルの数を使わず手順から数える。
import { z } from 'zod';
import { type Household, type PlaceKind, SegmentKind } from '../schema/household';
import type { PlanResult } from '../schema/plan';
import type { Item, Source } from '../schema/source';
import { repeatedNames, shownName } from '../schema/validate-household';

/** 案の数・手順の数・数の上限（W1 のサーバーの決まりと同じ）。 */
export const WAY_IDEAS_LIMITS = {
  drafts: 3,
  steps: 3,
  minutes: 1440,
  familyWords: 500,
} as const;

// ── モデルの出力（構造化出力の形。使わない欄は null） ──────────────────────

const DraftStep = z.object({
  name: z.string(),
  /** この手順の元になった、元の文か家族の考えの一部（そのままの文字列）。無ければ null。 */
  quote: z.string().nullable(),
  assignee: z.object({ kind: z.enum(['adult', 'anyAdult', 'unknown']), id: z.string().nullable() }),
  counterpart: z.object({
    kind: z.enum(['none', 'helper', 'place', 'newHelper', 'newPlace', 'unknown']),
    id: z.string().nullable(),
    name: z.string().nullable(),
    quote: z.string().nullable(),
  }),
  place: z.object({
    kind: z.enum(['none', 'place', 'newPlace', 'unknown']),
    id: z.string().nullable(),
    name: z.string().nullable(),
    quote: z.string().nullable(),
  }),
  minutes: z.number().int().nullable(),
  segments: z.array(SegmentKind).nullable(),
  cover: z.boolean().nullable(),
});

const WayDraft = z.object({
  name: z.string(),
  /** この手立てで「すること」がどう済むか（一行）。 */
  why: z.string(),
  steps: z.array(DraftStep),
  /** 窓の「すること」の時間の全部を頼む・受け持つなら whole。一部だけ・分からない・by の「すること」は unknown。 */
  covers: z.enum(['whole', 'unknown']),
  /** 家の中の見込み（休みの長さ・手順のほかに増える作業）。値段と頼む数は持たない。 */
  cost: z.object({
    leaveMinutes: z.number().int().nullable(),
    extraTasks: z.number().int().nullable(),
  }),
  /** 確かめが要ること（使えるか・一度きりの都合・書かれていた外の事実など）。 */
  unclear: z.array(z.string()),
});

/** モデルの出力。案を出す根拠が無い時は drafts を空にし、missing に足りないことを書く。 */
export const WayIdeasOutput = z.object({
  drafts: z.array(WayDraft),
  reuse: z.array(z.object({ wayId: z.string(), why: z.string() })),
  missing: z.array(z.string()),
});
export type WayIdeasOutput = z.infer<typeof WayIdeasOutput>;

// ── モデルに渡す物（画面にも、そのまま見せる） ──────────────────────────

export interface WayIdeasContext {
  language: 'ja' | 'en';
  need: {
    what: string;
    /** window：その時間だれかが要る。by：いつまでに済ませる。 */
    shape: 'by' | 'window';
    date: string | null;
    start: string | null;
    end: string | null;
    /** by の締切（時刻の無い締切は日付だけ）。 */
    by: string | null;
    /** 書かれた場所（原文のまま）。 */
    place: string | null;
    /** 元の文（お知らせ・家族の言明の、その事項の文）。 */
    written: string;
  };
  /** 家族の考え（任意）。 */
  familyWords: string | null;
  /** 家族の考えを書いた大人（考えの「私」がだれか。考えが無ければ null）。 */
  familyWordsBy: { id: string; name: string } | null;
  household: {
    adults: { id: string; name: string }[];
    helpers: { id: string; name: string }[];
    places: { id: string; name: string; kind: PlaceKind }[];
    ways: { id: string; name: string; steps: string[] }[];
  };
}

/** 案を作る前の材料（計画・家族が確かめた事項・家の情報・出典）。 */
export interface WayIdeasMaterials {
  plan: PlanResult;
  items: readonly Item[];
  household: Household;
  sources: readonly Source[];
}

/**
 * 「すること」の手配から、モデルに渡す物を作る。手配が今の計画に無いか、生きていないとはっきりした時だけ無し
 * （条件の決まっていない手配は、生きている物として扱う）。家の情報は、名前と ID だけ（ふだんの週・子・営業時間などの
 * 欄は渡さない）。元の文・家族の考え・名前はそのまま渡すので、そこに書かれた事（名前・住所・予定など）は送られる。
 * askedBy は頼んだ大人（考えを書いた人）。
 */
export function wayIdeasContext(
  materials: WayIdeasMaterials,
  arrangementKey: string,
  familyWords: string | undefined,
  language: 'ja' | 'en',
  askedBy: string,
): WayIdeasContext | undefined {
  const { plan, items, household, sources } = materials;
  const arrangement = plan.arrangements.find((a) => a.key === arrangementKey && a.kind === 'need');
  if (!arrangement?.live) return undefined;
  const requirement = plan.requirements.find((r) => r.key === arrangement.requirementKey);
  const item = items.find((i) => i.kind === 'need' && requirement?.basis.itemIds.includes(i.id));
  if (!item) return undefined;
  const i = item.interpretation;
  const shape = i.shape ?? arrangement.needShape;
  if (shape !== 'by' && shape !== 'window') return undefined;
  const source = sources.find((s) => s.id === item.sourceId);
  const cited = (source?.sentences ?? [])
    .filter((s) => item.sentenceIds.includes(s.id))
    .map((s) => s.text)
    .join('');
  const stopped = new Set(household.stoppedWayIds ?? []);
  const words = familyWords?.trim();
  const writer = household.members.find((m) => m.id === askedBy && m.kind === 'adult' && m.active);
  return {
    language,
    need: {
      what: i.what ?? item.written,
      shape,
      date: shape === 'window' ? (i.date ?? null) : null,
      start: shape === 'window' ? (i.startTime ?? null) : null,
      end: shape === 'window' ? (i.endTime ?? null) : null,
      by:
        shape === 'by' && i.deadline
          ? i.deadlineDayOnly === true
            ? i.deadline.slice(0, 10)
            : i.deadline
          : null,
      place: i.place ?? null,
      written: cited || item.written,
    },
    familyWords: words ? words.slice(0, WAY_IDEAS_LIMITS.familyWords) : null,
    familyWordsBy: words && writer ? { id: writer.id, name: writer.name } : null,
    household: {
      adults: household.members
        .filter((m) => m.kind === 'adult' && m.active)
        .map((m) => ({ id: m.id, name: m.name })),
      helpers: household.members
        .filter((m) => m.kind === 'helper' && m.active)
        .map((m) => ({ id: m.id, name: m.name })),
      places: household.places
        .filter((p) => p.kind !== 'home')
        .map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      ways: household.ways
        .filter((w) => !stopped.has(w.id))
        .map((w) => ({ id: w.id, name: w.name, steps: w.steps.map((s) => s.name) })),
    },
  };
}

// ── コードが確かめた案（画面が表に写す形） ──────────────────────────────

export type CheckedAssignee =
  | { kind: 'adult'; id: string }
  | { kind: 'anyAdult' }
  | { kind: 'unknown' };
export type CheckedCounterpart =
  | { kind: 'none' }
  | { kind: 'helper'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'newHelper'; name: string }
  | { kind: 'newPlace'; name: string }
  | { kind: 'unknown' };
export type CheckedPlace =
  | { kind: 'none' }
  | { kind: 'place'; id: string }
  | { kind: 'newPlace'; name: string }
  | { kind: 'unknown' };
export interface CheckedStep {
  name: string;
  /** 文にそのまま有る引用だけ（無ければ「Claude の提案」と示す）。 */
  quote: string | null;
  /**
   * 引用がそのまま有る所（コードが確かめた）：「すること」の元の文・家族の考え・両方。画面は、家族の考えを元の文に
   * 書かれていたように見せない。引用が無ければ null。
   */
  quoteFrom: 'written' | 'words' | 'both' | null;
  assignee: CheckedAssignee;
  counterpart: CheckedCounterpart;
  place: CheckedPlace;
  minutes: number | null;
  segments: SegmentKind[] | null;
  /** 窓の間を受け持つか（by の「すること」では false）。null は分からない。 */
  cover: boolean | null;
}

/** 代償。値段は持たない（いつも分からない。家族が入れる）。 */
export interface CheckedCost {
  leaveMinutes: number | null;
  /** 相手が頼める人（今いる人・新しい人）の手順の数。相手の分からない手順があれば null。 */
  helperRequests: number | null;
  extraTasks: number | null;
}

/** コードが案を直した理由（画面が言葉にする。value はモデルの書いた値のまま）。 */
export type WayIdeaNote =
  | { code: 'unknownId'; value: string }
  /** 同じ名前の人・場所がほかにもあり、家族がどれのことか見分けられない（新しい名前が今の名前と同じ時も）。 */
  | { code: 'ambiguousName'; value: string }
  | { code: 'nameNotInText'; value: string }
  | { code: 'quoteNotInText'; value: string }
  | { code: 'outOfRange'; field: 'minutes' | 'cost'; value: number }
  | { code: 'leaveNotHalfHour'; value: number }
  | { code: 'tooManySteps'; value: number }
  | { code: 'noSteps' }
  | { code: 'tooManyDrafts'; value: number }
  | { code: 'unknownWay'; value: string };

export interface CheckedDraft {
  name: string;
  why: string;
  steps: CheckedStep[];
  covers: 'whole' | 'unknown';
  cost: CheckedCost;
  unclear: string[];
  notes: WayIdeaNote[];
}

export interface CheckedIdeas {
  drafts: CheckedDraft[];
  reuse: { wayId: string; why: string }[];
  missing: string[];
  notes: WayIdeaNote[];
}

const text = (value: string, max: number) => value.trim().slice(0, max);
const texts = (values: readonly string[], max: number) =>
  values
    .map((v) => text(v, max))
    .filter((v) => v !== '')
    .slice(0, 10);

/**
 * モデルの出力を、今の家庭と元の文で確かめる。無い ID・文に無い名前・範囲を外れた数は、分からない（unknown・null）
 * にして理由を notes に残す（黙って 0・丸め・既定値にしない）。引用は、元の文か家族の考えにそのまま有る物だけ残す
 * （空の引用は、引用が無いのと同じ）。by の「すること」では、どの手順も窓を受け持たない。同じ名前の人・場所がほかに
 * もある物は、ID があっても分からないにする（画面で見分けられず、別の人に頼むことがある）。
 */
export function checkWayIdeas(
  output: WayIdeasOutput,
  context: WayIdeasContext,
  household: Household,
): CheckedIdeas {
  const notes: WayIdeaNote[] = [];
  const adults = new Set(
    household.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id),
  );
  const helpers = new Set(
    household.members.filter((m) => m.kind === 'helper' && m.active).map((m) => m.id),
  );
  const places = new Set(household.places.filter((p) => p.kind !== 'home').map((p) => p.id));
  const stopped = new Set(household.stoppedWayIds ?? []);
  const ways = new Set(household.ways.filter((w) => !stopped.has(w.id)).map((w) => w.id));
  const repeated = repeatedNames(household);
  const names = new Set(
    [...household.members.map((m) => m.name), ...household.places.map((p) => p.name)].map(
      shownName,
    ),
  );
  const nameOf = (id: string) =>
    household.members.find((m) => m.id === id)?.name ??
    household.places.find((p) => p.id === id)?.name ??
    '';
  const sourcesOfQuotes = [context.need.written, context.familyWords ?? ''];
  const inText = (quote: string | null): quote is string =>
    quote !== null && quote.trim() !== '' && sourcesOfQuotes.some((t) => t.includes(quote));

  const drafts: CheckedDraft[] = [];
  if (output.drafts.length > WAY_IDEAS_LIMITS.drafts) {
    notes.push({ code: 'tooManyDrafts', value: output.drafts.length });
  }
  for (const raw of output.drafts.slice(0, WAY_IDEAS_LIMITS.drafts)) {
    const own: WayIdeaNote[] = [];
    if (raw.steps.length === 0) {
      notes.push({ code: 'noSteps' });
      continue;
    }
    if (raw.steps.length > WAY_IDEAS_LIMITS.steps) {
      own.push({ code: 'tooManySteps', value: raw.steps.length });
    }
    const named = (name: string | null, quote: string | null): string | undefined => {
      const trimmed = name?.trim() ?? '';
      if (trimmed === '' || !inText(quote) || !quote.includes(trimmed)) {
        own.push({ code: 'nameNotInText', value: trimmed });
        return undefined;
      }
      // 今の人・場所と同じ名前は、新しく登録させない（重ねると見分けられない。家族が表で今の物を選ぶ）。
      if (names.has(shownName(trimmed))) {
        own.push({ code: 'ambiguousName', value: trimmed });
        return undefined;
      }
      return text(trimmed, 40);
    };
    /** ID の物の名前が、ほかの物と重なっていないか（重なれば分からないにする）。 */
    const distinct = (id: string): boolean => {
      const name = nameOf(id);
      if (!repeated.has(shownName(name))) return true;
      own.push({ code: 'ambiguousName', value: name });
      return false;
    };
    const steps = raw.steps.slice(0, WAY_IDEAS_LIMITS.steps).map((s): CheckedStep => {
      let quote: string | null = null;
      let quoteFrom: CheckedStep['quoteFrom'] = null;
      if (s.quote !== null && s.quote.trim() !== '') {
        const written = context.need.written.includes(s.quote);
        const words = (context.familyWords ?? '').includes(s.quote);
        if (written || words) {
          quote = s.quote;
          quoteFrom = written && words ? 'both' : written ? 'written' : 'words';
        } else own.push({ code: 'quoteNotInText', value: s.quote });
      }
      let assignee: CheckedAssignee = { kind: 'unknown' };
      if (s.assignee.kind === 'anyAdult') assignee = { kind: 'anyAdult' };
      else if (s.assignee.kind === 'adult') {
        if (s.assignee.id !== null && adults.has(s.assignee.id)) {
          if (distinct(s.assignee.id)) assignee = { kind: 'adult', id: s.assignee.id };
        } else own.push({ code: 'unknownId', value: s.assignee.id ?? '' });
      }
      let counterpart: CheckedCounterpart = { kind: 'unknown' };
      const c = s.counterpart;
      if (c.kind === 'none') counterpart = { kind: 'none' };
      else if (c.kind === 'helper' || c.kind === 'place') {
        if (c.id !== null && (helpers.has(c.id) || places.has(c.id))) {
          if (distinct(c.id)) {
            counterpart = helpers.has(c.id)
              ? { kind: 'helper', id: c.id }
              : { kind: 'place', id: c.id };
          }
        } else own.push({ code: 'unknownId', value: c.id ?? '' });
      } else if (c.kind === 'newHelper' || c.kind === 'newPlace') {
        const name = named(c.name, c.quote);
        if (name !== undefined) counterpart = { kind: c.kind, name };
      }
      let place: CheckedPlace = { kind: 'unknown' };
      const p = s.place;
      if (p.kind === 'none') place = { kind: 'none' };
      else if (p.kind === 'place') {
        if (p.id !== null && places.has(p.id)) {
          if (distinct(p.id)) place = { kind: 'place', id: p.id };
        } else own.push({ code: 'unknownId', value: p.id ?? '' });
      } else if (p.kind === 'newPlace') {
        const name = named(p.name, p.quote);
        if (name !== undefined) place = { kind: 'newPlace', name };
      }
      let minutes: number | null = null;
      if (s.minutes !== null) {
        if (s.minutes >= 1 && s.minutes <= WAY_IDEAS_LIMITS.minutes) minutes = s.minutes;
        else own.push({ code: 'outOfRange', field: 'minutes', value: s.minutes });
      }
      const segments =
        s.segments && s.segments.length > 0
          ? SegmentKind.options.filter((k) => s.segments?.includes(k))
          : null;
      return {
        name: text(s.name, 60),
        quote,
        quoteFrom,
        assignee,
        counterpart,
        place,
        minutes,
        segments,
        cover: context.need.shape === 'by' ? false : s.cover,
      };
    });
    const count = (value: number | null): number | null => {
      if (value === null) return null;
      if (value < 0) {
        own.push({ code: 'outOfRange', field: 'cost', value });
        return null;
      }
      return value;
    };
    let leaveMinutes = count(raw.cost.leaveMinutes);
    // 表の休みは 0.5 時間きざみ。そうでない長さは「分からない」にして、元の値を残す（丸めない）。
    if (leaveMinutes !== null && leaveMinutes % 30 !== 0) {
      own.push({ code: 'leaveNotHalfHour', value: leaveMinutes });
      leaveMinutes = null;
    }
    // 頼める人に頼む数は、手順から数える（相手の分からない手順があれば数えられない）。
    const helperRequests = steps.some((s) => s.counterpart.kind === 'unknown')
      ? null
      : steps.filter((s) => s.counterpart.kind === 'helper' || s.counterpart.kind === 'newHelper')
          .length;
    drafts.push({
      name: text(raw.name, 60),
      why: text(raw.why, 200),
      steps,
      covers: raw.covers,
      cost: {
        leaveMinutes,
        helperRequests,
        extraTasks: count(raw.cost.extraTasks),
      },
      unclear: texts(raw.unclear, 200),
      notes: own,
    });
  }
  const reuse: CheckedIdeas['reuse'] = [];
  for (const r of output.reuse) {
    if (!ways.has(r.wayId)) {
      notes.push({ code: 'unknownWay', value: r.wayId });
      continue;
    }
    if (!reuse.some((x) => x.wayId === r.wayId))
      reuse.push({ wayId: r.wayId, why: text(r.why, 200) });
  }
  return { drafts, reuse, missing: texts(output.missing, 200), notes };
}
