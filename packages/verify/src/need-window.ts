// 事項に書かれた日時と、後に家族が決めた候補の日時を区別する。
import type { DomainEvent, Item, PlanResult } from '@maniau/core';
import type { NeedWhenWindow } from './need-when';

export interface NeedWindows {
  /** 候補と決定を事象から独立に照らせた窓。 */
  chosen: ReadonlyMap<string, NeedWhenWindow>;
  /** 候補が現在ある、または計画に候補が出ている用件。 */
  hasCandidates: ReadonlySet<string>;
}

export function needWindows(
  events: readonly DomainEvent[],
  plan: PlanResult,
  chosen: ReadonlyMap<string, NeedWhenWindow>,
): NeedWindows {
  const hasCandidates = new Set<string>();
  for (const event of events) {
    if (event.type !== 'needCandidatesSet') continue;
    hasCandidates.add(event.itemId);
  }
  // 履歴が足りないときに、計画の候補を無視して旧い窓を今の窓と断定しない。
  for (const requirement of plan.requirements)
    if (requirement.when) for (const id of requirement.basis.itemIds) hasCandidates.add(id);
  return { chosen, hasCandidates };
}

/** 時刻の検証にだけ使う一時的な見方。元の事項や事象は書き換えない。 */
export function timedNeedItem(item: Item | undefined, windows: NeedWindows): Item | undefined {
  if (item?.kind !== 'need' || item.interpretation.shape !== 'window') return item;
  if (!windows.hasCandidates.has(item.id)) return item;
  const candidate = windows.chosen.get(item.id);
  return {
    ...item,
    interpretation: {
      ...item.interpretation,
      date: candidate?.date,
      startTime: candidate?.startTime,
      endTime: candidate?.endTime,
      startTimeUnconfirmed: undefined,
      endTimeUnconfirmed: undefined,
    },
  };
}
