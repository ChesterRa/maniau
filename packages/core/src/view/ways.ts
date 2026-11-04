// やり方の案について、計算と画面が同じ決まりで見る事（エンジンの勧め方と、画面の「勧めない理由」・案の注）。
import type { Household, Place, StepTemplate, WayStep } from '../schema/household';
import type { Arrangement, OptionPlan } from '../schema/plan';

/** 通用の「すること」の案が、家族がやめたやり方の物（これからは新しく選べない）。 */
export function stoppedWay(
  household: Household,
  arrangement: Pick<Arrangement, 'kind'>,
  option: Pick<OptionPlan, 'templateId'>,
): boolean {
  return arrangement.kind === 'need' && (household.stoppedWayIds ?? []).includes(option.templateId);
}

/**
 * 家以外の場所で、行ける時間（営業時間など）を確かめていない物：営業時間の登録が無い、地図（Google）から得た時間
 * だけ、開店と閉店が同じ時刻の書き方がある。どれも、計算は営業時間で絞らない（deadline.ts の usableIn と同じ
 * 見方。閉まっているとも言わない）ので、その時に行けるかは確かめていない。どの場所が時間を確かめる要る所かは、
 * まだ見分けない（見分けられないので、家以外は全部そう扱う）。
 */
export function hoursUnconfirmed(place: Place): boolean {
  if (place.kind === 'home') return false;
  const hours = place.hours;
  return (
    hours === undefined ||
    hours.source === 'googlePlaces' ||
    hours.periods.some((p) => p.open === p.close)
  );
}

/**
 * 案の手順の決まった場所のうち、行ける時間を確かめていない物（hoursUnconfirmed。無ければ空）。決め時は営業時間で
 * 絞らずに出すが、間に合うとは言えない。
 */
export function placesWithoutHours(
  household: Household,
  arrangement: Pick<Arrangement, 'kind'>,
  option: Pick<OptionPlan, 'templateId'>,
): Place[] {
  const steps: readonly (StepTemplate | WayStep)[] =
    arrangement.kind === 'need'
      ? (household.ways.find((w) => w.id === option.templateId)?.steps ?? [])
      : (() => {
          const template = household.careOptions.find((t) => t.id === option.templateId);
          return template ? [...template.steps, ...template.extraSteps] : [];
        })();
  const found = new Map<string, Place>();
  for (const step of steps) {
    const place = household.places.find((p) => p.id === step.placeId);
    if (place && hoursUnconfirmed(place)) found.set(place.id, place);
  }
  return [...found.values()];
}

/** 案の手順に、行ける時間を確かめていない決まった場所がある（placesWithoutHours）。 */
export function hoursUnknownAt(
  household: Household,
  arrangement: Pick<Arrangement, 'kind'>,
  option: Pick<OptionPlan, 'templateId'>,
): boolean {
  return placesWithoutHours(household, arrangement, option).length > 0;
}
