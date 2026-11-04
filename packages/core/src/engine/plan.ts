// 事象の列と今の時刻から、計画の結果を作る（docs/design/01-model.md §1 の 3〜9）。
// v0：要件 → 手配 → 案と決め時（逆算の目安）→ 問い → 買い物の置き場所 → 取り消しの連絡。
// 子の居場所の手配で家族が進める案どうしは、同じ人の時間が重ならないように一緒に置く（joint.ts。少数の手配の
// 並べ方を試す）。買い物・提出物を含めた計画全体の求解（§5 の2）と、最小の組み直し（§8）は、まだ無い。
import {
  conditionShape,
  evaluateCondition,
  mentionsUnknown,
  NO_CONDITION,
  type Truth,
} from '../schema/condition';
import {
  type DomainEvent,
  proposalSnapshot,
  type RequestSnapshot,
  sameContent,
  sameProposal,
  type TaskContent,
} from '../schema/events';
import {
  type CareOptionTemplate,
  type Cost,
  type DeadlineRule,
  GOODS_KINDS,
  type Household,
  type StepTemplate,
  type Way,
} from '../schema/household';
import type { MapInputs } from '../schema/maps';
import type {
  Arrangement,
  Basis,
  CommitmentState,
  ExternalRequest,
  OptionPlan,
  PlanResult,
  PlanStatus,
  Question,
  Reason,
  Released,
  Requirement,
  Task,
} from '../schema/plan';
import { isNeedArrangementKey } from '../schema/plan';
import type { ConditionNode, Item, Unknown } from '../schema/source';
import {
  addDays,
  type DateTime,
  type EpochMinutes,
  formatDateTime,
  isValidDateTime,
  type LocalDate,
  localDateOf,
  toEpochMinutes,
  zonedToEpochMinutes,
} from '../time';
import { type DutyTurn, dutyTurn, statedTurn } from '../view/ours';
import { preparationGaps, unusedResources } from '../view/preparations';
import { isActiveTask } from '../view/today';
import { hoursUnknownAt, stoppedWay } from '../view/ways';
import { noAdultAtHome } from './availability';
import { type Busy, optionDeadline, placeStep, ruleDeadline } from './deadline';
import { bestOrder } from './joint';
import { purchaseOpportunities, purchaseStores, searchPurchase } from './purchase';
import {
  awaitingConfirmation,
  currentItems,
  currentReadings,
  type EngineState,
  foldEvents,
  itemFate,
  needWaysBasis,
  type RequestRecord,
  retiredUnknowns,
} from './state';

/** 代償の重みの初期値（家族が変えられる。§8）。安い案ほど小さい。 */
export const DEFAULT_COST_WEIGHTS = {
  leaveMinutes: 1,
  helperRequests: 200,
  yen: 0.1,
  extraTasks: 30,
};
const PURCHASE_MINUTES = 15;
/** 提出物を用意して出す（かばんに入れる）時間の目安。 */
const SUBMIT_MINUTES = 10;
/** 問いの期限は、最後の買える時より、この分だけ前に置く（答えを受けて動ける時間）。 */
const QUESTION_LEAD_MIN = 24 * 60;

/**
 * 問いの期限：動ける時間を残した目安の時（early）がまだ先ならそれ、過ぎていれば答えが役に立つ最後の時
 * （latest）。今に揃えない（期限が今と同じ問いは、知らせの意図にならず、押しの知らせが一度も出ない）。
 */
function askByOf(ctx: Context, early: EpochMinutes, latest: EpochMinutes): EpochMinutes {
  return early > ctx.now ? early : latest;
}

/** 安定したキー（§4）。種類と、置き換えをたどった元の事項の ID から作る。時刻や担当は入れない。 */
export const keys = {
  childCareRequirement: (rootId: string, childId: string) => `req:childCare:${rootId}:${childId}`,
  childCareArrangement: (rootId: string, childId: string) => `arr:childCare:${rootId}:${childId}`,
  belongingsRequirement: (rootId: string) => `req:belongings:${rootId}`,
  submissionRequirement: (rootId: string) => `req:submission:${rootId}`,
  submissionTask: (rootId: string) => `task:submit:${rootId}`,
  dutyRequirement: (rootId: string) => `req:duty:${rootId}`,
  dutyTask: (rootId: string) => `task:duty:${rootId}`,
  escortRequirement: (rootId: string) => `req:escort:${rootId}`,
  escortTask: (rootId: string, leg: 'to' | 'from') => `task:escort:${leg}:${rootId}`,
  purchaseArrangement: (rootId: string) => `arr:purchase:${rootId}`,
  needRequirement: (rootId: string) => `req:need:${rootId}`,
  needArrangement: (rootId: string) => `arr:need:${rootId}`,
  option: (arrangementKey: string, templateId: string) => `opt:${arrangementKey}:${templateId}`,
  task: (optionKey: string, stepId: string) => `task:${optionKey}:${stepId}`,
  cancellationTask: (requestId: string) => `task:cancel:${requestId}`,
  atHomeUnknown: (rootId: string) => `u-atHome:${rootId}`,
  question: (unknownId: string) => `q:${unknownId}`,
};

export function costScore(cost: Cost, weights = DEFAULT_COST_WEIGHTS): number {
  return (
    cost.leaveMinutes * weights.leaveMinutes +
    cost.helperRequests * weights.helperRequests +
    cost.yen * weights.yen +
    cost.extraTasks * weights.extraTasks
  );
}

/**
 * 品物を買う店を見分ける種類。品物の名前が種類の名前そのもの（例：groceries）なら、その種類（家族が品物のために
 * 選んだ店とは見なさない）。家族がこの品物のために選んだ店（扱う物に品物の名前そのものがある店）があれば、その名前を
 * 使い、その店だけで買う（ほかの店より先）。無ければ、小さな対応表の種類（服・食材）。
 */
export function purchaseGoods(household: Household, what: string): string | undefined {
  if (GOODS_KINDS.has(what)) return what;
  const chosen = household.places.some((p) => p.kind === 'store' && p.goods.includes(what));
  return chosen ? what : goodsFor(what);
}

/** 品物の名前から、店で扱う品物の種類へ。小さな対応表（服・食材）。ほかは家族が地図で店を選ぶ。 */
export function goodsFor(what: string): string | undefined {
  if (/シャツ|ズボン|服|靴下|帽子|上履き/.test(what)) return 'kidsClothing';
  if (/弁当|食材/.test(what)) return 'groceries';
  return undefined;
}

interface Context {
  state: EngineState;
  household: Household;
  now: EpochMinutes;
  tz: string;
  fmt: (m: EpochMinutes) => DateTime;
  /** 今の事項（ID ごと）。作業の根拠が今、確かでないか（doubted）を引く。 */
  items: ReadonlyMap<string, LiveItem>;
  /** この計算のために地図から引いた根拠（無ければ家庭の目安だけで計算する）。 */
  maps?: MapInputs;
}

export interface LiveItem {
  item: Item;
  rootId: string;
  rootSourceId: string;
  /** 条件が偽でなければ生きている。分からない時は、間に合わなくならない側で生かす。 */
  live: boolean;
  /** 条件しだい：条件が分からないか、効くか分からない作用の先にある。確かな事実として見せない。 */
  conditional: boolean;
  /** 効くか分からない作用（置き換え・取り消し）の先にある。頼んだ後なら、要るかを確かめる。 */
  doubted: boolean;
  /** 記載か家族の確認。推定・食い違いは、家族が確かめるまで要件を作らない（02-foundation §1 の2）。 */
  trusted: boolean;
  /** 家の人の当番だけ：うちの番か（dutyTurn。エンジンと画面は、これを使う）。 */
  turn?: DutyTurn;
  /** turn が、家族の言明（今も当たる物）による。 */
  turnStated?: true;
  /** 習い事・クラブの行事だけ：送り迎えの今の見立て（escortFrameOf。エンジンと画面は、これを使う）。 */
  escort?: EscortFrame;
}

/** 送り（to）か迎え（from）の一方。 */
export interface EscortLeg {
  leg: 'to' | 'from';
  /** その方の日（迎えは、終わりが次の日と読めれば次の日）。 */
  date: LocalDate;
  /**
   * 書かれた時刻（送りは始まり、迎えは終わり）。書かれていない・確かめられない・日を決められない時は無し
   * （その日の作業にする）。
   */
  at?: string;
  /** 時刻が書かれていたが、読み取りで確かめられないか、どの日の時刻か決められない（元の文で確かめる）。 */
  timeUnconfirmed?: true;
  /**
   * 迎えの日を決められない（「翌日」と書かれた終わり等）。date は行事の日（言明を結ぶため）で、迎えの日では
   * ない。作業には日も時刻も付けない（行事の日を迎えの日として見せない）。
   */
  dateUnconfirmed?: true;
  /** 今回要るか。家族の言明（今も当たる物）があればそれ、無ければ家の決まり。 */
  needed: boolean;
  /** needed が、家族の言明による。 */
  stated?: true;
}

/** 習い事・クラブの行事の送り迎えの見立て：誰の送り迎えか、どの方が要るか。 */
export interface EscortFrame {
  childId: string;
  legs: EscortLeg[];
}

/**
 * 習い事・クラブの行事（送り手が club の行事）の送り迎えの見立て。家庭の有効な子が一人だけで、その子に家の
 * 決まり（clubEscort）があり、日が書かれた時だけ作る（子が二人以上なら、決まりのある子が一人でも、どの子の
 * 行事か分からない。決まりは、その子をどう送り迎えするかで、お知らせがその子の物という根拠ではない。決まりが
 * 無ければ、書かれていない送り迎えを推し量らない）。家族の言明は、言った時の子・用件・その方の日・書かれた
 * 時刻・場所が今と同じ時だけ当てる。
 * - 送りは書かれた始まり、迎えは書かれた終わり。終わりの日は当番と同じ決まりで決める（endOf：終わりが
 *   始まり以前の時刻か「翌日」などと書かれていれば、長さが 12 時間までの時だけ次の日）。決められない終わりと、
 *   始まりの無い時の終わりは、日も時刻も付けない（dateUnconfirmed。行事の日を迎えの日として見せない）。
 *   読み取りが落とした終わりと、終わりが書かれていないのに「翌日」などとある時も、次の日だったかもしれない
 *   ので同じ（dateUnconfirmed）。読み取りが落とした始まりは、行事の日のどこか（timeUnconfirmed）。
 * - 時刻の書かれていない方も入れる（時刻を付けない。その日の作業にし、送り迎えを黙って落とさない）。
 * - ほかの行事を取り消す事項（中止のお知らせ）には作らない。
 */
export function escortFrameOf(state: EngineState, item: Item): EscortFrame | undefined {
  const household = state.household;
  if (!household || item.kind !== 'event' || state.sources.get(item.sourceId)?.sender !== 'club') {
    return undefined;
  }
  // ほかの行事を取り消すだけの事項（「雨のため中止」）は、出かける行事ではない。
  if (item.effects.some((e) => e.type === 'cancel')) return undefined;
  const children = household.members.filter((m) => m.kind === 'child' && m.active);
  const child = children.length === 1 ? children[0] : undefined;
  const rule = child?.clubEscort;
  const { date, startTime, endTime, place, startTimeUnconfirmed, endTimeUnconfirmed } =
    item.interpretation;
  if (child === undefined || rule === undefined || date === undefined) return undefined;
  const what = item.interpretation.what ?? item.written;
  const tz = household.timeZone;
  const when = (
    leg: 'to' | 'from',
  ): Pick<EscortLeg, 'date' | 'at' | 'timeUnconfirmed' | 'dateUnconfirmed'> => {
    if (leg === 'to') {
      if (startTime !== undefined) return { date, at: startTime };
      return startTimeUnconfirmed ? { date, timeUnconfirmed: true } : { date };
    }
    if (endTime === undefined) {
      // 読み取りが落とした終わりは、次の日の時刻（「翌日午前1時まで」）だったかもしれない。書かれていなくても、
      // 「翌日」などとあれば次の日かもしれない。どちらも日を決めず、元の文で確かめてもらう。
      if (endTimeUnconfirmed || nextDayWritten(state, item)) {
        return { date, timeUnconfirmed: true, dateUnconfirmed: true };
      }
      return { date };
    }
    // 始まりが無ければ、終わりがその日か次の日か（「翌日01:00終了」）を決められない（読み取りは終わりの日を
    // 持たない）。日も時刻も付けず、元の文で確かめてもらう。
    if (startTime === undefined) return { date, timeUnconfirmed: true, dateUnconfirmed: true };
    // 終わりの日を決められなければ、日も時刻も付けない（行事の日を迎えの日として見せない）。
    const end = endOf(state, item, date, startTime, endTime, tz);
    return end
      ? { date: end.date, at: endTime }
      : { date, timeUnconfirmed: true, dateUnconfirmed: true };
  };
  const legs = (['to', 'from'] as const).map((leg): EscortLeg => {
    const at = when(leg);
    const said = state.escorts.get(`${item.id}:${leg}`);
    const applies =
      said !== undefined &&
      said.childId === child.id &&
      said.what === what &&
      said.date === at.date &&
      said.at === (at.at ?? null) &&
      said.place === (place ?? null);
    return applies
      ? { leg, ...at, needed: said.needed, stated: true }
      : { leg, ...at, needed: rule[leg] };
  });
  return { childId: child.id, legs };
}

/** 次の日を言う言葉（終わりが次の日かもしれない）。 */
const NEXT_DAY = /翌日|翌朝|翌晩|次の日|次の朝|明朝|next day|following day/i;

/** 事項の引用か、指した元の文（引用は文の一部のことがある）に、次の日を言う言葉があるか。 */
function nextDayWritten(state: EngineState, item: Item): boolean {
  const sentences = state.sources.get(item.sourceId)?.sentences ?? [];
  const cited = sentences.filter((s) => item.sentenceIds.includes(s.id)).map((s) => s.text);
  return [item.written, ...cited].some((text) => NEXT_DAY.test(text));
}

/**
 * 書かれた始まりと終わり（時刻だけ）から、終わりの日を決める。終わりが始まりより後ならその日。ただし指した文に
 * 「翌日」などがあれば、その日とは決めない（「9:00から翌日10:00まで」）。終わりが始まり以前の時刻（か「翌日」）
 * なら、次の日の終わりと読める時（長さが 12 時間まで）だけ次の日。ほかは決められない（無し）。
 */
function endOf(
  state: EngineState,
  item: Item,
  date: LocalDate,
  startTime: string,
  endTime: string,
  tz: string,
): { date: LocalDate; at: EpochMinutes } | undefined {
  const start = zonedToEpochMinutes(date, startTime, tz);
  const sameDay = zonedToEpochMinutes(date, endTime, tz);
  if (sameDay > start && !nextDayWritten(state, item)) return { date, at: sameDay };
  const nextDate = addDays(date, 1);
  const nextDay = zonedToEpochMinutes(nextDate, endTime, tz);
  return nextDay > start && nextDay - start <= OVERNIGHT_MAX_MINUTES
    ? { date: nextDate, at: nextDay }
    : undefined;
}

/** 今の事項と、適用されるか・条件しだいか・確かか。 */
export function liveItems(state: EngineState): LiveItem[] {
  const nodes: ConditionNode[] = [...state.extractions.values()].flatMap((e) => e.conditions);
  const assignment = new Map([...state.resolved].map(([id, r]) => [id, r.value]));
  const all = currentItems(state).map(({ item, rootId, rootSourceId, doubted }) => {
    const truth = item.conditionNodeId
      ? evaluateCondition(item.conditionNodeId, nodes, assignment)
      : true;
    return {
      item,
      rootId,
      rootSourceId,
      live: truth !== false,
      conditional: doubted || truth === 'unknown',
      doubted,
      trusted: item.evidence === 'stated' || item.evidence === 'confirmed',
    };
  });
  // 当番がうちの番かは、同じお知らせのほかの行も見て決める（当番表の、うちの行）。ほかの家の番と言う根拠には、
  // 今も効いていて、確かで、条件の無い行だけを使う（条件で外れた・条件しだい・確かでない行を根拠に、残る行を
  // 隠さない）。
  const household = state.household;
  if (!household) return all;
  const evidence = all.filter((l) => l.live && l.trusted && !l.conditional).map((l) => l.item);
  return all.map((l) => {
    const escort = escortFrameOf(state, l.item);
    if (escort) return { ...l, escort };
    if (l.item.kind !== 'duty' || !l.item.interpretation.familyAction) return l;
    const stated = state.turns.get(l.item.id);
    return {
      ...l,
      turn: dutyTurn(household, l.item, evidence, stated),
      ...(statedTurn(l.item, stated) === undefined ? {} : { turnStated: true as const }),
    };
  });
}

