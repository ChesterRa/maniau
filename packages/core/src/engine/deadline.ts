// 決め時（docs/design/01-model.md §5）：その案を実行するために、最初の作業を始められる最後の時刻。
// 案の手順を後ろからたどり、各手順を、担当できる人の区間と場所の決まりの中で、期限までに終わる
// 最も遅い所に置く。置く時刻の候補は、区間の端と期限から作る（分の精度。刻みに丸めない）。
import type {
  CareOptionTemplate,
  DeadlineRule,
  Household,
  StepTemplate,
} from '../schema/household';
import {
  addBusinessDays,
  addDays,
  type EpochMinutes,
  type LocalDate,
  localDateOf,
  weekdayOf,
  zonedToEpochMinutes,
} from '../time';
import { activeAdultIds, type Slot, slotsBetweenDates } from './availability';

/** 決まりの締切を、手配が要る日から実際の時刻にする。 */
export function ruleDeadline(
  rule: DeadlineRule,
  needDate: LocalDate,
  household: Household,
): EpochMinutes {
  const tz = household.timeZone;
  switch (rule.type) {
    case 'daysBefore':
      return zonedToEpochMinutes(addDays(needDate, -rule.days), rule.at, tz);
    case 'businessDaysBefore': {
      const closedDates = new Set(household.closedDates);
      return zonedToEpochMinutes(
        addBusinessDays(needDate, -rule.days, { closedDates }),
        rule.at,
        tz,
      );
    }
    case 'weekdayOfPreviousWeek': {
      const mondayOfWeek = addDays(needDate, -(weekdayOf(needDate) - 1));
      const target = addDays(mondayOfWeek, -7 + (rule.weekday - 1));
      return zonedToEpochMinutes(target, rule.at, tz);
    }
    case 'onTheDay':
      return zonedToEpochMinutes(needDate, rule.at, tz);
  }
}

export interface PlacedStep {
  stepId: string;
  memberId: string;
  start: EpochMinutes;
  end: EpochMinutes;
  slot: Slot;
}

export interface OptionDeadline {
  templateId: string;
  /** 決まりの締切（最後の手順が終わっていなければならない時刻）。 */
  ruleDeadline: EpochMinutes;
  /** 決め時。置けなければ undefined。 */
  decisionDeadline?: EpochMinutes;
  /** 決め時に置いた手順（担当の人と時刻）。 */
  steps: PlacedStep[];
  /**
   * now より決め時が前なら、もう選べない。決め時を出せない案（noSlot など）は、決まりの締切が過ぎるまでは過ぎたと
   * 言わない（置き方が見つからないことを、過ぎた証拠にしない）。
   */
  expired: boolean;
  /**
   * どれかの手順を置ける区間（種類・決まった場所・営業時間・長さ）が、担当できる大人のふだんの二週に一つも無い
   * （平日の昼の窓口に、ふだんの予定で行く時が無い等）。時刻の問題ではないので、決め時を出さず、過ぎたとも言わない。
   */
  noSlot?: true;
}

/** 手順を置ける区間か（区間の種類、決まった場所、人）。 */
function slotFits(step: StepTemplate, slot: Slot): boolean {
  if (!step.segments.includes(slot.kind)) return false;
  if (step.placeId !== undefined && slot.placeId !== step.placeId) return false;
  return true;
}

/**
 * 区間の中で、手順を置ける時間。決まった場所の手順は、その場所の営業時間が書かれていれば、その内だけ（書かれた
 * 休みの日は、前の日から続く夜の営業があっても置かない。休みでない日は、前の日から続く夜の営業も含める）。営業時間の書かれていない場所は、時刻で絞らない（閉まっているとは
 * 言わない）。開店と閉店が同じ時刻の書き方は、終日か休みか分からないので、時刻で絞らない。地図（Google）から
 * 得た営業時間は、有効な日・時区・臨時の営業を確かめられないので、開いている・閉まっているを決めず、時刻で
 * 絞らない（地図の決まり。検証器も未判定にする）。
 */
