// 一度だけ済ませておく前提（事前の登録など。家の情報の Preparation）が、ある「すること」で満たされているか。
// エンジン（案の印）と画面（「うち」の一覧）が同じ見方を使う。前提の種類で分けない。
import type { Household, Preparation, Way } from '../schema/household';
import { addDays, type LocalDate } from '../time';

/**
 * 満たされていない前提の一つ。state：unknown・notDone・inProgress は家族が確かめた状態のまま。expired は、済んだが
 * 有効な最後の日が使う日より前。appliesUnknown は、前提がだれの物か分からない（済んでも借りない）。personUnknown
 * は、前提が人ごとで、だれのための「すること」か分からない。otherPerson は、前提がほかの人の物（借りない）。by は、
 * 家族が確かめた日数（使う日の N 日前、暦の日）から求めた、済ませておく最後の日（無ければ「早めに確かめる」とだけ
 * 言う）。
 */
export interface PreparationGap {
  preparationId: string;
  state:
    | 'unknown'
    | 'notDone'
    | 'inProgress'
    | 'expired'
    | 'appliesUnknown'
    | 'personUnknown'
    | 'otherPerson';
  by?: LocalDate;
}

/** その前提が、その人のその日に満たされているか（満たされていなければ、訳）。 */
export function preparationGap(
  preparation: Preparation | undefined,
  preparationId: string,
  useDate: LocalDate,
  forMemberId: string | undefined,
): PreparationGap | undefined {
  // 家の情報に無い前提は、分からない（済んだとは言わない）。
  if (!preparation) return { preparationId, state: 'unknown' };
  const by = preparation.lead ? addDays(useDate, -preparation.lead.days) : undefined;
  const gap = (state: PreparationGap['state']): PreparationGap => ({
    preparationId,
    state,
    ...(by === undefined ? {} : { by }),
  });
  const applies = preparation.appliesTo;
  if (applies.kind === 'unknown') return gap('appliesUnknown');
  if (applies.kind === 'members') {
    if (forMemberId === undefined) return gap('personUnknown');
    if (!applies.memberIds.includes(forMemberId)) return gap('otherPerson');
  }
  if (preparation.state !== 'done') return gap(preparation.state);
  if (preparation.validUntil !== undefined && preparation.validUntil < useDate) {
    return gap('expired');
  }
  return undefined;
}

/** やり方の前提のうち、その「すること」（使う日・だれのため）で満たされていない物を全部。 */
export function preparationGaps(
  household: Household,
  way: Pick<Way, 'requires'>,
  useDate: LocalDate,
  forMemberId: string | undefined,
): PreparationGap[] {
  return (way.requires ?? []).flatMap((id) => {
    const gap = preparationGap(
      household.preparations.find((p) => p.id === id),
      id,
      useDate,
      forMemberId,
    );
    return gap ? [gap] : [];
  });
}

/** やり方が使う周りの資源のうち、家族が「使わない」とした物（家の情報に無い資源は、使わないとは言わない）。 */
export function unusedResources(household: Household, way: Pick<Way, 'resourceIds'>): string[] {
  return (way.resourceIds ?? []).filter(
    (id) => household.resources.find((r) => r.id === id)?.use === 'notUsed',
  );
}