export function computePlan(
  events: readonly DomainEvent[],
  now?: DateTime,
  maps?: MapInputs,
): PlanResult {
  return planFromState(foldEvents(events), now, maps);
}

/** たたんだ状態から計画を作る（computePlan の中身。同じ状態を他の計算にも使う時に）。 */
/**
 * maps は、この計算のために地図から引いた根拠（家庭の正本とは別の入力。02-foundation §2.3）。店とその駅に
 * 結び付く時だけ、その店の道のりと営業時間に使う。計画にそのまま添えて返す（同じ要求の画面と検証が使う）。
 */
export function planFromState(state: EngineState, now?: DateTime, maps?: MapInputs): PlanResult {
  const household = state.household;
  if (!household) throw new Error('家族の情報（householdSet）が無い');
  const nowMin = state.clock ?? (now === undefined ? undefined : toEpochMinutes(now));
  if (nowMin === undefined) throw new Error('今の時刻が無い');
  const tz = household.timeZone;
  const items = liveItems(state);
  const ctx: Context = {
    state,
    household,
    now: nowMin,
    tz,
    fmt: (m) => formatDateTime(m, tz),
    items: new Map(items.map((l) => [l.item.id, l])),
    ...(maps ? { maps } : {}),
  };

  const requirements: Requirement[] = [];
  const arrangements: Arrangement[] = [];
  const tasks: Task[] = [];
  const questions: Question[] = [];
  const submissions: {
    item: Item;
    rootId: string;
    live: boolean;
    conditional: boolean;
    titleKey: string;
  }[] = [];
  const duties: {
    item: Item;
    rootId: string;
    live: boolean;
    conditional: boolean;
    unsure: boolean;
  }[] = [];
  const escorts: {
    item: Item;
    rootId: string;
    live: boolean;
    conditional: boolean;
    frame: EscortFrame;
  }[] = [];
  const needs: LiveItem[] = [];

  // 子の居場所の手配は、家族が進める案どうしを一緒に置いてから（joint.ts）、お知らせの順に並べる。
  // 本命が決まって、もう進めない予備（「きょう」に出ない。isActiveTask）は、一緒に置く鎖から外して置き直す
  // （本命が決まったかは依頼の返事で決まり、置き方では変わらないので、置き直しは一度で足りる）。
  const careEntries = items.filter((l) => l.trusted && noSchool(l.item));
  let care = placeCare(ctx, careEntries);
  const idle = idleBackups(ctx, care, items);
  if (idle.size > 0) care = placeCare(ctx, careEntries, idle);
  for (const entry of items) {
    const { item, rootId, rootSourceId, live, trusted, conditional } = entry;
    // 推定・食い違いは、家族が確かめるまで要件を作らない。画面は「確かめてください」として出す。お知らせから読んだ
    // 「すること」は、確かめる札で見比べて直してもらうので、ここでも確かめを待つ要件にする（planNeed。手配は作らない）。
    if (!trusted) {
      if (item.kind === 'need' && !ctx.state.statedSources.has(item.sourceId)) needs.push(entry);
      continue;
    }
    const placed = care.get(entry);
    if (placed) {
      requirements.push(...placed.requirements);
      arrangements.push(...placed.arrangements);
      tasks.push(...placed.tasks);
    }
    if (item.kind === 'belongings') {
      const by = belongingsDeadline(ctx, item, rootSourceId, items);
      purchase(
        ctx,
        item,
        rootId,
        live,
        conditional,
        by,
        // 使う日は、持ち物に書かれた日付だけ（行事の日から推し量らない。行事が二つある・条件しだいの時に
        // 取り違えないように）。書かれた締切は用意の締切で、使う日にしない。
        item.interpretation.date,
        requirements,
        arrangements,
        tasks,
        questions,
      );
    }
    if (item.kind === 'submission') {
      submissions.push({ item, rootId, live, conditional, titleKey: 'task.submit' });
    }
    // 宿題のうち、家の人がすること（音読カードのサイン、丸つけ）は、家族の作業にする（出す日の書かれた物は、
    // 提出物と同じ置き方）。子どもだけでする宿題は作業にしない（読んだだけ。勉強のしかたには口を出さない）。
    if (item.kind === 'homework' && item.interpretation.familyAction) {
      submissions.push({ item, rootId, live, conditional, titleKey: 'task.familyAction' });
    }
    // 家の人の当番（お茶当番、配車）。ほかの家の番と読めた物だけ作業にしない。うちの番か分からない物は、
    // 作業にして確かめてもらう（dutyTurn）。
    if (item.kind === 'duty' && item.interpretation.familyAction) {
      const turn = entry.turn ?? 'unsure';
      if (turn !== 'others') {
        duties.push({ item, rootId, live, conditional, unsure: turn === 'unsure' });
      }
    }
    // 習い事・クラブの行事（送り手が club）は、家の決まり（子の clubEscort）か、今回の家族の言明がある時だけ、
    // 送り・迎えの作業にする（書かれていない送り迎えを推し量りで作らない。escortFrameOf）。
    if (entry.escort) {
      escorts.push({ item, rootId, live, conditional, frame: entry.escort });
    }
    if (item.kind === 'need') needs.push(entry);
  }
  // 通用の「すること」は、子の居場所と買い物の作業を置いた後に（同じ人の時間を重ねない）。
  const needBusy = new Map<string, Busy[]>();
  addBusy(needBusy, tasks);
  for (const entry of needs) planNeed(ctx, entry, needBusy, { requirements, arrangements, tasks });
  const requests = externalRequests(ctx, tasks, arrangements, items);
  // 提出物の作業は、ほかの作業と依頼がそろった後に置く（持った人の、選んだ案のほかの作業と重ならない
  // ように）。提出物は外の相手が無いので、依頼には影響しない。
  for (const s of submissions) {
    submission(
      ctx,
      s.item,
      s.rootId,
      s.live,
      s.conditional,
      requirements,
      tasks,
      { arrangements, requests },
      s.titleKey,
    );
  }
  // 当番は、ほかの作業と提出物を置いた後に（決まった時刻に、持った人のほかの作業と重ならない時だけ置く）。
  for (const d of duties) {
    duty(ctx, d, requirements, tasks, { arrangements, requests });
  }
  for (const e of escorts) {
    escort(ctx, e, requirements, tasks, { arrangements, requests });
  }
  tasks.push(...cancellationTasks(ctx, requests));
  // 家族が決める値の問いは、要件が全部そろった後に（どの要件が答えで変わるかを見る）。
  questions.push(...familyQuestions(ctx, items, requirements));
  const released = releasedTasks(ctx, tasks, { arrangements, requests });

  return {
    householdId: household.id,
    now: ctx.fmt(nowMin),
    throughSeq: state.lastSeq,
    requirements,
    arrangements,
    tasks,
    requests,
    questions,
    ...(released.length > 0 ? { released } : {}),
    ...(maps ? { mapInputs: maps } : {}),
  };
}

/**
 * 計画に無くなった作業が、はっきり要らなくなったか：根拠のお知らせを家族が取り下げたか、根拠の事項がどれも、
 * 後のお知らせで取り消された・家族が関係ないとしたか。読み直しで見つからない事項（§4.1）と、今も残る事項は、
 * 要らなくなったとは言えない（確かめてもらう）。引き受けた後に根拠のお知らせを読み直していれば、同じ ID の
 * 事項が引き受けた時と同じ物とは言えないので、取り消し・関係ないも当てない（取り下げは出典ごとなので当てる）。
 */
function definitelyGone(
  state: EngineState,
  basis: { itemIds: readonly string[]; sourceIds: readonly string[]; seq: number },
): boolean {
  if (basis.sourceIds.some((id) => state.withdrawnSources.has(id))) return true;
  if (rereadSince(state, basis)) return false;
  // 根拠の事項が今も残るのに作業が無くなった（読み直しで同じ ID が別の種類になった、家の決まりや子の数が
  // 変わった等）時は、要らなくなったとは言えない（同じ ID は同じ事項の証拠ではない。§4.1）。
  return (
    basis.itemIds.length > 0 &&
    basis.itemIds.every(
      (id) => state.verdicts.get(id) === 'dismissed' || itemFate(state, id).status === 'cancelled',
    )
  );
}

/**
 * 引き受けたのに、もう要らなくなった作業（Released）。今の引き受けが「引き受けた」のまま、担当が有効な大人で、
 * 今の計画に無いか、生きていないか、もう進めない（家族が別の案を選んだ等。isActiveTask）物。用件と時刻は、本人が引き受けた時の控え（後で作業が変わっていても、約束した
 * 物で知らせ、終わったかを決める）。控えの無い古い引き受けは、用件も時刻も分からないとする。時刻のある物は、
 * 終わり（無ければ始まり）が過ぎたら出さない（もう動かない）。時刻の無い物は、本人が分かったと言うまで出す。
 * 外への取り消しの連絡（cancellationTasks）とは別（家族の中の約束）。
 */
function releasedTasks(
  ctx: Context,
  tasks: readonly Task[],
  plan: Pick<PlanResult, 'arrangements' | 'requests'>,
): Released[] {
  const released: Released[] = [];
  for (const [taskKey, commitment] of ctx.state.commitments) {
    if (commitment !== 'accepted') continue;
    const assigneeId = ctx.state.assignees.get(taskKey);
    const adult = ctx.household.members.find((m) => m.id === assigneeId);
    if (assigneeId === undefined || adult?.kind !== 'adult' || !adult.active) continue;
    const current = tasks.find((t) => t.key === taskKey);
    if (current?.live && isActiveTask(plan, current)) continue;
    // 根拠のお知らせを消していたら、要らなくなったとは言わず、中身も時刻も出さない（消した物を見せない）。
    // 根拠の分からない古い引き受けは、家庭のどれかのお知らせを消していれば、消した物かもしれないとする。
    const basis = ctx.state.acceptedBasis.get(taskKey);
    const purged =
      basis === undefined
        ? [...ctx.state.purgedSources.values()].includes('all')
        : basis.sourceIds.some((id) => ctx.state.purgedSources.get(id) === 'all');
    // 生きていない作業も、引き受けた後に根拠を読み直していれば、同じ事項の条件が外れたとは言えない。
    const reason: Released['reason'] = current
      ? current.live
        ? 'inactive'
        : basis !== undefined && rereadSince(ctx.state, basis)
          ? 'unconfirmed'
          : 'notLive'
      : !purged && basis !== undefined && definitelyGone(ctx.state, basis)
        ? 'gone'
        : 'unconfirmed';
    const shown = purged ? undefined : ctx.state.shown.get(taskKey);
    const last = shown?.end ?? shown?.start;
    if (last !== undefined && toEpochMinutes(last) <= ctx.now) continue;
    released.push({
      taskKey,
      assigneeId,
      ...(shown ? { content: { titleKey: shown.titleKey, titleParams: shown.titleParams } } : {}),
      ...(shown?.start === undefined ? {} : { start: shown.start }),
      ...(shown?.end === undefined ? {} : { end: shown.end }),
      reason,
    });
  }
  return released;
}

/**
 * 家族が決める値の問い（§6）：お知らせが家族に決めさせる値（参加するか等。kind が family）で、まだ答えが無く、
 * 値によって要件が要るかが変わる時だけ聞く。値ごとに代入して、その値を使う事項の条件を三値で求め、どの値でも
 * 同じ確かな結果（全部 true か全部 false）の事項には効かないとする（ほかの未定の値のために結果が分からない
 * 時は、効くかもしれないので聞く）。効くか分からない作用の先にある事項（doubted）は、条件が真でも「しだい」に
 * する。作用（ほかの事項の取り消し・未定の値の答え）を通じてだけ効く値は、まだ問いにしない（その作業は隠さず、
 * 条件しだいのまま見せる）。答えが要る最後の時（until）は、変わる要件のまだ過ぎていない最も早い期限。過ぎた
 * 要件しか無ければ聞かない。安全な既定の答えは無い（fallbackValue を付けない）。名前は今も確かな読み取り
 * （currentReadings）からだけ取る：取り下げ・消したお知らせの値と、文を直して読み直す前の読み取りの値は
 * 聞かない。前の答えが、問いや事項が替わって使えなくなった時は、その値を添えて聞き直す。
 */
function familyQuestions(
  ctx: Context,
  items: readonly LiveItem[],
  requirements: readonly Requirement[],
): Question[] {
  const { state } = ctx;
  const nodes = [...state.extractions.values()].flatMap((e) => e.conditions);
  const assignment = new Map([...state.resolved].map(([id, r]) => [id, r.value]));
  const retired = retiredUnknowns(state);
  const declared = new Map<string, Unknown>();
  for (const extraction of currentReadings(state)) {
    for (const unknown of extraction.unknowns) {
      if (unknown.kind === 'family' && !retired.has(unknown.id)) declared.set(unknown.id, unknown);
    }
  }
  const questions: Question[] = [];
  for (const unknown of declared.values()) {
    if (state.resolved.has(unknown.id)) continue;
    // 事項ごとの、値ごとの条件の結果（効くかもしれない事項だけ）。
    const truths = new Map<string, Truth[]>();
    for (const entry of items) {
      const nodeId = entry.item.conditionNodeId;
      if (!entry.live || nodeId === undefined || !mentionsUnknown(nodeId, unknown.id, nodes)) {
        continue;
      }
      const each = unknown.values.map((value): Truth => {
        const truth = evaluateCondition(
          nodeId,
          nodes,
          new Map([...assignment, [unknown.id, value]]),
        );
        return truth === true && entry.doubted ? 'unknown' : truth;
      });
      const settled = each[0] !== 'unknown' && each.every((t) => t === each[0]);
      if (!settled) truths.set(entry.item.id, each);
    }
    if (truths.size === 0) continue;
    const affected = requirements.filter(
      (r) =>
        r.live &&
        r.basis.itemIds.some((id) => truths.has(id)) &&
        (r.by === undefined || toEpochMinutes(r.by) > ctx.now),
    );
    if (affected.length === 0) continue;
    const deadlines = affected.flatMap((r) => (r.by === undefined ? [] : [toEpochMinutes(r.by)]));
    const until = deadlines.length > 0 ? Math.min(...deadlines) : undefined;
    // 値ごとに、その値なら要る（または要るかもしれない）要件と、そのうちほかの条件しだいの物。
    const keysWhere = (i: number, match: (truth: Truth | undefined) => boolean) =>
      affected
        .filter((r) => r.basis.itemIds.some((id) => match(truths.get(id)?.[i])))
        .map((r) => r.key);
    const choices = unknown.values.map((value, i) => {
      const needed = keysWhere(i, (t) => t === true);
      return {
        value,
        requirementKeys: keysWhere(i, (t) => t === true || t === 'unknown'),
        conditionalKeys: keysWhere(i, (t) => t === 'unknown').filter((k) => !needed.includes(k)),
      };
    });
    // 答えが入っているのに使えない（問いや事項が答えた後に替わった。§5.3）なら、その値を添えて聞き直す。
    const previous = state.answers.findLast((a) => a.unknownId === unknown.id && a.by === 'family');
    questions.push({
      key: keys.question(unknown.id),
      unknownId: unknown.id,
      ...(until === undefined ? {} : { until: ctx.fmt(until) }),
      affects: affected.map((r) => r.key).sort(),
      family: {
        label: unknown.label,
        choices,
        ...(previous ? { previous: previous.value } : {}),
      },
    });
  }
  return questions;
}

/** 引き受けた後に、根拠のお知らせを読み直したか（同じ ID が同じ事項か、確かめられない。§4.1）。 */
const rereadSince = (state: EngineState, basis: { sourceIds: readonly string[]; seq: number }) =>
  basis.sourceIds.some((id) => (state.extractionSeq.get(id) ?? 0) > basis.seq);

const noSchool = (item: Item) =>
  item.kind === 'dayChange' && item.interpretation.dayType === 'noSchool';

interface CarePlaced {
  requirements: Requirement[];
  arrangements: Arrangement[];
  tasks: Task[];
}

/** 子の居場所の手配の一つ（お知らせの事項と子ごと）。 */
interface CareSlot {
  entry: LiveItem;
  childId: string;
  date: LocalDate;
  requirementKey: string;
  arrangementKey: string;
  /** 大人が家にいない一番長い間。無ければ手配は要らない。 */
  gap?: { start: EpochMinutes; end: EpochMinutes };
}

