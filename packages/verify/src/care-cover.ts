// 子の居場所の取れる手で、手配の時間のうち見てもらえない時間を、家庭の記録と事象の列から独立に照らす（計画エンジンを
// 読まない）。見てもらえるのは、手に書かれた時間（covers）の内から、子を見る家族の大人（watcherId）の、その日の手が
// 離せない時間と、その人がこの手を選んだ後に答えた見られない時間を除いた所だけ。選ぶ前の答えは数えない。covers の
// 無い手と、選んだ後に「分からない」と答えた時間は、確かめられない時間（unsure）。本人が子を見る作業には、見る子と
// 手配の時間（watch）が、引き受けの控えに入るように付いているかも照らす。
import type {
  Arrangement,
  CareOptionTemplate,
  DomainEvent,
  Household,
  OptionPlan,
  PlanResult,
} from '@maniau/core';
import type { History } from './history';
import type { Collector } from './report';
import { type Interval, instantMinute, localMinute, timeOfDay } from './time';

interface Gap extends Interval {
  unsure?: true;
}

/** 区間から、別の区間の集まりを除いた残り（どちらも同じ日の分）。 */
function subtract(from: Interval, cuts: readonly Interval[]): Interval[] {
  let rest: Interval[] = from.start < from.end ? [from] : [];
  for (const cut of cuts) {
    if (cut.start >= cut.end) continue;
    rest = rest.flatMap((piece) => {
      if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
      const left = cut.start > piece.start ? [{ start: piece.start, end: cut.start }] : [];
      const right = cut.end < piece.end ? [{ start: cut.end, end: piece.end }] : [];
      return [...left, ...right];
    });
  }
  return rest;
}

/** その日の分にした区間（日をまたぐ物は読めない）。 */
function dayRange(start: string, end: string, date: string, tz: string): Interval | undefined {
  const from = localMinute(instantMinute(start), tz);
  const to = localMinute(instantMinute(end), tz);
  if (from.date !== date || to.date !== date) return undefined;
  return { start: from.minuteOfDay, end: to.minuteOfDay };
}

/**
 * 事象の列から、案を最後に選んだ seq と、大人のその日の答えが最後に変わった seq を数える（家の情報の事象を順に
 * 比べる。同じ中身の書き直しは数えない）。
 */
export function careChoiceHistory(events: readonly DomainEvent[]): {
  chosen: Map<string, number>;
  answered: Map<string, number>;
} {
  const chosen = new Map<string, number>();
  const answered = new Map<string, number>();
  let previous = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'optionChosen') chosen.set(event.optionKey, event.seq);
    if (event.type !== 'householdSet') continue;
    const now = new Map(
      (event.household.dayAnswers ?? []).map((a) => [
        `${a.memberId}|${a.date}`,
        JSON.stringify([a.can, a.cannot, a.rest]),
      ]),
    );
    for (const key of new Set([...previous.keys(), ...now.keys()])) {
      if (previous.get(key) !== now.get(key)) answered.set(key, event.seq);
    }
    previous = now;
  }
  return { chosen, answered };
}

/** 手配の時間（その日の分）のうち、この手で見てもらえない時間。 */
export function expectedCareGaps(
  household: Household,
  template: CareOptionTemplate,
  date: string,
  window: Interval,
  optionKey: string,
  history: { chosen: ReadonlyMap<string, number>; answered: ReadonlyMap<string, number> },
): Gap[] {
  const covers = template.covers;
  if (covers === undefined) return [{ ...window, unsure: true }];
  const range: Interval =
    covers === 'whole' ? window : { start: timeOfDay(covers.start), end: timeOfDay(covers.end) };
  const cannot: Interval[] = (household.unavailable ?? [])
    .filter((u) => u.memberId === template.watcherId && u.date === date)
    .map((u) => ({ start: timeOfDay(u.start), end: timeOfDay(u.end) }));
  const unknown: Interval[] = [];
  const watcher = template.watcherId;
  if (watcher !== undefined) {
    const answer = household.dayAnswers?.find((a) => a.memberId === watcher && a.date === date);
    const answeredAt = history.answered.get(`${watcher}|${date}`);
    const chosenAt = history.chosen.get(optionKey);
    if (answer && answeredAt !== undefined && chosenAt !== undefined && answeredAt > chosenAt) {
      const spans = (list: readonly { start: string; end: string }[]) =>
        list.map((s) => ({ start: timeOfDay(s.start), end: timeOfDay(s.end) }));
      cannot.push(...spans(answer.cannot));
      const rest = subtract(window, spans([...answer.can, ...answer.cannot]));
      if (answer.rest === 'cannot') cannot.push(...rest);
      if (answer.rest === 'unknown') unknown.push(...rest);
    }
  }
  const known = subtract(window, subtract(range, cannot));
  const unsure = unknown.flatMap((u) =>
    subtract({ start: Math.max(u.start, window.start), end: Math.min(u.end, window.end) }, known),
  );
  return [...known, ...unsure.map((u) => ({ ...u, unsure: true as const }))].sort(
    (a, b) => a.start - b.start,
  );
}

/**
 * 子の居場所の手配の、ある手で見てもらえない時間（家庭の記録と事象の列から。手配の時間を一日の内として読めない時と、
 * 手の決まりが無い時は undefined：見てもらえるとは言えない）。知らせの門も、これで確保・選べるかを数える。
 */
