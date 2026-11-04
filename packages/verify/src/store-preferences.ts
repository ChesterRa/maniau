// 買い物の店を、求解器を使わず、元の事項と家族の資源の扱いに照らす。
import type { Household, PlanResult } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';

/**
 * 現在、家庭の店に使われる品の種類。これは分類の決まりを検証器側で照らすための物で、求解器を呼ばない。
 * 分類できない品は不明にする（計画が自分で付けた goods を、品の種類の証拠にしない）。
 */
const KINDS = new Set(['clothing', 'kidsClothing', 'groceries']);
function kindOf(what: string): string | undefined {
  if (KINDS.has(what)) return what;
  if (/シャツ|ズボン|服|靴下|帽子|上履き/.test(what)) return 'kidsClothing';
  if (/弁当|食材/.test(what)) return 'groceries';
  return undefined;
}

export function checkStorePreferences(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  // 店の好みをまだ入れていない家には、この検査の未判定を増やさない。
  const hasPreference = household.resources.some(
    (resource) =>
      resource.use !== 'candidate' &&
      household.places.some((place) => place.kind === 'store' && place.id === resource.placeId),
  );
  for (const task of plan.tasks) {
    if (!task.live || ['done', 'declined', 'withdrawn', 'cancelled'].includes(task.commitment)) {
      continue;
    }
    const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
    if (arrangement?.kind !== 'purchase' || !arrangement.live) continue;
    const placeId = task.atPlaceId ?? task.placeId;
    if (!placeId) continue;
    const place = household.places.find((entry) => entry.id === placeId);
    if (place?.kind !== 'store') continue; // 場所の欠落・種類は schedule が照らす。

    const records = household.resources.filter((entry) => entry.placeId === placeId);
    if (!history.complete || records.length > 1) {
      if (hasPreference)
        report.undetermined(
          'store_preference_unverified',
          task.key,
          'この店の家族の扱いを一意に確かめられない。',
        );
      continue;
    }
    if (records[0]?.use === 'notUsed') {
      report.violation(
        'store_not_used',
        task.key,
        '家族が使わないとした店に、買い物を置いている。',
        placeId,
      );
    }

    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    const id = requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
    const item = id === undefined ? undefined : facts.items.get(id);
    if (
      !id ||
      !item ||
      item.kind !== 'belongings' ||
      facts.active.get(id) !== true ||
      facts.staleItems.has(id)
    ) {
      if (hasPreference)
        report.undetermined(
          'store_preference_unverified',
          task.key,
          '買う品物を元の事項から確かめられない。',
        );
      continue;
    }
    const what = item.interpretation.what ?? item.written;
    const shops = household.places.filter((entry) => entry.kind === 'store');
    // 品物名が種類名と同じなら、品物だけの選択とは決めない。
    const explicit = KINDS.has(what) ? [] : shops.filter((entry) => entry.goods.includes(what));
    if (explicit.length > 1) {
      if (hasPreference)
        report.undetermined(
          'store_preference_unverified',
          task.key,
          'この品物のために選んだ店を一つに定められない。',
        );
      continue;
    }
    if (explicit[0]) {
      if (explicit[0].id !== placeId) {
        report.violation(
          'store_choice_bypassed',
          task.key,
          '家族がこの品物のために選んだ店と、買い物を置いた店が違う。',
          explicit[0].id,
        );
      }
      continue;
    }
    if (!hasPreference) continue;
    const kind = kindOf(what);
    if (!kind) {
      report.undetermined(
        'store_preference_unverified',
        task.key,
        'この品物を扱う店の種類を独立に確かめられない。',
      );
      continue;
    }
    const relevant = shops.filter((entry) => entry.goods.includes(kind));
    const ambiguous = relevant.some(
      (entry) => household.resources.filter((resource) => resource.placeId === entry.id).length > 1,
    );
    if (ambiguous) {
      report.undetermined(
        'store_preference_unverified',
        task.key,
        '同じ店の家族の扱いが複数あり、いつもの店を確かめられない。',
      );
      continue;
    }
    const usual = relevant.filter((entry) =>
      household.resources.some(
        (resource) => resource.placeId === entry.id && resource.use === 'usual',
      ),
    );
    if (usual.length > 0 && !usual.some((entry) => entry.id === placeId)) {
      report.violation(
        'usual_store_bypassed',
        task.key,
        '家族がいつも使うとした店があるのに、別の店に買い物を置いている。',
        usual[0]?.id,
      );
    }
  }
}