/** 家族が進める案（本命・予備）の手順の鎖。並べ方を試す単位。 */
interface CareChain {
  slot: CareSlot;
  template: CareOptionTemplate;
}

interface PlacedChain {
  option: OptionPlan;
  tasks: Task[];
  conflicted: boolean;
}

/**
 * 子の居場所の手配を、家族が進める案どうしの作業が同じ人の同じ時間に重ならないように置く（joint.ts）。
 * 進める案の鎖（本命・予備。手配をまたぐ）を一つずつ置き、前に置いた鎖の作業の時間を、後の鎖で使わない。
 * 鎖の並べ方を試し、物差し（chainScore）が一番良い置き方を選ぶ（同じ手配の本命が、予備にしか置けない
 * 時間を先に取ることもあるので、手配の中の順も試す）。数が多ければ、お知らせの順・本命が先で一度だけ置く。
 * 置くのは残りの手順だけ（済ませた手順は時間を取らない。careOption）。本命が決まってもう進めない予備（idle）は
 * 鎖に入れない。まだ選んでいない案と idle の予備は、鎖の作業を避けて置く（選べば、置き直す）。
 */
function placeCare(
  ctx: Context,
  entries: readonly LiveItem[],
  idle: ReadonlySet<string> = new Set(),
): Map<LiveItem, CarePlaced> {
  const children = ctx.household.members.filter((m) => m.kind === 'child' && m.active);
  const slots: CareSlot[] = entries.flatMap((entry) => {
    const date = entry.item.interpretation.date;
    if (!date) return [];
    const gap = noAdultAtHome(ctx.household, date).sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    )[0];
    return children.map((child) => ({
      entry,
      childId: child.id,
      date,
      requirementKey: keys.childCareRequirement(entry.rootId, child.id),
      arrangementKey: keys.childCareArrangement(entry.rootId, child.id),
      ...(gap ? { gap } : {}),
    }));
  });
  const templates = ctx.household.careOptions;
  const chains: CareChain[] = slots.flatMap((slot) => {
    if (!slot.gap) return [];
    const primary = ctx.state.primary.get(slot.arrangementKey);
    const backups = ctx.state.backups.get(slot.arrangementKey) ?? new Set<string>();
    const keyOf = (t: CareOptionTemplate) => keys.option(slot.arrangementKey, t.id);
    return [
      ...templates.filter((t) => keyOf(t) === primary),
      ...templates.filter(
        (t) => keyOf(t) !== primary && backups.has(keyOf(t)) && !idle.has(keyOf(t)),
      ),
    ].map((template) => ({ slot, template }));
  });
  const placed = bestOrder(
    chains,
    (order) => {
      const busy = new Map<string, Busy[]>();
      const result = new Map<string, PlacedChain>();
      for (const { slot, template } of order) {
        const own: Task[] = [];
        const { option, conflicted } = careOption(
          ctx,
          template,
          slot.arrangementKey,
          slot.requirementKey,
          slot.entry.item,
          slot.date,
          slot.entry.live,
          own,
          busy,
        );
        addBusy(busy, own);
        result.set(option.key, { option, tasks: own, conflicted });
      }
      return result;
    },
    (result) => chainScore([...result.values()]),
    // 重なりも、引き受けた時刻からの動きも無ければ、本命が先の決まった順のままにする。
    (result) =>
      [...result.values()].every((c) => !c.conflicted && c.tasks.every((t) => !t.reconfirm)),
  ).result;

  const byItem = new Map<LiveItem, CarePlaced>();
  for (const slot of slots) {
    const { entry } = slot;
    const out = byItem.get(entry) ?? { requirements: [], arrangements: [], tasks: [] };
    byItem.set(entry, out);
    out.requirements.push({
      key: slot.requirementKey,
      kind: 'childCare',
      what: entry.item.interpretation.what ?? entry.item.written,
      date: slot.date,
      nature: 'required',
      basis: { itemIds: [entry.item.id], requirementKey: slot.requirementKey },
      live: entry.live,
      ...(entry.conditional ? { conditional: entry.conditional } : {}),
    });
    if (!slot.gap) continue;
    // まだ選んでいない案は、進める案と済ませた手順の作業を避ける（同じ手配の物も。本命と並べて予備にする
    // 時に重ならず、本命から替える時は少し早めの目安になる）。
    const others = new Map<string, Busy[]>();
    for (const chain of placed.values()) addBusy(others, chain.tasks);
    const built = templates.map((template) => {
      const committed = placed.get(keys.option(slot.arrangementKey, template.id));
      if (committed) return committed;
      const own: Task[] = [];
      const { option } = careOption(
        ctx,
        template,
        slot.arrangementKey,
        slot.requirementKey,
        entry.item,
        slot.date,
        entry.live,
        own,
        others,
      );
      return { option, tasks: own };
    });
    const tasks = built.flatMap((b) => b.tasks);
    out.tasks.push(...tasks);
    out.arrangements.push(
      withStatus(
        ctx,
        {
          key: slot.arrangementKey,
          requirementKey: slot.requirementKey,
          kind: 'childCare',
          childId: slot.childId,
          start: ctx.fmt(slot.gap.start),
          end: ctx.fmt(slot.gap.end),
          status: 'decidable',
          options: built.map((b) => b.option),
          backupOptionKeys: backupsOffered(
            ctx,
            slot.arrangementKey,
            built.map((b) => b.option),
          ),
          reasons: conflictReasons(placed, slot.arrangementKey),
          live: entry.live,
          ...(entry.conditional ? { conditional: entry.conditional } : {}),
          ...chosen(
            ctx,
            slot.arrangementKey,
            built.map((b) => b.option),
          ),
        },
        tasks,
      ),
    );
  }
  return byItem;
}

/** 案の手順の鎖（子の居場所の取れる手と、通用のやり方の両方。careOption が置く）。 */
type ChainTemplate = Pick<
  CareOptionTemplate,
  'id' | 'titleKey' | 'deadline' | 'steps' | 'extraSteps' | 'cost'
>;

/**
 * 通用の「すること」の時（書かれた・家族が言った日と時刻だけから。作らない）。window は同じ日の始まり–終わり、
 * by は締切（日だけの締切は、その日の終わりまで。内部の目安の時刻で、過ぎた・選べないと言わない）。足りな
 * ければ無し（要件だけで、手配を作らない）。
 */
type NeedFrame =
  | { shape: 'window'; date: LocalDate; start: EpochMinutes; end: EpochMinutes }
  | { shape: 'by'; date: LocalDate; by: EpochMinutes };

function needFrame(ctx: Context, item: Item): NeedFrame | undefined {
  const i = item.interpretation;
  if (i.shape === 'window') {
    if (!i.date || !i.startTime || !i.endTime || i.startTime >= i.endTime) return undefined;
    return {
      shape: 'window',
      date: i.date,
      start: zonedToEpochMinutes(i.date, i.startTime, ctx.tz),
      end: zonedToEpochMinutes(i.date, i.endTime, ctx.tz),
    };
  }
  if (i.shape === 'by' && i.deadline) {
    const written = toEpochMinutes(i.deadline);
    const date = localDateOf(written, ctx.tz);
    const by = i.deadlineDayOnly ? zonedToEpochMinutes(date, '23:59', ctx.tz) : written;
    return { shape: 'by', date, by };
  }
  return undefined;
}

/**
 * 家族が「すること」に選んだやり方。選んだ時と今で、「すること」の中身とやり方の版が同じ時だけ当てる（違えば
 * stale：もう一度選んでもらう）。
 */
function chosenWays(ctx: Context, item: Item): { ways: Way[]; stale: boolean } {
  const chosen = ctx.state.needWays.get(item.id);
  if (!chosen || chosen.wayIds.length === 0) return { ways: [], stale: false };
  if (needWaysBasis(ctx.state, item.id, chosen.wayIds) !== chosen.about) {
    return { ways: [], stale: true };
  }
  const ways = chosen.wayIds.flatMap((id) => ctx.household.ways.filter((w) => w.id === id));
  return { ways, stale: false };
}

/**
 * 家族が、今の「すること」の中身とやり方の版に対して選んだやり方（空なら、どれも使わないと選んだ）。選んでいない・
 * 選んだ後に中身かやり方が替わった（選び直す）時は undefined。
 */
function waysSelectedNow(ctx: Context, arrangementKey: string): ReadonlySet<string> | undefined {
  for (const live of ctx.items.values()) {
    if (live.item.kind !== 'need' || keys.needArrangement(live.rootId) !== arrangementKey) continue;
    const chosen = ctx.state.needWays.get(live.item.id);
    if (!chosen) return undefined;
    return needWaysBasis(ctx.state, live.item.id, chosen.wayIds) === chosen.about
      ? new Set(chosen.wayIds)
      : undefined;
  }
  return undefined;
}

/**
 * やり方の案。準備の手順（受け持ち以外）は、子の居場所の取れる手と同じ置き方（careOption：手順の逆算、手順ごとの
 * 締切、ほかの作業を避ける、担当、済み、返事待ち）で、鎖の最後は窓の始まり（window）か締切（by）。やり方に締切が
 * あり、それより早ければ、やり方の締切。受け持ちの手順は、窓の時刻に置く（その人のほかの作業と重なる時は時刻を
 * 置かない）。準備の手順が無いやり方の決め時は、窓の始まりか締切。
 */
function wayOption(
  ctx: Context,
  way: Way,
  frame: NeedFrame,
  arrangementKey: string,
  requirementKey: string,
  item: Item,
  live: boolean,
  tasks: Task[],
  busy: ReadonlyMap<string, readonly Busy[]>,
): OptionPlan {
  const optionKey = keys.option(arrangementKey, way.id);
  const limit = frame.shape === 'window' ? frame.start : frame.by;
  const needRule: DeadlineRule = { type: 'onTheDay', at: ctx.fmt(limit).slice(11, 16) };
  const rule =
    way.deadline !== undefined && ruleDeadline(way.deadline, frame.date, ctx.household) < limit
      ? way.deadline
      : needRule;
  const names = new Map(way.steps.map((s) => [s.id, s.name]));
  // 作業の引き受けと済みを、今の「すること」の中身とこのやり方の版に結ぶ（替われば前の物を当てない）。
  const about = needWaysBasis(ctx.state, item.id, [way.id]);
  // 前もってする手順：受け持ちでない手順と、外の相手に頼む手順（相手が受け持つ物も、頼むのは前もって）。
  const prep: StepTemplate[] = way.steps
    .filter((s) => !familyCover(s))
    .map(({ name: _name, cover: _cover, ...s }) => ({ ...s, titleKey: 'task.wayStep' }));
  const option: OptionPlan =
    prep.length > 0
      ? careOption(
          ctx,
          {
            id: way.id,
            titleKey: 'option.way',
            deadline: rule,
            steps: prep,
            extraSteps: [],
            cost: way.cost,
          },
          arrangementKey,
          requirementKey,
          item,
          frame.date,
          live,
          tasks,
          busy,
          (step) => ({ what: names.get(step.id) ?? '' }),
          about,
        ).option
      : {
          key: optionKey,
          arrangementKey,
          templateId: way.id,
          titleKey: 'option.way',
          decisionDeadline: ctx.fmt(limit),
          deadlineCertainty: 'estimate',
          expired: limit < ctx.now,
          cost: way.cost,
          taskKeys: [],
        };
  if (frame.shape !== 'window') return option;
  // このやり方の作業（前の手順と、先に置いた受け持ち）も、同じ人の時間として避ける（受け持ちどうしを重ねない）。
  const mine = new Map<string, Busy[]>([...busy].map(([who, used]) => [who, [...used]]));
  addBusy(
    mine,
    tasks.filter((t) => t.basis.optionKey === optionKey),
  );
  for (const step of way.steps.filter(familyCover)) {
    const key = keys.task(optionKey, step.id);
    const who = step.assigneeId ?? ctx.state.assignees.get(key);
    // 受け持ちは、その人のふだんの予定が窓の間ずっと手順の区間（家など）にあり、ほかの作業とも重ならない時だけ、
    // 窓の時刻に置く（書かれた時間の当番と同じ。ずらさない）。仕事の時間に受け持ちを置かない（休みを取って見る
    // のは、休みの承認を頼む手順で表す）。窓が始まった後も、窓の始まりから確かめる。
    const candidate =
      who === undefined
        ? undefined
        : placeStep(
            {
              id: step.id,
              titleKey: 'task.wayStep',
              durationMin: frame.end - frame.start,
              segments: step.segments,
              waitAfterMin: 0,
              // 決まった場所の受け持ちは、その場所にいる区間だけ（場所を問わず家の区間に置かない）。
              ...(step.placeId === undefined ? {} : { placeId: step.placeId }),
            },
            who,
            ctx.household,
            Math.min(ctx.now, frame.start),
            frame.end,
            mine.get(who) ?? [],
          );
    const free = candidate !== undefined && candidate.start === frame.start;
    if (free && who !== undefined) {
      mine.set(who, [...(mine.get(who) ?? []), { start: frame.start, end: frame.end }]);
    }
    tasks.push(
      task(ctx, key, {
        step: { templateId: way.id, stepId: step.id },
        titleKey: 'task.wayStep',
        titleParams: { what: step.name, date: frame.date },
        basis: { itemIds: [item.id], requirementKey, arrangementKey, optionKey },
        durationMin: frame.end - frame.start,
        earliestStart: ctx.fmt(frame.start),
        deadline: ctx.fmt(frame.end),
        after: [],
        segments: step.segments,
        ...(step.placeId === undefined ? {} : { placeId: step.placeId }),
        cover: true,
        ...(about === undefined ? {} : { about }),
        ...(who === undefined ? {} : { assigneeId: who }),
        ...(free ? { start: ctx.fmt(frame.start), end: ctx.fmt(frame.end) } : {}),
        live,
      }),
    );
    option.taskKeys.push(key);
  }
  return option;
}

/**
 * 通用の「すること」の要件と手配（02-foundation §3.4）。日時が足りなければ要件だけ。やり方が選ばれていなければ、
 * 手配は「やり方を選ぶ」（inputMissing）で、作業を作らない（推し量りで作らない）。選んだやり方から案を作り、本命・
 * 予備・返事・決め時の扱いは子の居場所と同じ（withStatus）。窓の「すること」は、覆ったと言えない時間を出す。
 */