function usableIn(step: StepTemplate, slot: Slot, household?: Household): Interval[] {
  if (!slotFits(step, slot)) return [];
  const whole = [{ start: slot.start, end: slot.end }];
  const hours =
    step.placeId === undefined || household === undefined
      ? undefined
      : household.places.find((p) => p.id === step.placeId)?.hours;
  if (!hours || household === undefined || hours.source === 'googlePlaces') return whole;
  // 書かれた休みの日は、前の日から続く夜の営業があっても、その日の全部を休みとする（休みの日が先）。
  if (hours.closedDates.includes(slot.date)) return [];
  const tz = household.timeZone;
  const open: Interval[] = [];
  for (const date of [addDays(slot.date, -1), slot.date]) {
    if (hours.closedDates.includes(date)) continue;
    for (const p of hours.periods.filter((x) => x.weekday === weekdayOf(date))) {
      if (p.open === p.close) return whole;
      const from = zonedToEpochMinutes(date, p.open, tz);
      const overnight = p.close < p.open;
      // 前の日の分は、夜をまたぐ営業だけ。
      if (date !== slot.date && !overnight) continue;
      const until = zonedToEpochMinutes(overnight ? addDays(date, 1) : date, p.close, tz);
      open.push({ start: from, end: until });
    }
  }
  return open.flatMap((o) => {
    const start = Math.max(o.start, slot.start);
    const end = Math.min(o.end, slot.end);
    return end > start ? [{ start, end }] : [];
  });
}

interface Interval {
  start: EpochMinutes;
  end: EpochMinutes;
}

/**
 * 一人の担当で、手順の鎖を後ろから置く。置けた時は、最初の手順の開始が最も遅い置き方を返す。
 * 決まった担当の無い手順は、同じ人がする。手順の担当が前後で別の人になる鎖は置かない：書いた紙を
 * 次の人へ渡す時間と方法が分からず、零分で手渡せるとは言えないから（家族が受け渡しを決める）。
 */
function placeChain(
  steps: readonly StepTemplate[],
  memberId: string,
  slotsByMember: ReadonlyMap<string, Slot[]>,
  latestEnd: EpochMinutes,
  limits: readonly (EpochMinutes | undefined)[] = [],
  /** 決まった場所の営業時間を見るための家の情報（無ければ、営業時間で絞らない）。 */
  household?: Household,
): PlacedStep[] | undefined {
  const placed: PlacedStep[] = [];
  let bound = latestEnd;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) return undefined;
    // 手順ごとの最後の時（前の日 21:00 までの予約など）。案の締切と次の手順から決まる時より早ければ、それを守る。
    const limit = limits[i];
    if (limit !== undefined) bound = Math.min(bound, limit);
    const who = step.assigneeId ?? memberId;
    if (placed[0] && placed[0].memberId !== who) return undefined;
    const slots = slotsByMember.get(who) ?? [];
    let best: PlacedStep | undefined;
    for (const slot of slots) {
      for (const piece of usableIn(step, slot, household)) {
        const end = Math.min(piece.end, bound);
        const start = end - step.durationMin;
        if (start < piece.start) continue;
        if (!best || start > best.start) {
          best = { stepId: step.id, memberId: who, start, end, slot };
        }
      }
    }
    if (!best) return undefined;
    placed.unshift(best);
    const previous = steps[i - 1];
    bound = best.start - (previous?.waitAfterMin ?? 0);
  }
  return placed;
}

/** 人がほかの作業で使う時間（移動も含む）。 */
export interface Busy {
  start: EpochMinutes;
  end: EpochMinutes;
}

/** 区間から、使われている時間を除いた残り（前と後に分かれることがある）。 */
function withoutBusy(slot: Slot, busy: readonly Busy[]): Slot[] {
  let pieces = [slot];
  for (const used of busy) {
    pieces = pieces.flatMap((piece) =>
      used.end <= piece.start || used.start >= piece.end
        ? [piece]
        : [
            ...(used.start > piece.start ? [{ ...piece, end: used.start }] : []),
            ...(used.end < piece.end ? [{ ...piece, start: used.end }] : []),
          ],
    );
  }
  return pieces;
}

/**
 * 一つの手順を、一人の大人のふだんの時間の中で、期限までに終わる最も遅い所に置く。今より前と、
 * その人のほかの作業が使う時間（busy）には置かない。置けなければ無し。案の無い作業（提出物）に使う。
 */
export function placeStep(
  step: StepTemplate,
  memberId: string,
  household: Household,
  now: EpochMinutes,
  latestEnd: EpochMinutes,
  busy: readonly Busy[],
): PlacedStep | undefined {
  if (latestEnd <= now) return undefined;
  const tz = household.timeZone;
  const free = slotsBetweenDates(
    household,
    memberId,
    localDateOf(now, tz),
    localDateOf(latestEnd, tz),
  )
    .map((slot) => ({ ...slot, start: Math.max(slot.start, now) }))
    .flatMap((slot) => withoutBusy(slot, busy))
    .filter((slot) => slot.end > slot.start);
  return placeChain([step], memberId, new Map([[memberId, free]]), latestEnd, [], household)?.[0];
}

/**
 * 案の決め時を、手順の逆算で求める。探すのは now の日から締切の日まで。only を渡すと、その大人だけで手順を
 * 置く（担当の決まった作業を、担当の人のふだんの時間に置くため）。busy を渡すと、その人のほかの作業が使う
 * 時間には置かない（家族が進める案どうしを、同じ人の同じ時間に重ねないため。joint.ts）。from を渡すと、
 * それより前には置かない（済ませた手順の後に待つ時間がある時。now より前に置けるのは、過ぎた決め時を示すため）。
 */
