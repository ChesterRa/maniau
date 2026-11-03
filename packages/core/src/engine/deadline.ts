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
  /** now より決め時が前なら、もう選べない。 */
  expired: boolean;
}

/** 手順を置ける区間か（区間の種類、決まった場所、人）。 */
function slotFits(step: StepTemplate, slot: Slot): boolean {
  if (!step.segments.includes(slot.kind)) return false;
  if (step.placeId !== undefined && slot.placeId !== step.placeId) return false;
  return true;
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
): PlacedStep[] | undefined {
  const placed: PlacedStep[] = [];
  let bound = latestEnd;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) return undefined;
    const who = step.assigneeId ?? memberId;
    if (placed[0] && placed[0].memberId !== who) return undefined;
    const slots = slotsByMember.get(who) ?? [];
    let best: PlacedStep | undefined;
    for (const slot of slots) {
      if (!slotFits(step, slot)) continue;
      const end = Math.min(slot.end, bound);
      const start = end - step.durationMin;
      if (start < slot.start) continue;
      if (!best || start > best.start) {
        best = { stepId: step.id, memberId: who, start, end, slot };
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
  return placeChain([step], memberId, new Map([[memberId, free]]), latestEnd)?.[0];
}

/**
 * 案の決め時を、手順の逆算で求める。探すのは now の日から締切の日まで。only を渡すと、その大人だけで手順を
 * 置く（担当の決まった作業を、担当の人のふだんの時間に置くため）。busy を渡すと、その人のほかの作業が使う
 * 時間には置かない（家族が進める案どうしを、同じ人の同じ時間に重ねないため。joint.ts）。from を渡すと、
 * それより前には置かない（済ませた手順の後に待つ時間がある時。now より前に置けるのは、過ぎた決め時を示すため）。
 */
export function optionDeadline(
  template: CareOptionTemplate,
  needDate: LocalDate,
  household: Household,
  now: EpochMinutes,
  only?: string,
  busy: ReadonlyMap<string, readonly Busy[]> = new Map(),
  from?: EpochMinutes,
): OptionDeadline {
  const deadline = ruleDeadline(template.deadline, needDate, household);
  const tz = household.timeZone;
  const firstDate = localDateOf(Math.min(now, deadline), tz);
  const lastDate = localDateOf(deadline, tz);
  const adults = activeAdultIds(household);
  const fixed = template.steps.map((s) => s.assigneeId).filter((id) => id !== undefined);
  const members = [...new Set([...adults, ...fixed, ...(only === undefined ? [] : [only])])];
  const slotsByMember = new Map(
    members.map((id) => [
      id,
      slotsBetweenDates(household, id, firstDate, lastDate)
        .map((slot) => (from === undefined ? slot : { ...slot, start: Math.max(slot.start, from) }))
        .flatMap((slot) => withoutBusy(slot, busy.get(id) ?? []))
        .filter((slot) => slot.end > slot.start),
    ]),
  );
  const candidates =
    only !== undefined
      ? [only]
      : fixed.length === template.steps.length
        ? [fixed[0] ?? '']
        : adults;

  let best: PlacedStep[] | undefined;
  for (const memberId of candidates) {
    const chain = placeChain(template.steps, memberId, slotsByMember, deadline);
    const first = chain?.[0];
    if (chain && first && (!best || first.start > (best[0]?.start ?? -Infinity))) best = chain;
  }
  const decisionDeadline = best?.[0]?.start;
  return {
    templateId: template.id,
    ruleDeadline: deadline,
    ...(decisionDeadline === undefined ? {} : { decisionDeadline }),
    steps: best ?? [],
    expired: decisionDeadline === undefined ? true : decisionDeadline < now,
  };
}