function planNeed(
  ctx: Context,
  entry: LiveItem,
  busy: Map<string, Busy[]>,
  out: { requirements: Requirement[]; arrangements: Arrangement[]; tasks: Task[] },
): void {
  const { item, rootId, live, conditional } = entry;
  const requirementKey = keys.needRequirement(rootId);
  const arrangementKey = keys.needArrangement(rootId);
  // お知らせから読んだ「すること」は、家族が確かめる（合っている・直す）まで計画に入れない：家の人がする事か・
  // いつかを、読み取りだけで決めない（締切の言い方の外で意味が替わる文を、コードは見分けられない）。要件は確かめを
  // 待つ印で残し（札で元の文と読み取りを見せる）、日時は写さず、手配を作らない。家族の言明は、言った時に確かめた。
  // 読み取りの日時が過ぎていても、確かめるまで残す（その日時こそ確かめる物で、読み違えた過去の日で、まだ要る
  // 物を隠さない）。もう要らなければ、家族が札で外す。
  if (!ctx.state.statedSources.has(item.sourceId) && item.evidence !== 'confirmed') {
    const seq = ctx.state.extractionSeq.get(item.sourceId);
    const at = ctx.state.extractionAt.get(item.sourceId);
    const addedBy = ctx.state.sourceBy.get(item.sourceId);
    out.requirements.push({
      key: requirementKey,
      kind: 'need',
      what: item.interpretation.what ?? item.written,
      nature: 'required',
      basis: { itemIds: [item.id], requirementKey },
      live,
      ...(conditional ? { conditional } : {}),
      unconfirmed: true,
      ...(seq !== undefined && at !== undefined
        ? { reading: { sourceId: item.sourceId, seq, at, ...(addedBy ? { addedBy } : {}) } }
        : {}),
    });
    return;
  }
  const frame = needFrame(ctx, item);
  const date = frame?.date ?? item.interpretation.date;
  out.requirements.push({
    key: requirementKey,
    kind: 'need',
    what: item.interpretation.what ?? item.written,
    ...(date === undefined ? {} : { date }),
    ...(frame?.shape === 'by' ? { by: ctx.fmt(frame.by) } : {}),
    nature: 'required',
    basis: { itemIds: [item.id], requirementKey },
    live,
    ...(conditional ? { conditional } : {}),
  });
  if (!frame) return;
  const { ways, stale } = chosenWays(ctx, item);
  const own: Task[] = [];
  const stoppedIds = new Set(ctx.household.stoppedWayIds ?? []);
  const options = ways.map((way) => {
    const option = wayOption(
      ctx,
      way,
      frame,
      arrangementKey,
      requirementKey,
      item,
      live,
      own,
      busy,
    );
    // やり方の前提（事前の登録など）のうち、使う日・だれのために満たされていない物を印にする（勧めない）。
    const gaps = preparationGaps(ctx.household, way, frame.date, item.interpretation.forMemberId);
    // やり方が使う資源のうち、家族が「使わない」とした物（勧める候補にしない）。
    const unused = unusedResources(ctx.household, way);
    return {
      ...option,
      ...(stoppedIds.has(way.id) ? { stopped: true as const } : {}),
      ...(gaps.length > 0 ? { needsPreparation: gaps } : {}),
      ...(unused.length > 0 ? { unusedResources: unused } : {}),
    };
  });
  addBusy(busy, own);
  out.tasks.push(...own);
  const base: Arrangement = {
    key: arrangementKey,
    requirementKey,
    kind: 'need',
    needShape: frame.shape,
    // 締切の形の始まりは計算した時刻（締切を過ぎたら締切。始まりを終わりの後にしない）。
    start: ctx.fmt(frame.shape === 'window' ? frame.start : Math.min(ctx.now, frame.by)),
    end: ctx.fmt(frame.shape === 'window' ? frame.end : frame.by),
    status: ways.length === 0 ? 'undetermined' : 'decidable',
    options,
    backupOptionKeys: backupsOffered(ctx, arrangementKey, options),
    reasons:
      ways.length === 0 ? [{ code: 'inputMissing', refs: [stale ? 'waysChanged' : 'ways'] }] : [],
    live,
    ...(conditional ? { conditional } : {}),
    ...chosen(ctx, arrangementKey, options),
  };
  if (ways.length === 0) {
    out.arrangements.push(base);
    return;
  }
  const placed = withStatus(ctx, base, own);
  out.arrangements.push(
    frame.shape === 'window'
      ? withCoverage(ctx, placed, own, ways, item.interpretation.place)
      : placed,
  );
}

/** 家族が窓の間受け持つ手順（外の相手に頼む手順でない受け持ち）。 */
const familyCover = (step: Way['steps'][number]): boolean =>
  step.cover === true && step.external === undefined;

/**
 * 窓の「すること」を覆ったと言えるか（今使う案で）。やり方の約束が全部そろった時だけ覆う：家族の受け持ちの作業は
 * どれも、時刻に置いてあり、本人が引き受けた（済んだ）物（引き受け直しを待つ物は除く）。外の相手に頼む手順は
 * どれも（受け持つと書かれた相手も、承認などの前提も）、同じ窓・同じ中身（控えの about）に「はい」の返事のある
 * 依頼（取り消していない）。そのうえで、受け持つ人（家族の受け持ちか、受け持つと書かれた外の相手）が一人もいない
 * やり方は覆わない（承認は、だれかが受け持つことではない）。場所の書かれた「すること」は、家族の受け持ちでは
 * 覆わない（書かれた場所にその人がいると示せない）。覆うのは、やり方に covers があればその内だけ、無ければ
 * 窓の全部。残りの時間を notCovered にする（覆ったと言わない）。今使う案が無ければ足さない。
 */
function withCoverage(
  ctx: Context,
  arrangement: Arrangement,
  tasks: readonly Task[],
  ways: readonly Way[],
  /** 「すること」に書かれた場所（原文）。 */
  place: string | undefined,
): Arrangement {
  const inUse = arrangement.options.find((o) => o.key === arrangement.inUseOptionKey);
  if (!inUse || !arrangement.live) return arrangement;
  const way = ways.find((w) => w.id === inUse.templateId);
  const start = toEpochMinutes(arrangement.start);
  const end = toEpochMinutes(arrangement.end);
  const date = localDateOf(start, ctx.tz);
  // やり方が覆うのは、そのやり方の約束が全部そろった時だけ：外の相手に頼む手順はどれも、同じ窓・今の中身（控えの
  // about）に「はい」があり、受け持ちの作業はどれも、本人が今の中身で引き受けている（引き受け直しを待たない）。
  // 一つでも欠ければ、窓は覆っていない（有休の受け持ちを引き受けても、申請の承認が無ければ覆ったと言わない）。
  const yes = new Set<string>();
  for (const request of optionRequests(ctx.state, arrangement, inUse, ctx.tz)) {
    const snapshot = request.snapshot;
    if (request.state !== 'confirmed' || !snapshot?.window) continue;
    if (!sameTime(snapshot.window.start, arrangement.start)) continue;
    if (!sameTime(snapshot.window.end, arrangement.end)) continue;
    // 控えに中身の要約の無い依頼は、今の用件とやり方への返事と示せないので、数えない。
    if (snapshot.about === undefined || snapshot.about !== aboutNow(ctx.state, snapshot)) continue;
    yes.add(request.taskKey);
  }
  const agreed = (way?.steps ?? []).filter((s) => s.cover || s.external !== undefined);
  const held = (step: Way['steps'][number]) => {
    const key = keys.task(inUse.key, step.id);
    if (!familyCover(step)) return yes.has(key);
    // 場所の書かれた「すること」は、家族の受け持ちでは覆ったと言わない：書かれた場所（原文）と、受け持つ人が
    // いる場所（家庭の場所）が同じだと示せない（家族が二つを結ぶ仕組みはまだ無い。行き帰りも確かめていない）。
    if (place !== undefined) return false;
    const t = tasks.find((x) => x.key === key);
    return (
      t !== undefined &&
      t.start !== undefined &&
      (t.commitment === 'accepted' || t.commitment === 'done') &&
      !t.reconfirm
    );
  };
  // 受け持つ人（家族の受け持ちか、受け持つと書かれた外の相手）が一人もいないやり方は覆わない（承認だけでは、
  // だれもその時間を受け持っていない）。
  const covered =
    way?.steps.some((s) => s.cover) && agreed.every(held)
      ? [
          way.covers
            ? {
                start: zonedToEpochMinutes(date, way.covers.start, ctx.tz),
                end: zonedToEpochMinutes(date, way.covers.end, ctx.tz),
              }
            : { start, end },
        ]
      : [];
  const gaps = uncovered({ start, end }, covered);
  if (gaps.length === 0) return arrangement;
  return {
    ...arrangement,
    reasons: [
      ...arrangement.reasons,
      { code: 'notCovered', refs: gaps.map((g) => `${ctx.fmt(g.start)}/${ctx.fmt(g.end)}`) },
    ],
  };
}

/** 窓から、覆った時間を除いた残り。 */
function uncovered(
  window: { start: EpochMinutes; end: EpochMinutes },
  covered: readonly { start: EpochMinutes; end: EpochMinutes }[],
): { start: EpochMinutes; end: EpochMinutes }[] {
  let rest = [window];
  for (const c of covered) {
    rest = rest.flatMap((piece) =>
      c.end <= piece.start || c.start >= piece.end
        ? [piece]
        : [
            ...(c.start > piece.start ? [{ start: piece.start, end: c.start }] : []),
            ...(c.end < piece.end ? [{ start: c.end, end: piece.end }] : []),
          ],
    );
  }
  return rest;
}

/**
 * 本命が決まって、もう進めない予備（「きょう」に出ない。isActiveTask と同じ見方）。依頼と手配の状態は、
 * 一度置いた結果から作る（本命が決まったかは依頼の返事で決まり、置き方では変わらない）。
 */
function idleBackups(
  ctx: Context,
  care: ReadonlyMap<LiveItem, CarePlaced>,
  items: readonly LiveItem[],
): Set<string> {
  const placed = [...care.values()];
  const arrangements = placed.flatMap((p) => p.arrangements);
  const tasks = placed.flatMap((p) => p.tasks);
  const view = { arrangements, requests: externalRequests(ctx, tasks, arrangements, items) };
  const idle = new Set<string>();
  for (const arrangement of arrangements) {
    for (const optionKey of arrangement.backupOptionKeys) {
      const own = tasks.filter((t) => t.basis.optionKey === optionKey && !t.extra);
      if (own.length > 0 && own.every((t) => !isActiveTask(view, t))) idle.add(optionKey);
    }
  }
  return idle;
}

/** 手配の中で、ほかの進める案と重ならない時刻を見つけられなかった案（時刻を置いていない）。 */
function conflictReasons(
  placed: ReadonlyMap<string, PlacedChain>,
  arrangementKey: string,
): Reason[] {
  const refs = [...placed.values()]
    .filter((c) => c.conflicted && c.option.arrangementKey === arrangementKey)
    .map((c) => c.option.key);
  return refs.length > 0 ? [{ code: 'timeConflict', refs }] : [];
}

/**
 * 置き方の物差し（大きいほど良い。前から順に比べる）。一、引き受けた時の時刻から動いて、確かめ直しになる
 * 作業が少ない。二、ほかの案の作業を避けて置けなかった鎖が少ない。三、進める案の決め時が遅い（早い物から
 * 順に比べる。決め時が遅いほど、家族が選び直せる間が長い）。
 */
function chainScore(placed: readonly PlacedChain[]): number[] {
  const reconfirm = placed.flatMap((p) => p.tasks).filter((t) => t.reconfirm).length;
  const conflicts = placed.filter((p) => p.conflicted).length;
  const deadlines = placed
    .map((p) =>
      p.option.decisionDeadline === undefined
        ? Number.NEGATIVE_INFINITY
        : toEpochMinutes(p.option.decisionDeadline),
    )
    .sort((x, y) => x - y);
  return [-reconfirm, -conflicts, ...deadlines];
}

/** 作業が、その人の時間を使う区間（移動と寄り道の帰りを含む。busyOf と同じ）。 */
function taskBusy(t: Task): Busy | undefined {
  if (!t.start || !t.end) return undefined;
  return {
    start: toEpochMinutes(t.start) - t.travelBeforeMin,
    end: Math.max(
      toEpochMinutes(t.end) + t.travelAfterMin,
      t.detour ? toEpochMinutes(t.detour.delayedArrival) : 0,
    ),
  };
}

/**
 * 作業がその人の時間を使うか：生きていて、やめても済んでもいない物。済んだ手順は、もう時間を使わない（時刻を
 * 置かない。careOption）。
 */
const usesTime = (t: Task) => t.live && t.commitment !== 'done' && !NOT_DOING.has(t.commitment);

function addBusy(busy: Map<string, Busy[]>, tasks: readonly Task[]): void {
  for (const t of tasks) {
    if (!usesTime(t) || t.assigneeId === undefined) continue;
    const used = taskBusy(t);
    if (used) busy.set(t.assigneeId, [...(busy.get(t.assigneeId) ?? []), used]);
  }
}

/**
 * 家族が選んだ本命のうち、今の案にある物。案が無くなった選択（「すること」のやり方を選び直して外した、中身が
 * 替わって選び直す等）は、事象に残して出さない（同じ中身・やり方に戻れば、また当てる）。
 */
function chosen(
  ctx: Context,
  arrangementKey: string,
  options: readonly OptionPlan[],
): { chosenOptionKey?: string } {
  const key = ctx.state.primary.get(arrangementKey);
  return key === undefined || !options.some((o) => o.key === key) ? {} : { chosenOptionKey: key };
}

/** 家族が選んだ予備のうち、今の案にある物（chosen と同じ）。 */
function backupsOffered(
  ctx: Context,
  arrangementKey: string,
  options: readonly OptionPlan[],
): string[] {
  return [...(ctx.state.backups.get(arrangementKey) ?? [])].filter((key) =>
    options.some((o) => o.key === key),
  );
}

