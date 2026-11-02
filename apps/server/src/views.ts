// 画面に渡す見せる物（02-foundation §7.1）。計画はサーバーだけで作り、画面ではエンジンを動かさない。
import {
  type ChangeSummary,
  changeOpen,
  changeSummary,
  type DateTime,
  type DomainEvent,
  Extraction,
  formatDateTime,
  type Household,
  type PlanResult,
  type Source,
  type TodayCard,
  todayCards,
} from '@maniau/core';
import {
  currentReadings,
  type EngineState,
  foldEvents,
  type LiveItem,
  liveItems,
  planFromState,
} from '@maniau/core/engine';

export interface View {
  /** この見せる物を作った、最後の通し番号。命令に付けて返すと、見た版が分かる。 */
  throughSeq: number;
  /** 計画の時刻（デモの時計を進めていれば、その時刻）。 */
  now: DateTime;
  household: Household;
  plan: PlanResult;
  /** その大人の「きょう」の札。 */
  today: { main: TodayCard[]; quiet: TodayCard[] };
  /** 後から届いたお知らせで変わったこと（二人に同じ物。取り消しが済み、一日たつまで）。 */
  changes?: ChangeSummary;
  /** 元の文（どの予定からも戻れるように）。 */
  sources: Source[];
  /** 出典ごとの読み取り（どのモデルが読んだか）。後から入れたお知らせの物も含む。 */
  /** 出典ごとの最後の読み取り：読んだモデルと、家族に確かめてほしい文（どの文か分からない時は全体）。 */
  readings: { sourceId: string; model: string; check: string[]; checkAll: boolean }[];
  /** 今の事項（確かめてほしい推定も含む）。条件しだいの事項には、分かる時だけ条件を添える。 */
  items: (LiveItem & { when?: ItemWhen })[];
}

/**
 * 条件しだいの事項の条件。一つの未定の値で決まる時だけ作る（画面は「開催日が12/5（土）なら」と書く）。
 * 二つ以上の値の組み合わせは作らず、画面は「条件しだい」とだけ書く（長い式を短く言い換えない）。
 */
export interface ItemWhen {
  /** 未定の値の名前（お知らせの言葉）。 */
  label: string;
  value: string;
  /** その値でない時に当てはまる。 */
  not?: true;
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
    ...withChange(events, plan),
    sources: [...state.sources.values()],
    readings: readingsOf(events),
    items: withWhen(state),
  };
}

/**
 * 条件の分からない事項に、一つの値で決まる条件を添える（効くか分からない作用の先の物には付けない）。
 * 未定の値の名前と条件の式は、今も確かな読み取り（取り下げていない出典の、今の版の文を読んだ物）
 * からだけ取る。確かめられない時は添えず、画面は「条件しだい」とだけ書く（事項は隠さない）。
 */
function withWhen(state: EngineState): View['items'] {
  const extractions = currentReadings(state);
  const nodes = new Map(extractions.flatMap((e) => e.conditions).map((n) => [n.id, n]));
  const labels = new Map(extractions.flatMap((e) => e.unknowns).map((u) => [u.id, u.label]));
  const whenOf = (id: string): ItemWhen | undefined => {
    const node = nodes.get(id);
    const eq = node?.kind === 'not' ? nodes.get(node.childId) : node;
    const label = eq?.kind === 'eq' ? labels.get(eq.unknownId) : undefined;
    if (eq?.kind !== 'eq' || label === undefined) return undefined;
    return { label, value: eq.value, ...(node?.kind === 'not' ? { not: true as const } : {}) };
  };
  return liveItems(state).map((l) => {
    const id = l.item.conditionNodeId;
    const when = l.conditional && !l.doubted && id !== undefined ? whenOf(id) : undefined;
    return when ? { ...l, when } : l;
  });
}

/** 出典ごとの最後の読み取りのモデル。 */
function readingsOf(events: readonly DomainEvent[]): View['readings'] {
  const last = new Map<string, View['readings'][number]>();
  for (const e of events) {
    if (e.type === 'modelOutputRecorded' && e.call === 'extract' && e.sourceId) {
      // 形の分からない読み取りは、全体を確かめてもらう。
      const read = Extraction.safeParse(e.output);
      last.set(e.sourceId, {
        sourceId: e.sourceId,
        model: e.model,
        check: read.success ? (read.data.checkSentenceIds ?? []) : [],
        checkAll: read.success ? (read.data.checkAll ?? false) : true,
      });
    }
  }
  return [...last.values()];
}

/** 変わったことを見るお知らせの数（新しい物から）。 */
const CHANGE_LOOKBACK = 3;

/**
 * 最後に、前から用意していた物を変えたお知らせのまとめ。お知らせの前の事象で作った計画と、今の計画を
 * 同じ時刻で比べる（新しく要る物だけのお知らせは飛ばし、前のお知らせを見る）。
 */
function withChange(events: readonly DomainEvent[], plan: PlanResult): { changes?: ChangeSummary } {
  const notices = events.filter((e) => e.type === 'noticeReceived').slice(-CHANGE_LOOKBACK);
  for (const notice of notices.reverse()) {
    if (notice.type !== 'noticeReceived') continue;
    const state = foldEvents(events.filter((e) => e.seq < notice.seq));
    if (!state.household) continue;
    const summary = changeSummary(planFromState(state, plan.now), plan, {
      id: notice.source.id,
      receivedAt: notice.source.receivedAt,
    });
    if (summary) return changeOpen(summary, plan.now) ? { changes: summary } : {};
  }
  return {};
}
