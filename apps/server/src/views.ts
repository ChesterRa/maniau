// 画面に渡す見せる物（02-foundation §7.1）。計画はサーバーだけで作り、画面ではエンジンを動かさない。
import {
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type Household,
  type PlanResult,
  type Source,
  type TodayCard,
  todayCards,
} from '@maniau/core';
import { foldEvents, type LiveItem, liveItems, planFromState } from '@maniau/core/engine';

export interface View {
  /** この見せる物を作った、最後の通し番号。命令に付けて返すと、見た版が分かる。 */
  throughSeq: number;
  /** 計画の時刻（デモの時計を進めていれば、その時刻）。 */
  now: DateTime;
  household: Household;
  plan: PlanResult;
  /** その大人の「きょう」の札。 */
  today: { main: TodayCard[]; quiet: TodayCard[] };
  /** 元の文（どの予定からも戻れるように）。 */
  sources: Source[];
  /** 今の事項（確かめてほしい推定も含む）。 */
  items: LiveItem[];
}

/** 事象の列から、その大人に見せる物を作る。 */
export function viewFor(events: readonly DomainEvent[], memberId: string, now: DateTime): View {
  const state = foldEvents(events);
  const household = state.household;
  if (!household) throw new Error('家族の情報が無い');
  const plan = planFromState(state, now);
  return {
    throughSeq: state.lastSeq,
    now: state.clock === undefined ? now : formatDateTime(state.clock, household.timeZone),
    household,
    plan,
    today: todayCards(plan, memberId),
    sources: [...state.sources.values()],
    items: liveItems(state),
  };
}