function careOption(
  ctx: Context,
  template: ChainTemplate,
  arrangementKey: string,
  requirementKey: string,
  item: Item,
  needDate: LocalDate,
  live: boolean,
  tasks: Task[],
  busy: ReadonlyMap<string, readonly Busy[]>,
  params: (step: StepTemplate) => Record<string, string> = () => ({}),
  about?: string,
): { option: OptionPlan; conflicted: boolean } {
  const optionKey = keys.option(arrangementKey, template.id);
  // 依頼を送って済みになった手順は、送った依頼の日で見る。前の日の分を送った済みは、今の日に当てず、
  // 引き受けた所に戻す（今の日の分を頼み直せるように）。控えに時間の無い古い事象は、時間からは決めない。
  // 取り消しを伝えた依頼は、送ったことにしない（案がまた要るなら、頼み直す）。
  const reopenOf = (key: string) => {
    const sentWith = ctx.state.commitmentLog.get(key)?.at(-1)?.requestId;
    const sent = sentWith === undefined ? undefined : ctx.state.requests.get(sentWith);
    const sentDay = sent === undefined ? undefined : requestDay(sent, ctx.tz);
    return (
      sent !== undefined &&
      (sent.state === 'cancelled' || (sentDay !== undefined && sentDay !== needDate))
    );
  };
  // 済ませた手順（今の用件を済ませた物）は、もう時間を使わない。置くのは残りの手順だけ（済ませた時刻は記録に
  // 無いので、計画の時刻を、済ませた時として残さない）。全部済んでいれば、何も置かない。
  const finished = template.steps.map((step) => {
    const key = keys.task(optionKey, step.id);
    const content = {
      titleKey: step.titleKey,
      titleParams: { ...params(step), date: needDate },
      ...(about === undefined ? {} : { about }),
    };
    return !reopenOf(key) && commitmentOf(ctx, key, content) === 'done';
  });
  const rest = template.steps.flatMap((_, i) => (finished[i] ? [] : [i]));
  // 済ませた手順の後に待つ時間があれば、残りの手順は、済んだと記録した時から待った後に置く（記録した時は、
  // 実際に済ませた時より前にはならないので、早すぎる時刻を置かない側）。
  const ready = template.steps.reduce<EpochMinutes | undefined>((from, step, i) => {
    if (!finished[i] || step.waitAfterMin <= 0 || !rest.some((j) => j > i)) return from;
    const doneAt = ctx.state.commitmentLog.get(keys.task(optionKey, step.id))?.at(-1)?.at;
    if (doneAt === undefined) return from;
    return Math.max(from ?? doneAt + step.waitAfterMin, doneAt + step.waitAfterMin);
  }, undefined);
  const remaining = {
    ...template,
    steps: rest.map((i) => template.steps[i] as StepTemplate),
  };
  // ほかの案の作業（busy）を避けて置く。避けて置けなければ、決め時はこの案だけを見た逆算の目安にし
  // （置けないとは言わない）、作業には時刻を置かない（ほかの作業と重ねて置かない。手配に timeConflict）。
  let conflicted = false;
  let result =
    rest.length > 0
      ? optionDeadline(remaining, needDate, ctx.household, ctx.now, undefined, busy, ready)
      : optionDeadline(template, needDate, ctx.household, ctx.now);
  if (rest.length > 0 && result.decisionDeadline === undefined && busy.size > 0) {
    const alone = optionDeadline(
      remaining,
      needDate,
      ctx.household,
      ctx.now,
      undefined,
      new Map(),
      ready,
    );
    if (alone.decisionDeadline !== undefined) {
      result = alone;
      conflicted = true;
    }
  }
  // 決め時は、大人の誰かが間に合うかで決める。作業の置き場所は、担当が決まっていれば、手順ごとに
  // その人のふだんの時間に、先後を守って置き直す（担当の無い手順は、最初の担当の人がする）。
  // 置けた人が担当と違う手順は、時刻の無い提案にする（別の人の時間を、担当の時間に見せない）。
  // 手順の担当が前後で別の人なら、受け渡しが分からないので、鎖のどの手順にも時刻を置かない。
  const assigned = template.steps.map((s) => ctx.state.assignees.get(keys.task(optionKey, s.id)));
  const lead = assigned.find((a) => a !== undefined);
  const doers = template.steps.map((s, i) => s.assigneeId ?? assigned[i] ?? lead);
  const handoff = doers.some(
    (who, i) => i > 0 && who !== undefined && doers[i - 1] !== undefined && who !== doers[i - 1],
  );
  const byAssignee = {
    ...template,
    steps: rest.map((i) => {
      const s = template.steps[i] as StepTemplate;
      const who = assigned[i];
      return who !== undefined && s.assigneeId === undefined ? { ...s, assigneeId: who } : s;
    }),
  };
  // 置いた手順（残りの手順の順）。済んだ手順には、何も置かない。作業の時刻は、これから（今より後。待つ時間が
  // あればその後）の空きにだけ置く：過ぎた時刻を、今からする作業として出さない（決め時は上の逆算のまま、過ぎて
  // いれば過ぎたと示す）。引き受けた時刻が過ぎても済んでいなければ、置き直して確かめ直してもらう（reconfirm）。
  // これからの空きが無ければ、時刻を置かない。
  const from = Math.max(ctx.now, ready ?? ctx.now);
  const chain = lead === undefined ? remaining : byAssignee;
  let placedRest: ReturnType<typeof optionDeadline>['steps'] = [];
  if (!conflicted && rest.length > 0) {
    const ahead = lead === undefined && (result.steps[0]?.start ?? from - 1) >= from;
    placedRest = ahead
      ? result.steps
      : optionDeadline(chain, needDate, ctx.household, ctx.now, lead, busy, from).steps;
    if (placedRest.length === 0 && busy.size > 0) {
      const alone = optionDeadline(
        chain,
        needDate,
        ctx.household,
        ctx.now,
        lead,
        new Map(),
        from,
      ).steps;
      if (alone.length > 0) conflicted = true;
    }
  }
  const placedSteps = template.steps.map((_, i) => {
    const at = rest.indexOf(i);
    return at === -1 ? undefined : placedRest[at];
  });
  const basis = { itemIds: [item.id], requirementKey, arrangementKey, optionKey };
  const taskKeys: string[] = [];
  template.steps.forEach((step, index) => {
    const candidate = placedSteps[index];
    const owner = assigned[index];
    const placed =
      candidate && (owner === undefined || candidate.memberId === owner) ? candidate : undefined;
    const key = keys.task(optionKey, step.id);
    taskKeys.push(key);
    const previous = template.steps[index - 1];
    const reopen = reopenOf(key);
    // 手順の締切は、案の締切と、手順ごとの締切（前の日 21:00 までの予約など）の早い方。
    const own =
      step.deadline === undefined
        ? undefined
        : ruleDeadline(step.deadline, needDate, ctx.household);
    const stepDeadline =
      own === undefined ? result.ruleDeadline : Math.min(own, result.ruleDeadline);
    tasks.push(
      task(
        ctx,
        key,
        {
          step: { templateId: template.id, stepId: step.id },
          titleKey: step.titleKey,
          // 用件に、その手配の日を入れる（日が直されたら別の用件。前の日の申込書を書いた済みや、前の日の
          // 引き受けを、新しい日に当てない）。やり方の手順は、題（家族の言葉）も用件に入れる。
          titleParams: { ...params(step), date: needDate },
          basis,
          durationMin: step.durationMin,
          deadline: ctx.fmt(stepDeadline),
          after: previous
            ? [{ taskKey: keys.task(optionKey, previous.id), waitMin: previous.waitAfterMin }]
            : [],
          segments: step.segments,
          ...(step.placeId === undefined ? {} : { placeId: step.placeId }),
          ...(step.external === undefined ? {} : { external: step.external }),
          ...(handoff ? { handoff: true } : {}),
          ...(about === undefined ? {} : { about }),
          ...(placed && !handoff
            ? {
                assigneeId: placed.memberId,
                start: ctx.fmt(placed.start),
                end: ctx.fmt(placed.end),
                ...(placed.slot.placeId === undefined ? {} : { atPlaceId: placed.slot.placeId }),
              }
            : {}),
          live,
        },
        { reopen },
      ),
    );
  });
  for (const extra of template.extraSteps) {
    const key = keys.task(optionKey, extra.id);
    taskKeys.push(key);
    const day = addDays(needDate, extra.dayOffset);
    tasks.push(
      task(ctx, key, {
        step: { templateId: template.id, stepId: extra.id },
        titleKey: extra.titleKey,
        titleParams: { date: needDate },
        basis,
        durationMin: extra.durationMin,
        earliestStart: ctx.fmt(zonedToEpochMinutes(day, '00:00', ctx.tz)),
        deadline: ctx.fmt(zonedToEpochMinutes(day, '23:59', ctx.tz)),
        after: [],
        segments: extra.segments,
        ...(extra.placeKind === undefined ? {} : { placeKind: extra.placeKind }),
        ...(extra.goods === undefined ? {} : { goods: extra.goods }),
        live,
        extra: true,
      }),
    );
  }
  const decisionDeadline = result.decisionDeadline;
  return {
    option: {
      key: optionKey,
      arrangementKey,
      templateId: template.id,
      titleKey: template.titleKey,
      ...(decisionDeadline === undefined ? {} : { decisionDeadline: ctx.fmt(decisionDeadline) }),
      deadlineCertainty: decisionDeadline === undefined ? 'undetermined' : 'estimate',
      expired: result.expired,
      ...(result.noSlot ? { noSlot: true as const } : {}),
      cost: template.cost,
      taskKeys,
    },
    conflicted,
  };
}

/**
 * 作業の引き受けの状態。済んだ記録が、今と違う用件を済ませた物なら（直されて別の物になった）、今の
 * 作業は済みとせず、引き受けた所に戻す（見た控えとも違うので、見せ直して確かめてもらう）。
 */
function commitmentOf(ctx: Context, key: string, content: TaskContent): CommitmentState {
  const state = ctx.state.commitments.get(key) ?? 'proposed';
  if (state !== 'done') return state;
  const done = ctx.state.doneContent.get(key);
  return done === undefined || sameContent(done, content) ? 'done' : 'accepted';
}

/**
 * 作業を作る。reopen：済んだ記録の後に、それを打ち消す事実が入った（買った物が無いと答え直した等）。済みと
 * せず、引き受けた所に戻す。
 */
function task(
  ctx: Context,
  key: string,
  fields: Omit<Task, 'key' | 'commitment' | 'travelBeforeMin' | 'travelAfterMin' | 'travelSource'> &
    Partial<Pick<Task, 'travelBeforeMin' | 'travelAfterMin' | 'travelSource'>>,
  options: { reopen?: boolean } = {},
): Task {
  const assignee = ctx.state.assignees.get(key);
  const condition = taskCondition(ctx, fields.basis.itemIds);
  const commitment = commitmentOf(ctx, key, fields);
  const built: Task = {
    key,
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    ...fields,
    ...(condition === undefined ? {} : { condition }),
    ...(assignee === undefined ? {} : { assigneeId: assignee }),
    commitment: options.reopen && commitment === 'done' ? 'accepted' : commitment,
  };
  if (built.commitment !== 'accepted') return built;
  // 引き受けた後に「もう要らなくなった」と本人に知らせていれば（はっきりした取り消し。§4.2）、作業が戻っても
  // 前の引き受けをそのまま当てず、見せ直す（本人は、要らなくなったと思って予定を変えたかもしれない）。
  const released = ctx.state.releasedNotified.get(key);
  const acceptedAt = (ctx.state.commitmentLog.get(key) ?? [])
    .filter((c) => c.state === 'accepted')
    .at(-1)?.seq;
  if (
    released !== undefined &&
    released.memberId === built.assigneeId &&
    acceptedAt !== undefined &&
    released.seq > acceptedAt
  ) {
    return { ...built, reconfirm: true };
  }
  // 引き受けた時に見た提案と、今の提案が同じでなければ、見せ直す（控えの無い古い形も同じ）。
  const shown = ctx.state.shown.get(key);
  const now = proposalSnapshot(built);
  return shown !== undefined && now !== undefined && sameProposal(shown, now)
    ? built
    : { ...built, reconfirm: true };
}

/** 依頼の控えの頼んだ日（区間の始まりの日、家庭の時区）。控えに時間が無ければ無し。 */
function requestDay(
  request: Pick<RequestRecord, 'snapshot'>,
  timeZone: string,
): LocalDate | undefined {
  const window = request.snapshot?.window;
  return window === undefined ? undefined : localDateOf(toEpochMinutes(window.start), timeZone);
}

/**
 * 依頼が、今の手配の日の分か（02-foundation §5.6）。子の居場所の手配は、控えの頼んだ日が今の日と同じ物だけ
 * （日が直されたら、前の日の返事で今の日を決めない）。時間で頼まない依頼は、いつも今の分。控えに時間の無い
 * 古い事象は、時間からは決めない（今の分として扱う。サーバーとデモが書く事象は、いつも時間を持つ）。
 */
function requestForDay(
  request: Pick<RequestRecord, 'snapshot'>,
  arrangement: Pick<Arrangement, 'kind' | 'start' | 'needShape'>,
  timeZone: string,
): boolean {
  if (!windowed(arrangement)) return true;
  const day = requestDay(request, timeZone);
  return day === undefined || day === localDateOf(toEpochMinutes(arrangement.start), timeZone);
}

/**
 * 案の依頼のうち、今の手配の日の分（requestForDay）。日が直されて前の日の分になった依頼で、今の日の手配を
 * 始めたことにはしない（送った後の疑いとして、頼んだ本人に確かめてもらう）。
 */
function optionRequests(
  state: EngineState,
  arrangement: Pick<Arrangement, 'kind' | 'start' | 'needShape'>,
  option: Pick<OptionPlan, 'taskKeys'>,
  timeZone: string,
): RequestRecord[] {
  return [...state.requests.values()].filter(
    (r) =>
      option.taskKeys.includes(r.taskKey) &&
      r.state !== 'cancelled' &&
      requestForDay(r, arrangement, timeZone),
  );
}

/**
 * 案を始めたか：今の日の分の依頼を送ったか、本人が「済んだ」とした手順が今の用件（その日）に当たる。
 * 依頼を送って済みになった手順は、依頼の日で見る（前の日の依頼の済みで、今の日を始めたことにしない）。
 * 決め時を過ぎた案でも、始めていれば使い続け、本命と予備の入れ替えに選び直せる（サーバーも同じ判断）。
 */
export function optionStarted(
  state: EngineState,
  arrangement: Pick<Arrangement, 'kind' | 'start' | 'needShape'>,
  option: Pick<OptionPlan, 'taskKeys'>,
  tasks: readonly Task[],
  timeZone: string,
): boolean {
  if (optionRequests(state, arrangement, option, timeZone).length > 0) return true;
  return tasks.some(
    (t) =>
      option.taskKeys.includes(t.key) &&
      t.commitment === 'done' &&
      state.commitmentLog.get(t.key)?.at(-1)?.requestId === undefined,
  );
}

/**
 * 選んだ案が使えなくなったか：依頼が断られた、または決め時を過ぎても始めていない。今の日の分の依頼があれば、
 * その返事で決める。無ければ、前の日の分の断りでも使えないとする（今の日を頼み直すまでは決まっていない。
 * 勝手に使える側へ倒さない）。始めたかは、今の日の分だけで見る（optionStarted）。
 */
function failure(
  ctx: Context,
  arrangement: Arrangement,
  option: OptionPlan,
  tasks: readonly Task[],
): Reason | undefined {
  // 取り消しを伝えた依頼は、返事として数えない（今の日の分として、前の日の断りを打ち消さない）。
  const requests = [...ctx.state.requests.values()].filter(
    (r) => option.taskKeys.includes(r.taskKey) && r.state !== 'cancelled',
  );
  const current = requests.filter((r) => requestForDay(r, arrangement, ctx.tz));
  const turned = (current.length > 0 ? current : requests).filter((r) => r.state === 'turnedDown');
  if (turned.length > 0) return { code: 'turnedDown', refs: turned.map((r) => r.requestId) };
  if (option.expired && !optionStarted(ctx.state, arrangement, option, tasks, ctx.tz))
    return { code: 'missedDeadline', refs: [option.key] };
  return undefined;
}

/**
 * 手配の状態（§7）。本命が使えなくなったら（断られた・決め時を過ぎた）、押さえた予備へ移る。
 * 予備も無ければ、残る案から選び直してもらう（勧める案を出す）。
 */
function withStatus(ctx: Context, arrangement: Arrangement, tasks: Task[]): Arrangement {
  if (!arrangement.live) return arrangement;
  const byKey = new Map(arrangement.options.map((o) => [o.key, o]));
  const chosenKeys = [arrangement.chosenOptionKey, ...arrangement.backupOptionKeys].filter(
    (k): k is string => k !== undefined && byKey.has(k),
  );
  // 置き方で分かった理由（重ならずに置けなかった案）は残す。
  const reasons: Reason[] = [...arrangement.reasons];
  const failed = new Set<string>();
  for (const key of chosenKeys) {
    const option = byKey.get(key);
    const reason = option && failure(ctx, arrangement, option, tasks);
    if (reason) {
      failed.add(key);
      reasons.push(reason);
    }
  }
  const inUse = chosenKeys.find((k) => !failed.has(k));
  if (inUse) {
    const option = byKey.get(inUse);
    // 返事を待つのは、今の日の分の依頼だけ（前の日の分の返事は、今の日を決めない）。
    const waiting = [...ctx.state.requests.values()].filter(
      (r) =>
        r.state === 'awaitingReply' &&
        option?.taskKeys.includes(r.taskKey) &&
        requestForDay(r, arrangement, ctx.tz),
    );
    if (waiting.length > 0) {
      reasons.push({ code: 'awaitingReply', refs: waiting.map((r) => r.requestId) });
      return { ...arrangement, status: 'dependsOnReply', reasons, inUseOptionKey: inUse };
    }
    return { ...arrangement, status: 'decidable', reasons, inUseOptionKey: inUse };
  }
  const open = arrangement.options.filter(
    (o) => !o.expired && o.decisionDeadline !== undefined && !failed.has(o.key),
  );
  if (open.length === 0) {
    // 決め時を出せないが過ぎてもいない案（ふだんの予定に置ける区間が無い手順がある、二週さかのぼっても置き方が
    // 見つからない）が残れば、取れないとは言わない（まだ判断できない）。勧めず、家族が選ぶ（選べば、時刻の無い作業に
    // なる）。決まりの締切が過ぎた案は、過ぎた（決め時が無くても、締切で確かめられる）。
    const unplaced = arrangement.options.filter(
      (o) => o.decisionDeadline === undefined && !o.expired && !failed.has(o.key),
    );
    if (unplaced.length > 0) {
      reasons.push({ code: 'noSlot', refs: unplaced.map((o) => o.key) });
      return { ...arrangement, status: 'undetermined', reasons };
    }
    reasons.push({ code: 'noOptionLeft', refs: arrangement.options.map((o) => o.key) });
    return { ...arrangement, status: 'infeasible', reasons };
  }
  // 家族が「使わない」とした資源を使う案は、勧める候補にしない（選べる。ほかの案は比べて勧める）。候補が残らな
  // ければ、勧めない。
  const candidates = open.filter((o) => (o.unusedResources?.length ?? 0) === 0);
  // 勧めるのは、代償と決め時で比べられる時だけ（比べられなければ、家族が選ぶ）：やめたやり方の案がある、営業時間の
  // 分からない場所でする手順のある案がある（間に合うと言えない）、前もっての前提（事前の登録など）が済んだと
  // 確かめられていない案がある、案が二つ以上で代償の分からない案がある時は、勧めない。
  if (
    candidates.length === 0 ||
    candidates.some(
      (o) =>
        stoppedWay(ctx.household, arrangement, o) ||
        hoursUnknownAt(ctx.household, arrangement, o) ||
        (o.needsPreparation?.length ?? 0) > 0,
    ) ||
    (candidates.length > 1 && candidates.some((o) => (o.cost.unknown?.length ?? 0) > 0))
  ) {
    return { ...arrangement, status: 'decidable', reasons };
  }
  const [recommended, next] = [...candidates].sort(
    (a, b) =>
      costScore(a.cost) - costScore(b.cost) ||
      (b.decisionDeadline ?? '').localeCompare(a.decisionDeadline ?? ''),
  );
  const recommendedReason = !next
    ? 'onlyOption'
    : recommended && costScore(recommended.cost) < costScore(next.cost)
      ? 'lowerCost'
      : 'moreTime';
  return {
    ...arrangement,
    status: 'decidable',
    reasons,
    ...(recommended ? { recommendedOptionKey: recommended.key, recommendedReason } : {}),
  };
}