export function optionDeadline(
  template: Pick<CareOptionTemplate, 'id' | 'deadline' | 'steps'>,
  needDate: LocalDate,
  household: Household,
  now: EpochMinutes,
  only?: string,
  busy: ReadonlyMap<string, readonly Busy[]> = new Map(),
  from?: EpochMinutes,
): OptionDeadline {
  const deadline = ruleDeadline(template.deadline, needDate, household);
  // 手順ごとの最後の時（決まりのある手順だけ）。
  const limits = template.steps.map((s) =>
    s.deadline === undefined ? undefined : ruleDeadline(s.deadline, needDate, household),
  );
  const tz = household.timeZone;
  const firstDate = localDateOf(Math.min(now, deadline), tz);
  const lastDate = localDateOf(deadline, tz);
  const adults = activeAdultIds(household);
  const fixed = template.steps.map((s) => s.assigneeId).filter((id) => id !== undefined);
  const members = [...new Set([...adults, ...fixed, ...(only === undefined ? [] : [only])])];
  // 担当できる人ごとの区間（busy を除くか選べる。from より前には置かない）。
  const slotsSince = (start: LocalDate, withBusy: boolean) =>
    new Map(
      members.map((id) => [
        id,
        slotsBetweenDates(household, id, start, lastDate)
          .map((slot) =>
            from === undefined ? slot : { ...slot, start: Math.max(slot.start, from) },
          )
          .flatMap((slot) => (withBusy ? withoutBusy(slot, busy.get(id) ?? []) : [slot]))
          .filter((slot) => slot.end > slot.start),
      ]),
    );
  const candidates =
    only !== undefined
      ? [only]
      : fixed.length === template.steps.length
        ? [fixed[0] ?? '']
        : adults;
  /** 最初の手順の始まりが最も遅い置き方。 */
  const latest = (slotsByMember: ReadonlyMap<string, Slot[]>): PlacedStep[] | undefined => {
    let best: PlacedStep[] | undefined;
    for (const memberId of candidates) {
      const chain = placeChain(
        template.steps,
        memberId,
        slotsByMember,
        deadline,
        limits,
        household,
      );
      const first = chain?.[0];
      if (chain && first && (!best || first.start > (best[0]?.start ?? -Infinity))) best = chain;
    }
    return best;
  };

  const best = latest(slotsSince(firstDate, true));
  let decisionDeadline = best?.[0]?.start;
  // 今日から締切までに、ほかの作業を除いても置けない時：最後の機会は前の日にあったかもしれない。同じ置き方で
  // ふだんの予定の二週をさかのぼり、そろった置き方が見つかれば、その始まりを過ぎた決め時とする（過ぎたと言う
  // 証拠。作業は過去に置かない）。ほかの作業を除けば今日から置ける時はさかのぼらない（重なりは呼び出し側が扱う）。
  if (decisionDeadline === undefined && latest(slotsSince(firstDate, false)) === undefined) {
    const earlier = latest(slotsSince(addDays(firstDate, -14), false))?.[0]?.start;
    if (earlier !== undefined && earlier < now) decisionDeadline = earlier;
  }
  // それでも置けない時：ふだんの二週（休みの日を一つ挟んでも週の決まりを見落とさない長さ）に、どれかの手順を置ける
  // 区間が、担当できる大人のだれにも無ければ、時刻の問題ではない（noSlot）。ほかの作業（busy）と前の手順（from）は
  // 見ない。区間はあるのに置き方が見つからない時（手順の先後が合わない等）も、置き方を探し尽くしたとは言わない。
  const noSlot =
    decisionDeadline === undefined &&
    template.steps.some((step) => {
      const who = step.assigneeId !== undefined ? [step.assigneeId] : only ? [only] : adults;
      return !who.some((id) =>
        slotsBetweenDates(household, id, firstDate, addDays(firstDate, 13)).some((slot) =>
          usableIn(step, slot, household).some(
            (piece) => piece.end - piece.start >= step.durationMin,
          ),
        ),
      );
    });
  return {
    templateId: template.id,
    ruleDeadline: deadline,
    ...(decisionDeadline === undefined ? {} : { decisionDeadline }),
    steps: best ?? [],
    // 決め時を出せない案は、決まりの締切が過ぎるまでは過ぎたと言わない（見つからないことを過ぎた証拠にしない）。
    expired: decisionDeadline !== undefined ? decisionDeadline < now : deadline < now,
    ...(noSlot ? { noSlot: true as const } : {}),
  };
}