export function careOptionGaps(
  household: Household,
  arrangement: Pick<Arrangement, 'start' | 'end'>,
  option: Pick<OptionPlan, 'key' | 'templateId'>,
  history: { chosen: ReadonlyMap<string, number>; answered: ReadonlyMap<string, number> },
): Gap[] | undefined {
  const tz = household.timeZone;
  const date = localMinute(instantMinute(arrangement.start), tz).date;
  const window = dayRange(arrangement.start, arrangement.end, date, tz);
  const template = household.careOptions.find((t) => t.id === option.templateId);
  if (!window || !template) return undefined;
  return expectedCareGaps(household, template, date, window, option.key, history);
}

function sameIntervals(a: readonly Gap[], b: readonly Gap[]): boolean {
  const key = (list: readonly Gap[]) =>
    [...list]
      .sort((x, y) => x.start - y.start)
      .map((x) => `${x.start}-${x.end}${x.unsure ? '?' : ''}`)
      .join(',');
  return key(a) === key(b);
}

export function checkCareCover(
  household: Household,
  plan: PlanResult,
  history: History,
  report: Collector,
): void {
  const tz = household.timeZone;
  const choices = careChoiceHistory(history.events);
  for (const arrangement of plan.arrangements) {
    if (arrangement.kind !== 'childCare' || !arrangement.live) continue;
    const date = localMinute(instantMinute(arrangement.start), tz).date;
    const window = dayRange(arrangement.start, arrangement.end, date, tz);
    if (!window) {
      report.undetermined(
        'care_cover_window_unread',
        arrangement.key,
        '手配の時間を一日の内として読めないので、見てもらえない時間を照らせない。',
      );
      continue;
    }
    const expected = new Map<string, Interval[]>();
    for (const option of arrangement.options) {
      const template = household.careOptions.find((t) => t.id === option.templateId);
      if (!template) continue;
      if (!history.complete) {
        report.undetermined(
          'care_cover_history_incomplete',
          option.key,
          '事象の列がそろわず、選んだ後の答えかを確かめられない。',
        );
        continue;
      }
      const gaps = expectedCareGaps(household, template, date, window, option.key, choices);
      expected.set(option.key, gaps);
      const reported = (option.coverGaps ?? []).map((g) => {
        const range = dayRange(g.start, g.end, date, tz);
        return range && (g.unsure ? { ...range, unsure: true as const } : range);
      });
      if (reported.some((r) => r === undefined)) {
        report.violation(
          'care_cover_gap_unread',
          option.key,
          '手の見てもらえない時間が、手配の日の内に読めない。',
        );
        continue;
      }
      if (gaps.length > 0 && option.coverGaps === undefined) {
        report.violation(
          'care_cover_gap_missing',
          option.key,
          '家庭の記録では見てもらえない時間が残る手を、手配の時間の全部を見てもらえるとしている。',
        );
      } else if (!sameIntervals(gaps, reported as Gap[])) {
        report.violation(
          'care_cover_gap_mismatch',
          option.key,
          '手の見てもらえない時間が、家庭の記録から求めた物と違う。',
        );
      }
    }
    // 勧める手は、手配の時間の全部を見てもらえる物だけ。
    const recommended = arrangement.recommendedOptionKey;
    if (recommended !== undefined && (expected.get(recommended)?.length ?? 0) > 0) {
      report.violation(
        'care_cover_gap_recommended',
        arrangement.key,
        '見てもらえない時間が残る手を勧めている。',
      );
    }
    // 今使う手で見てもらえない時間が残れば、手配にその時間を書く（済んだとは言わない）。
    const inUse = arrangement.inUseOptionKey;
    const holes = inUse === undefined ? [] : (expected.get(inUse) ?? []);
    const notCovered = arrangement.reasons.filter((r) => r.code === 'notCovered');
    const written = notCovered.flatMap((r) =>
      r.refs.map((ref) => {
        const [start, end] = ref.split('/');
        return start === undefined || end === undefined
          ? undefined
          : dayRange(start, end, date, tz);
      }),
    );
    if (holes.length > 0) {
      if (
        notCovered.length !== 1 ||
        written.some((w) => w === undefined) ||
        !sameIntervals(
          holes.map((h) => ({ start: h.start, end: h.end })),
          written as Interval[],
        )
      ) {
        report.violation(
          'care_not_covered_missing',
          arrangement.key,
          '今使う手で見てもらえない時間が残るのに、手配にその時間が書かれていない。',
        );
      }
    } else if (notCovered.length > 0) {
      report.violation(
        'care_not_covered_unfounded',
        arrangement.key,
        '今使う手で手配の時間の全部を見てもらえるのに、見てもらえない時間を書いている。',
      );
    }
    // 本人が子を見る手の、その本人の手順の作業には、見る子と手配の時間が付く（引き受けの控えに入る）。ほかの作業には
    // 付かない。
    for (const option of arrangement.options) {
      const template = household.careOptions.find((t) => t.id === option.templateId);
      for (const key of option.taskKeys) {
        const task = plan.tasks.find((t) => t.key === key);
        if (!task) continue;
        const step = template?.steps.find((s) => task.step?.stepId === s.id);
        const watcher =
          template?.watcherId !== undefined && step?.assigneeId === template.watcherId;
        const ok = watcher
          ? task.watch !== undefined &&
            task.watch.childId === arrangement.childId &&
            instantMinute(task.watch.start) === instantMinute(arrangement.start) &&
            instantMinute(task.watch.end) === instantMinute(arrangement.end)
          : task.watch === undefined;
        if (!ok) {
          report.violation(
            'care_watch_mismatch',
            task.key,
            '子を見る本人の作業に、見る子と手配の時間が正しく付いていない（または、ほかの作業に付いている）。',
          );
        }
      }
    }
  }
}