/**
 * 持ち物の期限。書かれた締切か日付があれば、それ（日付なら朝 8:00）。無ければ、同じお知らせ
 * （置き換えをたどった元の出典）の、生きている行事の最も早い日の朝 8:00（間に合わなくならない側）。
 * 別のお知らせの行事には結ばない。
 */
function belongingsDeadline(
  ctx: Context,
  item: Item,
  rootSourceId: string,
  items: readonly LiveItem[],
): EpochMinutes | undefined {
  if (item.interpretation.deadline) return toEpochMinutes(item.interpretation.deadline);
  if (item.interpretation.date)
    return zonedToEpochMinutes(item.interpretation.date, '08:00', ctx.tz);
  // 使う日が書かれていなければ、同じお知らせの最も早い行事の日を、用意の締切の目安にする（間に合わなく
  // ならない側。使う日とは言わない）。
  const dates = items
    .filter(
      (e) =>
        e.live &&
        e.trusted &&
        e.rootSourceId === rootSourceId &&
        e.item.kind === 'event' &&
        e.item.interpretation.date,
    )
    .map((e) => e.item.interpretation.date as LocalDate)
    .sort();
  const first = dates[0];
  return first === undefined ? undefined : zonedToEpochMinutes(first, '08:00', ctx.tz);
}

/** 過ぎた買い物の機会を探す幅（ふだんの週と店の時間は、週ごとにくり返す）。 */
const LOOKBACK_MIN = 7 * 24 * 60;
const DAY_MIN = 24 * 60;

/** 提出物の作業の手順（家で用意して出す。かばんに入れるまで）。 */
const SUBMIT_STEP = {
  id: 'submit',
  titleKey: 'task.submit',
  durationMin: SUBMIT_MINUTES,
  segments: ['home' as const],
  waitAfterMin: 0,
};

/** 作業を止めた・断った・取り消した状態（時間を使わない）。 */
const NOT_DOING = new Set(['declined', 'withdrawn', 'cancelled']);

type Chosen = Pick<PlanResult, 'arrangements' | 'requests'>;

/**
 * その作業が時間を使うか（検証器と同じ見方）。済んだ物は、今は要らなくなっていても使う。止めた・
 * 断った・取り消した物と、要らなくなった物は使わない。案の無い作業と取り消しの作業は使う。案の作業は、
 * 選んだ案（本命・予備・使っている案）か、勧めている案の物だけが使う（比べるためだけの候補は使わない）。
 */
function occupies(t: Task, chosen: Chosen): boolean {
  if (t.commitment === 'done') return true;
  if (!t.live || NOT_DOING.has(t.commitment)) return false;
  if (t.cancels !== undefined || t.basis.optionKey === undefined) return true;
  const arrangement = chosen.arrangements.find((a) => a.key === t.basis.arrangementKey);
  // 手配が分からない時は、重ねない側（使う）にする。
  if (!arrangement) return true;
  return isActiveTask(chosen, t) || arrangement.recommendedOptionKey === t.basis.optionKey;
}

/** その人が、時刻のある作業に使う時間（検証器と同じく、移動と寄り道の帰りを含む）。 */
function busyOf(tasks: readonly Task[], memberId: string, chosen: Chosen): Busy[] {
  return tasks.flatMap((t) =>
    t.assigneeId === memberId && t.start && t.end && occupies(t, chosen)
      ? [
          {
            start: toEpochMinutes(t.start) - t.travelBeforeMin,
            end: Math.max(
              toEpochMinutes(t.end) + t.travelAfterMin,
              t.detour ? toEpochMinutes(t.detour.delayedArrival) : 0,
            ),
          },
        ]
      : [],
  );
}

/**
 * 提出物：出す日（締切）までに、家で用意して出す作業を一つ作る（書く・印を押す等の手順には分けない）。
 * 誰がするかの決まりが無いので、初めは担当を付けず、二人の「きょう」に出す（誰かが持つ）。持った人が
 * いれば、その人の家の時間の中で、締切までに終わる最も遅い所に置く（今より前と、その人のほかの作業の
 * 時間には置かない）。出す日の分からない物は、要件だけにする（作業は作らない。「後日配ります」のように、
 * まだ出せない物がある）。宿題のうち家の人がすること（サイン、丸つけ）も、同じ置き方で、題だけを替えて
 * 作る（titleKey）。こちらは今する事なので、出す日が書かれていなくても作業にする（締切を作らず、時刻なしで
 * 引き受ける。Task.timing の undated）。
 */
function submission(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  conditional: boolean,
  requirements: Requirement[],
  tasks: Task[],
  chosen: Chosen,
  titleKey = 'task.submit',
): void {
  const what = item.interpretation.what ?? item.written;
  // 日付だけの時は、その日の朝、学校へ持って行く前に（物の要る日と同じ扱い）。
  const by = item.interpretation.deadline
    ? toEpochMinutes(item.interpretation.deadline)
    : item.interpretation.date
      ? zonedToEpochMinutes(item.interpretation.date, '08:00', ctx.tz)
      : undefined;
  const requirementKey = keys.submissionRequirement(rootId);
  const basis = { itemIds: [item.id], requirementKey };
  requirements.push({
    key: requirementKey,
    kind: 'submission',
    what,
    ...(by === undefined ? {} : { by: ctx.fmt(by) }),
    nature: 'required',
    basis,
    live,
    ...(conditional ? { conditional } : {}),
  });
  const key = keys.submissionTask(rootId);
  if (by === undefined) {
    if (titleKey === 'task.familyAction') {
      tasks.push(
        task(ctx, key, {
          titleKey,
          titleParams: { what },
          basis,
          durationMin: SUBMIT_MINUTES,
          after: [],
          segments: ['home'],
          timing: 'undated',
          live,
        }),
      );
    }
    return;
  }
  const assignee = ctx.state.assignees.get(key);
  const commitment = commitmentOf(ctx, key, { titleKey, titleParams: { what } });
  const placed =
    assignee === undefined || !live || NOT_DOING.has(commitment) || commitment === 'done'
      ? undefined
      : placeStep(
          SUBMIT_STEP,
          assignee,
          ctx.household,
          ctx.now,
          by,
          busyOf(tasks, assignee, chosen),
        );
  tasks.push(
    task(ctx, key, {
      titleKey,
      titleParams: { what },
      basis,
      durationMin: SUBMIT_MINUTES,
      deadline: ctx.fmt(by),
      after: [],
      segments: ['home'],
      ...(placed
        ? {
            start: ctx.fmt(placed.start),
            end: ctx.fmt(placed.end),
            ...(placed.slot.placeId === undefined ? {} : { atPlaceId: placed.slot.placeId }),
          }
        : {}),
      live,
    }),
  );
}

/** 当番の終わりの時刻が書かれていない時の長さ（分。目安）。 */
const DUTY_DEFAULT_MINUTES = 60;
/** 終わりが始まりより前の時刻なら、次の日の終わりと読む。その時の長さの上限（分。当番と送り迎え）。 */
const OVERNIGHT_MAX_MINUTES = 12 * 60;

/**
 * 当番の書かれた時間。始まりが無ければ無し。終わりの日は endOf で決め（終わりが始まり以前の時刻か、「翌日」
 * などと書かれていれば、次の日と読める時（長さが 12 時間まで。23:00〜1:00）だけ次の日）、決められない終わりは
 * 読めない終わりとして目安の長さにする。
 */
function dutyWindow(
  ctx: Context,
  item: Item,
): { start: EpochMinutes; end: EpochMinutes; endEstimated: boolean } | undefined {
  const { date, startTime, endTime } = item.interpretation;
  if (date === undefined || startTime === undefined) return undefined;
  const start = zonedToEpochMinutes(date, startTime, ctx.tz);
  const end =
    endTime === undefined ? undefined : endOf(ctx.state, item, date, startTime, endTime, ctx.tz);
  return end
    ? { start, end: end.at, endEstimated: false }
    : { start, end: start + DUTY_DEFAULT_MINUTES, endEstimated: true };
}

/**
 * 家の人の当番（お茶当番、配車、読み聞かせ）：書かれた日に、家族の誰かがする作業を一つ作る。初めは担当を
 * 付けず、二人の「きょう」に出す（誰かが持つ）。
 * - 時刻が書かれていれば、その時間に決まっている（timing の fixed。終わりが無ければ目安の長さで
 *   fixedEndEstimated）。持った人のふだんの予定の空き（家・外出の区間）が、その時間をそのまま含み、ほかの
 *   作業とも重ならない時だけ置く。前や後にずらさない。場所と行き帰りは入れない（空いている区間の場所は、
 *   当番をする所ではない。atPlaceId を付けない）。
 * - 日だけなら、その日のどこか（day）。日も無ければ undated。どちらも時刻に置かず、時刻なしで引き受ける
 *   （仕組みが時刻を作らない）。読み取りの始まりを確かめられずに落とした物は、timeUnconfirmed を付ける。
 * - 用件には、書かれた日・時刻・場所を入れる（別の日の当番は別の用件。直されたら、前の済みや引き受けを
 *   当てない）。
 * - うちの番か分からない物（unsure）には、turnUnconfirmed を付ける（画面が対象を添えて確かめてもらう）。
 */
function duty(
  ctx: Context,
  entry: { item: Item; rootId: string; live: boolean; conditional: boolean; unsure: boolean },
  requirements: Requirement[],
  tasks: Task[],
  chosen: Chosen,
): void {
  const { item, rootId, live, conditional, unsure } = entry;
  const what = item.interpretation.what ?? item.written;
  const { date, startTime, endTime, place } = item.interpretation;
  const requirementKey = keys.dutyRequirement(rootId);
  const basis = { itemIds: [item.id], requirementKey };
  const window = dutyWindow(ctx, item);
  const dayStart = date === undefined ? undefined : zonedToEpochMinutes(date, '00:00', ctx.tz);
  requirements.push({
    key: requirementKey,
    kind: 'attendance',
    what,
    ...(date === undefined ? {} : { date }),
    // 要件の期限は、当番が始まる時（時刻の無い物は、その日の始まり）。
    ...(window
      ? { by: ctx.fmt(window.start) }
      : dayStart === undefined
        ? {}
        : { by: ctx.fmt(dayStart) }),
    nature: 'required',
    basis,
    live,
    ...(conditional ? { conditional } : {}),
  });
  const key = keys.dutyTask(rootId);
  const titleParams: Record<string, string> = {
    what,
    ...(date === undefined ? {} : { date }),
    ...(startTime === undefined ? {} : { start: startTime }),
    ...(endTime === undefined ? {} : { end: endTime }),
    ...(place === undefined ? {} : { place }),
  };
  const common = {
    titleKey: 'task.duty',
    titleParams,
    basis,
    after: [],
    live,
    ...(unsure ? { turnUnconfirmed: true as const } : {}),
  };
  if (!window) {
    // 時刻の無い当番：その日（または日も分からない）。時刻に置かない。
    const nextDay =
      date === undefined ? undefined : zonedToEpochMinutes(addDays(date, 1), '00:00', ctx.tz);
    tasks.push(
      task(ctx, key, {
        ...common,
        durationMin: 0,
        segments: ['home', 'away'],
        ...(dayStart === undefined || nextDay === undefined
          ? { timing: 'undated' as const }
          : {
              timing: 'day' as const,
              earliestStart: ctx.fmt(dayStart),
              deadline: ctx.fmt(nextDay),
              ...(item.interpretation.startTimeUnconfirmed
                ? { timeUnconfirmed: true as const }
                : {}),
            }),
      }),
    );
    return;
  }
  fixedTask(ctx, key, common, window, tasks, chosen);
}

/**
 * 書かれた時間に決まった作業を一つ作る（当番・送り迎え）。持った人のふだんの予定の空き（家・外出の区間）が、
 * その時間をそのまま含み、ほかの作業とも重ならない時だけ置く。前や後にずらさない。場所と行き帰りは入れない。
 */
function fixedTask(
  ctx: Context,
  key: string,
  common: {
    titleKey: string;
    titleParams: Record<string, string>;
    basis: Task['basis'];
    after: Task['after'];
    live: boolean;
    turnUnconfirmed?: true;
  },
  window: { start: EpochMinutes; end: EpochMinutes; endEstimated: boolean },
  tasks: Task[],
  chosen: Chosen,
): void {
  const assignee = ctx.state.assignees.get(key);
  const commitment = commitmentOf(ctx, key, {
    titleKey: common.titleKey,
    titleParams: common.titleParams,
  });
  const durationMin = window.end - window.start;
  const segments: Task['segments'] = ['home', 'away'];
  const candidate =
    assignee === undefined || !common.live || NOT_DOING.has(commitment) || commitment === 'done'
      ? undefined
      : placeStep(
          { id: 'fixed', titleKey: common.titleKey, durationMin, segments, waitAfterMin: 0 },
          assignee,
          ctx.household,
          ctx.now,
          window.end,
          busyOf(tasks, assignee, chosen),
        );
  // 書かれた時間にそのまま入る時だけ置く（もっと前の空きに置かない）。
  const placed = candidate && candidate.start === window.start ? candidate : undefined;
  tasks.push(
    task(ctx, key, {
      ...common,
      durationMin,
      earliestStart: ctx.fmt(window.start),
      deadline: ctx.fmt(window.end),
      segments,
      timing: window.endEstimated ? 'fixedEndEstimated' : 'fixed',
      ...(placed ? { start: ctx.fmt(placed.start), end: ctx.fmt(placed.end) } : {}),
    }),
  );
}

/** 送り迎えの片道の目安（分）。確かめた道のりではない（画面もそう書く）。 */
export const ESCORT_ESTIMATE_MINUTES = 30;

/**
 * 習い事・クラブの行事の送り迎え。根拠は家の決まり（子の clubEscort）か今回の家族の言明で（escortFrameOf）、
 * 行事に書かれた日・時刻・場所に結ぶ。
 * - 送り（to）は書かれた始まりの、迎え（from）は書かれた終わりの前後に、片道の目安（30 分）ずつの往復で
 *   決まった作業（大人は、その時刻に行事の場所にいる。行って帰る間は、ほかの作業をしない）。書かれた時刻を
 *   ずらさない。時刻の無い方は、その日の作業（時刻に置かない。確かめられない時刻は timeUnconfirmed）。
 * - 行事が短く、送りと迎えの往復が重なる時は、同じ大人が両方を持つと、後の方を置けない（待つ間を、まだ
 *   作業にしていない）。
 * - 要らない（家の決まりに無い、今回は要らないと言った）方は作らない。どちらも要らなければ要件も作らない。
 * - 行事の条件しだい（雨天中止など）。用件に日・書かれた時刻・場所を入れる（直されたら、前の引き受けや
 *   済みを当てない）。
 */
function escort(
  ctx: Context,
  entry: { item: Item; rootId: string; live: boolean; conditional: boolean; frame: EscortFrame },
  requirements: Requirement[],
  tasks: Task[],
  chosen: Chosen,
): void {
  const { item, rootId, live, conditional, frame } = entry;
  const { date, place } = item.interpretation;
  const legs = frame.legs.filter((l) => l.needed);
  if (date === undefined || legs.length === 0) return;
  const what = item.interpretation.what ?? item.written;
  const requirementKey = keys.escortRequirement(rootId);
  const basis = { itemIds: [item.id], requirementKey };
  // 送り迎えの往復の始まり（時刻の無い方は、その日の始まり。日を決められない方は、行事の日の始まり）。
  const startOf = (l: EscortLeg) =>
    l.at === undefined
      ? zonedToEpochMinutes(l.date, '00:00', ctx.tz)
      : zonedToEpochMinutes(l.date, l.at, ctx.tz) - ESCORT_ESTIMATE_MINUTES;
  requirements.push({
    key: requirementKey,
    kind: 'escort',
    what,
    date,
    // 要件の期限は、いちばん早い送り迎えの、目安の出発（時刻の無い方は、その日の始まり）。
    by: ctx.fmt(Math.min(...legs.map(startOf))),
    nature: 'required',
    basis,
    live,
    ...(conditional ? { conditional } : {}),
  });
  for (const l of legs) {
    const key = keys.escortTask(rootId, l.leg);
    const common = {
      titleKey: l.leg === 'to' ? 'task.escortTo' : 'task.escortFrom',
      titleParams: {
        what,
        // 日を決められない迎えには、その方の日を付けず、行事の日（eventDate）だけを添える。
        ...(l.dateUnconfirmed ? { eventDate: l.date } : { date: l.date }),
        ...(l.at === undefined ? {} : { at: l.at }),
        ...(place === undefined ? {} : { place }),
      },
      basis,
      after: [],
      live,
    };
    if (l.dateUnconfirmed) {
      // 日を決められない方：日も時刻も付けない（締切を作らない。知らせの時機も決められない）。
      tasks.push(
        task(ctx, key, {
          ...common,
          durationMin: 0,
          segments: ['home', 'away'],
          timing: 'undated',
          timeUnconfirmed: true,
        }),
      );
      continue;
    }
    if (l.at === undefined) {
      // 時刻の無い方：その日の作業（時刻に置かない）。
      tasks.push(
        task(ctx, key, {
          ...common,
          durationMin: 0,
          segments: ['home', 'away'],
          timing: 'day',
          earliestStart: ctx.fmt(zonedToEpochMinutes(l.date, '00:00', ctx.tz)),
          deadline: ctx.fmt(zonedToEpochMinutes(addDays(l.date, 1), '00:00', ctx.tz)),
          ...(l.timeUnconfirmed ? { timeUnconfirmed: true as const } : {}),
        }),
      );
      continue;
    }
    const written = zonedToEpochMinutes(l.date, l.at, ctx.tz);
    fixedTask(
      ctx,
      key,
      common,
      {
        start: written - ESCORT_ESTIMATE_MINUTES,
        end: written + ESCORT_ESTIMATE_MINUTES,
        endEstimated: false,
      },
      tasks,
      chosen,
    );
  }
}

function purchase(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  conditional: boolean,
  by: EpochMinutes | undefined,
  day: LocalDate | undefined,
  requirements: Requirement[],
  arrangements: Arrangement[],
  tasks: Task[],
  questions: Question[],
): void {
  const what = item.interpretation.what ?? item.written;
  const requirementKey = keys.belongingsRequirement(rootId);
  const basis = { itemIds: [item.id], requirementKey };
  const unknownId = keys.atHomeUnknown(rootId);
  // 答えた時に見せた品物が、今の品物と違えば（直されて別の物になった）、その答えは使わない（家に
  // あるかは、まだ分からないものとして扱う）。
  const answer = ctx.state.resolved.get(unknownId);
  const atHome =
    answer === undefined || (answer.about !== undefined && answer.about !== what)
      ? undefined
      : answer.value;
  const arrangementKey = keys.purchaseArrangement(rootId);
  const optionKey = keys.option(arrangementKey, 'buy');
  const buyKey = keys.task(optionKey, 'buy');
  // 買い終えたか（済んだ時の品物が今の品物と同じ時だけ）。用意の締切を過ぎて手配を作らなくなっても、
  // 使う日の前の日に持って行く物を出せるように、要件が持つ。買った後に家にあるかを答え直した（買った物が
  // 見つからない・やはり家にあった）なら、後の答えが今の事実（買い終えたとは見せない。無いと答え直したら、
  // 締切の前なら買い物をもう一度開く）。
  const buyDone =
    commitmentOf(ctx, buyKey, { titleKey: 'task.buy', titleParams: { what } }) === 'done';
  const doneSeq = ctx.state.commitmentLog.get(buyKey)?.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  const answeredAfter =
    buyDone && atHome !== undefined && answer !== undefined && answer.seq > doneSeq;
  const bought = buyDone && !answeredAfter;
  requirements.push({
    key: requirementKey,
    kind: 'belongings',
    what,
    ...(day === undefined ? {} : { date: day }),
    ...(by === undefined ? {} : { by: ctx.fmt(by) }),
    nature: 'required',
    basis,
    live,
    ...(conditional ? { conditional } : {}),
    atHomeUnknownId: unknownId,
    ...(atHome === 'yes' || atHome === 'no' ? { atHome } : {}),
    ...(bought ? { bought } : {}),
  });
  // 持って行く時（by）を過ぎたら、もう買う手配も問いも出さない（要件は記録に残す）。
  if (atHome === 'yes' || by === undefined || by <= ctx.now) return;

  const goods = purchaseGoods(ctx.household, what);
  const reasons: Reason[] = [];
  let status: PlanStatus = atHome === undefined ? 'askFirst' : 'decidable';
  const option: OptionPlan = {
    key: optionKey,
    arrangementKey,
    templateId: 'buy',
    titleKey: 'option.buy',
    deadlineCertainty: 'undetermined',
    expired: false,
    cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 1 },
    taskKeys: [],
  };
  // 家にあるかを先に聞く（答えるまで買い物を決めない）。要らなくなった持ち物（条件が外れた等）には聞かない
  // （問いの札も知らせも出さない。その間の答えを、条件が戻った時に使わない）。
  const askFirst = (askBy: EpochMinutes) => {
    status = 'askFirst';
    const questionKey = keys.question(unknownId);
    reasons.push({ code: 'askFirst', refs: [questionKey] });
    if (!live) return;
    questions.push({
      key: questionKey,
      unknownId,
      askBy: ctx.fmt(askBy),
      fallbackValue: 'no',
      affects: [arrangementKey],
    });
  };
  if (goods === undefined) {
    // 扱う店の種類が分からない品物も、家にあるかは聞く（持ち物を黙って落とさない）。聞くのは要る日の
    // 前の日まで（目安。用意する時を残す）。無いと答えたら、買う時を決められないと示し、用意は家族が
    // 考える（どこで買えるか分からない）。
    status = 'undetermined';
    reasons.push({ code: 'inputMissing', refs: ['storeKind'] });
    if (atHome === undefined) askFirst(askByOf(ctx, by - DAY_MIN, by));
  } else {
    const key = buyKey;
    // 誰かが引き受けた・頼まれた買い物は、その人の機会から選ぶ（別の人に勝手に移さない）。
    // 済んだ買い物は、置き直さない。
    const assignee = ctx.state.assignees.get(key);
    const done = bought;
    // 店は家族の好みで絞る（「使わない」の店を外し、「いつも使う」の店があればその店だけ）。置く店と決め時は同じ集まり。
    const shops = purchaseStores(ctx.household, goods);
    const search = searchPurchase(
      ctx.household,
      goods,
      PURCHASE_MINUTES,
      ctx.now,
      by,
      ctx.maps,
      shops.stores,
    );
    const all = search.opportunities;
    const chances = assignee === undefined ? all : all.filter((c) => c.memberId === assignee);
    const first = chances[0];
    const last = chances.at(-1);
    if (done) {
      // 買い終えたら、家にあるかは聞かない（手配は済んだ作業で決まっている）。
      status = 'decidable';
      option.deadlineCertainty = 'undetermined';
      option.taskKeys.push(key);
      tasks.push(
        task(ctx, key, {
          titleKey: 'task.buy',
          titleParams: { what },
          basis: { ...basis, arrangementKey, optionKey },
          durationMin: PURCHASE_MINUTES,
          deadline: ctx.fmt(by),
          after: [],
          segments: ['commute', 'away'],
          placeKind: 'store',
          goods,
          live,
        }),
      );
    } else if (shops.stores.length === 0 && shops.notUsed.length > 0) {
      // 品物を扱う店が、家族が「使わない」とした店だけ：無理とは言わず、決めない（ほかの店は家族が選ぶ）。
      status = 'undetermined';
      reasons.push({ code: 'storeNotUsed', refs: shops.notUsed.map((s) => s.id) });
      if (atHome === undefined) askFirst(by);
    } else if ((!first || !last) && search.droppedUnconfirmed) {
      // 区間はあるのに、確かめていない営業時間（地図のふだんの営業時間の目安・営業時間が分からない）で
      // 置けなかった。閉まっているとも、買える時が過ぎたとも言わない（まだ判断できない。家族が確かめる）。
      status = 'undetermined';
      reasons.push({ code: 'inputMissing', refs: ['storeHours'] });
      if (atHome === undefined) askFirst(by);
    } else if (!first || !last) {
      // 買える時は過ぎた。ふだんの週と店の時間は週ごとにくり返すので、一週間さかのぼって、過ぎた最後の
      // 機会の始まりを決め時として示す（お知らせが来る前に過ぎていても、その時刻）。一週間に一度も機会が
      // 無ければ、決め時は示せない（作らない）。家にあるかがまだ分からなければ、不可能と決めず、家に
      // あるかを聞き続ける（家にあれば買わなくてよい。答えの入口を消さない）。
      const missed = purchaseOpportunities(
        ctx.household,
        goods,
        PURCHASE_MINUTES,
        ctx.now - LOOKBACK_MIN,
        by,
        ctx.maps,
        shops.stores,
      )
        .filter((c) => c.start < ctx.now && (assignee === undefined || c.memberId === assignee))
        .at(-1);
      // いつもの店に絞った時、ほかの使える店に、これから寄れる時（または確かめていない営業時間）があるか。
      const elsewhere =
        shops.others.length > 0
          ? searchPurchase(
              ctx.household,
              goods,
              PURCHASE_MINUTES,
              ctx.now,
              by,
              ctx.maps,
              shops.others,
            )
          : undefined;
      const otherOpen =
        elsewhere !== undefined &&
        (elsewhere.droppedUnconfirmed ||
          elsewhere.opportunities.some((c) => assignee === undefined || c.memberId === assignee));
      if (shops.usual && (!missed || otherOpen)) {
        // いつもの店に、これから寄れる時が無い：ほかの店に黙って移さず、決めない（ほかの店で買うかは家族が選ぶ）。
        // ほかの店ならまだ寄れる（かもしれない）か、いつもの店にさかのぼっても寄れる時が無い（閉まっている・ふだんの
        // 週で寄れない）時は、過ぎたとも、無理とも言わない。どの店にも、もう寄れる時が無く、いつもの店の機会が
        // 過ぎただけなら、下のとおり（その店の過ぎた最後の機会を決め時として示す）。
        status = 'undetermined';
        reasons.push({ code: 'usualStoreUnavailable', refs: shops.stores.map((s) => s.id) });
        if (atHome === undefined) askFirst(by);
      } else {
        option.expired = true;
        if (missed) {
          option.decisionDeadline = ctx.fmt(missed.start);
          option.deadlineCertainty = 'estimate';
        }
        reasons.push({ code: 'noOptionLeft', refs: [optionKey] });
        if (atHome === undefined) {
          // 答えが役に立つのは、持って行く時まで（無ければ、ほかの手を考える時が要る）。
          askFirst(by);
        } else {
          // 家に無く、買える時も過ぎた。過ぎた決め時を示せる時だけ「このままでは無理」と言い、示せなければ
          // 判断できないとする（確かめられない時刻で、不可能と言わない）。
          status = missed ? 'infeasible' : 'undetermined';
        }
      }
    } else {
      option.decisionDeadline = ctx.fmt(last.start);
      option.deadlineCertainty = 'estimate';
      option.taskKeys.push(key);
      tasks.push(
        task(
          ctx,
          key,
          {
            titleKey: 'task.buy',
            titleParams: { what },
            basis: { ...basis, arrangementKey, optionKey },
            durationMin: PURCHASE_MINUTES,
            deadline: ctx.fmt(by),
            after: [],
            segments: ['commute', 'away'],
            placeKind: 'store',
            goods,
            assigneeId: first.memberId,
            start: ctx.fmt(first.start),
            end: ctx.fmt(first.end),
            atPlaceId: first.storeId,
            travelBeforeMin: first.travelBeforeMin,
            travelAfterMin: first.travelAfterMin,
            travelSource: first.travelSource,
            hoursBasis: first.hoursBasis,
            ...(first.detour
              ? {
                  detour: {
                    plannedArrival: ctx.fmt(first.detour.plannedArrival),
                    delayedArrival: ctx.fmt(first.detour.delayedArrival),
                  },
                }
              : {}),
            live,
          },
          { reopen: answeredAfter },
        ),
      );
      if (atHome === undefined) askFirst(askByOf(ctx, last.start - QUESTION_LEAD_MIN, last.start));
    }
  }
  arrangements.push({
    key: arrangementKey,
    requirementKey,
    kind: 'purchase',
    atHomeUnknownId: unknownId,
    start: ctx.fmt(ctx.now),
    end: ctx.fmt(by),
    status: live ? status : 'decidable',
    options: [option],
    backupOptionKeys: [],
    reasons: live ? reasons : [],
    live,
    ...(conditional ? { conditional } : {}),
    ...chosen(ctx, arrangementKey, [option]),
    // 案は一つ。取れるなら、それを勧める（選ぶのは家族）。
    ...(live &&
    !option.expired &&
    option.taskKeys.length > 0 &&
    !ctx.state.primary.has(arrangementKey)
      ? { recommendedOptionKey: optionKey }
      : {}),
  });
}

/**
 * その案の依頼が、まだ要るか。取り下げた案、選び替えて外れた案、本命が確定した後の予備は要らない
 * （頼んだ後なら、取り消しの連絡を作る。§4・§7）。何も選んでいなければ、家族が出した依頼は残す。
 */
/**
 * 送った依頼の案を、家族が決めごとで外したか（家族が選び直すまで、外したまま）。どれかなら外した：
 * - 外した（dropOption。後で同じ案を選び直せば外れない）。
 * - 通用の「すること」で、送った時の控えの事項（ID が同じ物だけ）に家族が送った後に選んだやり方の、いちばん新しい
 *   選びに、この案のやり方が無い。選んだ時の中身が今と違っても、事項が読み直しで見つからなくても、外した決めごとは
 *   残る（確かめていない読み取りや、日の直しで、前に外した依頼を生き返らせない）。後の選びでやり方を足し直せば外れない
 *   （手配の本命・予備も、足し直すと戻る。同じ決まり）。
 * - 今の事項の、今の中身に合う選び（置き換えの後の事項での選びも）に、この案のやり方が無い。
 * - 本命か予備を選んであって、この案がそのどれでもない。
 * まだ選んでいない・中身が替わって選び直す前・控えの事項が分からない時は、外したと決めない（根拠が替わった疑いと
 * して、頼んだ本人に確かめる）。決め時を過ぎた・置けない案でも、選んでいれば残す。
 */
function decidedAgainst(ctx: Context, basis: Basis, sentSeq: number): boolean {
  const { arrangementKey, optionKey } = basis;
  if (arrangementKey === undefined || optionKey === undefined) return false;
  if (ctx.state.dropped.get(arrangementKey)?.has(optionKey)) return true;
  if (isNeedArrangementKey(arrangementKey)) {
    const prefix = `opt:${arrangementKey}:`;
    const wayId = optionKey.startsWith(prefix) ? optionKey.slice(prefix.length) : undefined;
    const removedAfter = basis.itemIds.some((itemId) => {
      const chosen = ctx.state.needWays.get(itemId);
      return (
        chosen !== undefined &&
        chosen.seq > sentSeq &&
        !(wayId !== undefined && chosen.wayIds.includes(wayId))
      );
    });
    if (removedAfter) return true;
    const selected = waysSelectedNow(ctx, arrangementKey);
    if (selected !== undefined && !(wayId !== undefined && selected.has(wayId))) return true;
  }
  const primary = ctx.state.primary.get(arrangementKey);
  const backups = ctx.state.backups.get(arrangementKey) ?? new Set<string>();
  if (primary === undefined && backups.size === 0) return false;
  return optionKey !== primary && !backups.has(optionKey);
}

function optionStillNeeded(
  ctx: Context,
  tasks: readonly Task[],
  items: ReadonlyMap<string, LiveItem>,
  basis: Basis,
  sentSeq: number,
  arrangement: Pick<Arrangement, 'kind' | 'start' | 'end'>,
): boolean {
  const { arrangementKey, optionKey } = basis;
  if (arrangementKey === undefined || optionKey === undefined) return true;
  if (decidedAgainst(ctx, basis, sentSeq)) return false;
  const primary = ctx.state.primary.get(arrangementKey);
  const backups = ctx.state.backups.get(arrangementKey) ?? new Set<string>();
  if (primary === undefined && backups.size === 0) return true;
  if (optionKey === primary) return true;
  if (primary === undefined) return true;
  const primaryTasks = new Set(
    tasks.filter((t) => t.basis.optionKey === primary).map((t) => t.key),
  );
  // 本命が決まったかは、今の日の分の、取り消していない依頼で見る（日が直されたら、前の日の「はい」で予備を
  // たたまない）。「はい」の後に疑い（根拠や頼んだ時間が変わった）が生じたら、確かめるまで決まっていない。
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const primaryRequests = [...ctx.state.requests.values()].filter(
    (r) =>
      primaryTasks.has(r.taskKey) &&
      r.state !== 'cancelled' &&
      requestForDay(r, arrangement, ctx.tz),
  );
  const settled = (request: RequestRecord) => {
    if (request.state !== 'confirmed') return false;
    const snapshot = snapshotOf(request, byKey.get(request.taskKey));
    if (snapshot === undefined) return true;
    const { unclear, changed } = requestDoubt(ctx, items, snapshot, arrangement);
    return !unclear && !changed;
  };
  const primaryConfirmed = primaryRequests.length > 0 && primaryRequests.every(settled);
  return !primaryConfirmed;
}

/**
 * 根拠の事項（置き換えをたどった今の事項）の条件の形。事項ごとの conditionShape を並べ替えて重ねを除き、
 * 一つならその形、二つ以上なら ["all", …]。送った時の控えと今を、この同じ関数で作って比べる。
 * 今の事項でない物（取り消された・見つからない）は入れない（それらは別の決まりで確かめる）。
 * 今の事項が一つも無ければ NO_CONDITION（依頼では、その時は見つからない・取り消しの決まりが働く）。
 */
export function basisCondition(state: EngineState, itemIds: readonly string[]): string {
  const nodes = [...state.extractions.values()].flatMap((e) => e.conditions);
  const shapes = [
    ...new Set(
      itemIds.flatMap((id) => {
        const fate = itemFate(state, id);
        return fate.status === 'current' ? [conditionShape(fate.item.conditionNodeId, nodes)] : [];
      }),
    ),
  ].sort();
  if (shapes.length === 0) return NO_CONDITION;
  return shapes.length === 1 && shapes[0] !== undefined ? shapes[0] : `["all",${shapes.join(',')}]`;
}

/**
 * 作業の根拠の条件（引き受けの控えに写す）：式の形（basisCondition）、式が使う未定の値の名前、根拠が今
 * 確かでないか（doubted）。画面は、確かでない事項（直した文をまだ読み直していない・取り消されるかも
 * しれない）には「条件しだい」とだけ添え、確かな条件には名前と値を添える。名前は画面と同じく今も確かな
 * 読み取りからだけ取り、確かめられなければ null。どれかが替われば、本人が見た条件が替わったので見せ
 * 直す。未定の値に答えが出ただけなら、どれも替わらない。条件が無く確かな作業には付けない。
 */
function taskCondition(ctx: Context, itemIds: readonly string[]): string | undefined {
  const { state } = ctx;
  const shape = basisCondition(state, itemIds);
  const current = itemIds.flatMap((id) => {
    const fate = itemFate(state, id);
    return fate.status === 'current' ? [fate.item] : [];
  });
  const doubted = current.some((item) => ctx.items.get(item.id)?.doubted === true);
  if (shape === NO_CONDITION && !doubted) return undefined;
  const nodes = new Map(
    [...state.extractions.values()].flatMap((e) => e.conditions).map((n) => [n.id, n]),
  );
  const labels = new Map(
    currentReadings(state)
      .flatMap((e) => e.unknowns)
      .map((u) => [u.id, u.label]),
  );
  const used = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (node?.kind === 'eq') used.add(node.unknownId);
    else if (node?.kind === 'not') visit(node.childId);
    else if (node) for (const child of node.childIds) visit(child);
  };
  for (const item of current) if (item.conditionNodeId) visit(item.conditionNodeId);
  const names = [...used].sort().map((u) => [u, labels.get(u) ?? null]);
  return JSON.stringify([shape, names, ...(doubted ? ['doubted'] : [])]);
}

/**
 * 依頼を送る時の控え（02-foundation §5.6）。送る時の事象から、相手・種類・根拠・条件・頼んだ時間を写す。
 * 送ったと記録する所（サーバーの命令、デモ、試験）は、これで控えを作る。
 */
export function requestSnapshot(
  events: readonly DomainEvent[],
  now: DateTime,
  taskKey: string,
): RequestSnapshot {
  const state = foldEvents(events);
  const plan = planFromState(state, now);
  const task = plan.tasks.find((t) => t.key === taskKey);
  if (!task?.external) throw new Error(`外に頼む作業が無い：${taskKey}`);
  const arrangement = plan.arrangements.find((a) => a.key === task.basis.arrangementKey);
  const items = new Map(liveItems(state).map((i) => [i.item.id, i]));
  const conditional = task.basis.itemIds.some((id) => {
    const fate = itemFate(state, id);
    return fate.status === 'current' && items.get(fate.item.id)?.conditional === true;
  });
  return {
    to: task.external.to,
    kind: task.external.kind,
    basis: task.basis,
    conditional,
    condition: basisCondition(state, task.basis.itemIds),
    ...(arrangement && windowed(arrangement)
      ? { window: { start: arrangement.start, end: arrangement.end } }
      : {}),
    ...(arrangement?.kind === 'need' && task.step
      ? (() => {
          const about = needWaysBasis(state, task.basis.itemIds[0] ?? '', [task.step.templateId]);
          return about === undefined ? {} : { about };
        })()
      : {}),
    ...(arrangement?.kind === 'childCare' && arrangement.childId
      ? { childId: arrangement.childId }
      : {}),
  };
}

const sameTime = (a: DateTime, b: DateTime) => toEpochMinutes(a) === toEpochMinutes(b);

/**
 * 依頼の根拠が今どうか（02-foundation §5.6）。
 * - conditional：根拠が今、条件しだい（送った時から分かっていた不確かさ。確かめは求めない）。
 * - needsCheck：送った後に生じた疑い。取り消したとも続けてよいとも決めず、要るかを頼んだ本人に確かめる。
 *   次のどれかの時：根拠の事項のどれかが読み直しで見つからない・確かでない・取り消された（手配は残る）、
 *   効くか分からない作用（置き換え・取り消し）の先にある、送った時は確か（控えの conditional が false）
 *   だったのに今は条件しだい、送った時と条件の式が違う（控えの condition）、頼んだ時間が違う（控えの
 *   window）。控えに無い古い事象では、条件と時間からは決めない。条件に答えが出ただけなら疑いではない。
 * - 同じ作業で今の日の分を送り直した後の、前の日の分の依頼（superseded）は要らない（取り消しを伝える）。
 * - 手配が無く、根拠がはっきり外れた（取り消し、確かな事項で手当てが要らなくなった）なら、要らない。
 */
function requestStanding(
  ctx: Context,
  tasks: readonly Task[],
  arrangements: ReadonlyMap<string, Arrangement>,
  items: ReadonlyMap<string, LiveItem>,
  snapshot: RequestSnapshot,
  sentSeq: number,
  superseded: boolean,
): { live: boolean; needsCheck: boolean; conditional: boolean } {
  const { basis } = snapshot;
  const arrangement =
    basis.arrangementKey === undefined ? undefined : arrangements.get(basis.arrangementKey);
  const { unclear, changed, conditional } = requestDoubt(ctx, items, snapshot, arrangement);
  if (arrangement) {
    const live =
      arrangement.live &&
      !superseded &&
      optionStillNeeded(ctx, tasks, items, basis, sentSeq, arrangement);
    return { live, needsCheck: live && (unclear || changed), conditional };
  }
  // 手配が無い：根拠が分からないだけなら、家族が外していない限り、要るかを頼んだ本人に確かめる（取り消しとも
  // 続けてよいとも決めない）。家族が前に外した・選び替えた依頼は、要らないまま（取り消しの連絡を消さない）。
  return unclear && !decidedAgainst(ctx, basis, sentSeq)
    ? { live: true, needsCheck: true, conditional }
    : { live: false, needsCheck: false, conditional };
}

/**
 * 送った後に生じた疑い（requestStanding の needsCheck の中身。要るかは別に見る）。unclear：根拠の事項の
 * どれかが分からない（見つからない・確かでない）。changed：手配があり、根拠や頼んだ時間が送った時と違う。
 * conditional：根拠が今、条件しだい。本命の「はい」で予備をたたむかも、同じ見方で決める。
 */
function requestDoubt(
  ctx: Context,
  items: ReadonlyMap<string, LiveItem>,
  snapshot: RequestSnapshot,
  arrangement: Pick<Arrangement, 'start' | 'end'> | undefined,
): { unclear: boolean; changed: boolean; conditional: boolean } {
  const { basis } = snapshot;
  const fates = basis.itemIds.map((id) => itemFate(ctx.state, id));
  const current = fates.flatMap((fate) =>
    fate.status === 'current' ? [items.get(fate.item.id)].filter((i) => i !== undefined) : [],
  );
  const conditional = current.some((i) => i.conditional);
  // 根拠のどれか一つでも分からなければ、他の根拠が残っていても疑いにする。読み直しで、家族の確かめを待つ
  // 「すること」（awaitingConfirmation）も分からない物：手配が無いのは確かめを待つからで、要らなくなったから
  // ではない（確かめていない新しい読み取りで、前に頼んで「はい」をもらった依頼を取り消させない）。
  const unclear = fates.some(
    (fate) =>
      fate.status === 'vanished' ||
      (fate.status === 'current' &&
        ((fate.item.evidence !== 'stated' && fate.item.evidence !== 'confirmed') ||
          awaitingConfirmation(ctx.state, fate.item))),
  );
  const changed =
    arrangement !== undefined &&
    (fates.some((fate) => fate.status === 'cancelled') ||
      current.some((i) => i.doubted) ||
      (conditional && snapshot.conditional === false) ||
      (snapshot.condition !== undefined &&
        snapshot.condition !== basisCondition(ctx.state, basis.itemIds)) ||
      (snapshot.window !== undefined &&
        (!sameTime(snapshot.window.start, arrangement.start) ||
          !sameTime(snapshot.window.end, arrangement.end))) ||
      (snapshot.about !== undefined && snapshot.about !== aboutNow(ctx.state, snapshot)));
  return { unclear, changed, conditional };
}

/** 通用の「すること」の依頼の、今の中身とやり方の版の要約（控えの about と比べる）。 */
function aboutNow(state: EngineState, snapshot: RequestSnapshot): string | undefined {
  const { arrangementKey, optionKey } = snapshot.basis;
  const itemId = snapshot.basis.itemIds[0];
  if (arrangementKey === undefined || optionKey === undefined || itemId === undefined)
    return undefined;
  const prefix = `opt:${arrangementKey}:`;
  if (!optionKey.startsWith(prefix)) return undefined;
  return needWaysBasis(state, itemId, [optionKey.slice(prefix.length)]);
}

/** 頼んだ時間（窓）で依頼を結ぶ手配か：子の居場所と、窓の「すること」。 */
function windowed(arrangement: Pick<Arrangement, 'kind' | 'needShape'>): boolean {
  return (
    arrangement.kind === 'childCare' ||
    (arrangement.kind === 'need' && arrangement.needShape === 'window')
  );
}

/** 依頼の控え。控えの無い古い事象だけ、今の作業から補う（外の相手への作業でなければ無し）。 */
function snapshotOf(request: RequestRecord, task: Task | undefined): RequestSnapshot | undefined {
  return (
    request.snapshot ??
    (task?.external
      ? { to: task.external.to, kind: task.external.kind, basis: task.basis }
      : undefined)
  );
}

/** 依頼は、送った時の控えから作る。控えの無い古い事象だけ、今の作業から補う。 */
function externalRequests(
  ctx: Context,
  tasks: readonly Task[],
  arrangements: readonly Arrangement[],
  items: readonly LiveItem[],
): ExternalRequest[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const arrangementByKey = new Map(arrangements.map((a) => [a.key, a]));
  const itemById = new Map(items.map((i) => [i.item.id, i]));
  const arrangementOf = (request: RequestRecord) => {
    const key =
      request.snapshot?.basis.arrangementKey ?? byKey.get(request.taskKey)?.basis.arrangementKey;
    return key === undefined ? undefined : arrangementByKey.get(key);
  };
  // 今の日の分の依頼を送った作業（日が直された後に送り直した）。前の日の分の依頼は、もう要らない。取り消しを
  // 伝えた依頼は数えない（日が戻っても、取り消した依頼を今の日の分として扱わない）。
  const resent = new Set<string>();
  for (const request of ctx.state.requests.values()) {
    const arrangement = arrangementOf(request);
    if (
      request.state !== 'cancelled' &&
      arrangement?.kind === 'childCare' &&
      requestForDay(request, arrangement, ctx.tz)
    ) {
      resent.add(request.taskKey);
    }
  }
  const result: ExternalRequest[] = [];
  for (const request of ctx.state.requests.values()) {
    const snapshot = snapshotOf(request, byKey.get(request.taskKey));
    if (!snapshot) continue;
    const arrangement = arrangementOf(request);
    const superseded =
      arrangement?.kind === 'childCare' &&
      resent.has(request.taskKey) &&
      !requestForDay(request, arrangement, ctx.tz);
    const { live, needsCheck, conditional } = requestStanding(
      ctx,
      tasks,
      arrangementByKey,
      itemById,
      snapshot,
      request.sentSeq,
      superseded,
    );
    // だれの分か：控えの子。控えに無い古い依頼は、同じキーの手配が今あれば、その手配の子（キーが子を決める）。
    const childId =
      snapshot.childId ?? (arrangement?.kind === 'childCare' ? arrangement.childId : undefined);
    result.push({
      requestId: request.requestId,
      taskKey: request.taskKey,
      to: snapshot.to,
      kind: snapshot.kind,
      sentAt: request.sentAt,
      sentBy: request.sentBy,
      state: request.state,
      basis: snapshot.basis,
      ...('window' in snapshot && snapshot.window ? { window: snapshot.window } : {}),
      ...askedNeedOf(snapshot, request.taskKey),
      ...(childId ? { childId } : {}),
      live,
      ...(needsCheck ? { needsCheck } : {}),
      ...(conditional ? { conditional } : {}),
    });
  }
  return result;
}

/**
 * 通用の「すること」の依頼の、送った時の中身（控えの about。needWaysBasis の形で、案ごとにやり方は一つ）。頼んだ
 * 手順は、作業の鍵（task:案:手順）と、その時のやり方の版から読む。読めない・形の違う控えからは作らない（今の値で
 * 埋めない）。
 */
function askedNeedOf(
  snapshot: RequestSnapshot,
  taskKey: string,
): Pick<ExternalRequest, 'askedNeed'> {
  if (snapshot.about === undefined) return {};
  let need: Record<string, unknown> | undefined;
  let ways: unknown;
  try {
    ({ need, ways } = JSON.parse(snapshot.about) as {
      need?: Record<string, unknown>;
      ways?: unknown;
    });
  } catch {
    return {};
  }
  const optionKey = snapshot.basis.optionKey;
  const prefix = optionKey === undefined ? undefined : `task:${optionKey}:`;
  const stepId = prefix && taskKey.startsWith(prefix) ? taskKey.slice(prefix.length) : undefined;
  const way =
    Array.isArray(ways) && ways.length === 1 ? (ways[0] as { steps?: unknown }) : undefined;
  const found = Array.isArray(way?.steps)
    ? (way.steps as { id?: unknown; name?: unknown; cover?: unknown }[]).find(
        (s) => s.id === stepId,
      )
    : undefined;
  const step =
    found && typeof found.name === 'string'
      ? { name: found.name, cover: found.cover === true }
      : undefined;
  const text = (key: string) =>
    typeof need?.[key] === 'string' ? (need[key] as string) : undefined;
  const what = text('what');
  if (what === undefined) return {};
  const deadline = text('deadline');
  const place = text('place');
  const forMemberId = text('forMemberId');
  return {
    askedNeed: {
      what,
      ...(step === undefined ? {} : { step }),
      ...(place === undefined ? {} : { place }),
      ...(forMemberId === undefined ? {} : { forMemberId }),
      ...(deadline !== undefined && isValidDateTime(deadline) ? { deadline } : {}),
      ...(need?.deadlineDayOnly === true ? { deadlineDayOnly: true as const } : {}),
    },
  };
}

/** 前提が消えた依頼で、まだ取り消していない物には、取り消しの連絡の作業を作る（§4）。 */
function cancellationTasks(ctx: Context, requests: readonly ExternalRequest[]): Task[] {
  return requests
    .filter((r) => !r.live && (r.state === 'awaitingReply' || r.state === 'confirmed'))
    .map((r) =>
      task(ctx, keys.cancellationTask(r.requestId), {
        titleKey: 'task.cancelRequest',
        titleParams: { to: r.to },
        basis: r.basis,
        durationMin: 5,
        after: [],
        segments: ['home', 'commute', 'work'],
        assigneeId: r.sentBy,
        live: true,
        cancels: r.requestId,
      }),
    );
}
