// 事象の列と今の時刻から、計画の結果を作る（docs/design/01-model.md §1 の 3〜9）。
// v0：要件 → 手配 → 案と決め時（逆算の目安）→ 問い → 買い物の置き場所 → 取り消しの連絡。
// 計画全体を解いての決め時の確かめ（§5 の2）と、最小の組み直し（§8）は、まだ無い。
import { evaluateCondition } from '../schema/condition';
import type { DomainEvent } from '../schema/events';
import type { CareOptionTemplate, Cost, Household } from '../schema/household';
import type {
  Arrangement,
  ExternalRequest,
  OptionPlan,
  PlanResult,
  PlanStatus,
  Question,
  Reason,
  Requirement,
  Task,
} from '../schema/plan';
import type { ConditionNode, Item } from '../schema/source';
import {
  addDays,
  type DateTime,
  type EpochMinutes,
  formatDateTime,
  type LocalDate,
  toEpochMinutes,
  zonedToEpochMinutes,
} from '../time';
import { noAdultAtHome } from './availability';
import { optionDeadline } from './deadline';
import { purchaseOpportunities } from './purchase';
import { currentItems, type EngineState, foldEvents } from './state';

/** 代償の重みの初期値（家族が変えられる。§8）。安い案ほど小さい。 */
export const DEFAULT_COST_WEIGHTS = {
  leaveMinutes: 1,
  helperRequests: 200,
  yen: 0.1,
  extraTasks: 30,
};
const PURCHASE_MINUTES = 15;
/** 問いの期限は、最後の買える時より、この分だけ前に置く（答えを受けて動ける時間）。 */
const QUESTION_LEAD_MIN = 24 * 60;

/** 安定したキー（§4）。種類と、置き換えをたどった元の事項の ID から作る。時刻や担当は入れない。 */
export const keys = {
  childCareRequirement: (rootId: string, childId: string) => `req:childCare:${rootId}:${childId}`,
  childCareArrangement: (rootId: string, childId: string) => `arr:childCare:${rootId}:${childId}`,
  belongingsRequirement: (rootId: string) => `req:belongings:${rootId}`,
  purchaseArrangement: (rootId: string) => `arr:purchase:${rootId}`,
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

/** 品物の名前から、店で扱う品物の種類へ。v0 は小さな対応表。後で Claude の推定（店の種類）に替える。 */
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
}

export function computePlan(events: readonly DomainEvent[], now?: DateTime): PlanResult {
  const state = foldEvents(events);
  const household = state.household;
  if (!household) throw new Error('家族の情報（householdSet）が無い');
  const nowMin = state.clock ?? (now === undefined ? undefined : toEpochMinutes(now));
  if (nowMin === undefined) throw new Error('今の時刻が無い');
  const tz = household.timeZone;
  const ctx: Context = { state, household, now: nowMin, tz, fmt: (m) => formatDateTime(m, tz) };

  const nodes: ConditionNode[] = [...state.extractions.values()].flatMap((e) => e.conditions);
  const assignment = new Map([...state.resolved].map(([id, r]) => [id, r.value]));
  const items = currentItems(state).map(({ item, rootId, rootSourceId }) => {
    const truth = item.conditionNodeId
      ? evaluateCondition(item.conditionNodeId, nodes, assignment)
      : true;
    return { item, rootId, rootSourceId, live: truth !== false };
  });

  const requirements: Requirement[] = [];
  const arrangements: Arrangement[] = [];
  const tasks: Task[] = [];
  const questions: Question[] = [];

  for (const { item, rootId, rootSourceId, live } of items) {
    if (item.kind === 'dayChange' && item.interpretation.dayType === 'noSchool') {
      childCare(ctx, item, rootId, live, requirements, arrangements, tasks);
    }
    if (item.kind === 'belongings') {
      const by = belongingsDeadline(ctx, item, rootSourceId, items);
      purchase(
        ctx,
        item,
        rootId,
        live,
        by,
        assignment,
        requirements,
        arrangements,
        tasks,
        questions,
      );
    }
  }

  const requests = externalRequests(ctx, tasks);
  tasks.push(...cancellationTasks(ctx, requests));

  return {
    householdId: household.id,
    now: ctx.fmt(nowMin),
    throughSeq: state.lastSeq,
    requirements,
    arrangements,
    tasks,
    requests,
    questions,
    notifications: [],
  };
}

function childCare(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  requirements: Requirement[],
  arrangements: Arrangement[],
  tasks: Task[],
): void {
  const date = item.interpretation.date;
  if (!date) return;
  for (const child of ctx.household.members.filter((m) => m.kind === 'child' && m.active)) {
    const requirementKey = keys.childCareRequirement(rootId, child.id);
    const basis = { itemIds: [item.id], requirementKey };
    requirements.push({
      key: requirementKey,
      kind: 'childCare',
      what: item.interpretation.what ?? item.written,
      date,
      nature: 'required',
      basis,
      live,
    });
    const gap = noAdultAtHome(ctx.household, date).sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    )[0];
    if (!gap) continue;
    const arrangementKey = keys.childCareArrangement(rootId, child.id);
    const options = ctx.household.careOptions.map((template) =>
      careOption(ctx, template, arrangementKey, requirementKey, item, date, live, tasks),
    );
    arrangements.push(
      withStatus(
        ctx,
        {
          key: arrangementKey,
          requirementKey,
          kind: 'childCare',
          childId: child.id,
          start: ctx.fmt(gap.start),
          end: ctx.fmt(gap.end),
          status: 'decidable',
          options,
          backupOptionKeys: [...(ctx.state.backups.get(arrangementKey) ?? [])],
          reasons: [],
          live,
          ...chosen(ctx, arrangementKey),
        },
        tasks,
      ),
    );
  }
}

function chosen(ctx: Context, arrangementKey: string): { chosenOptionKey?: string } {
  const key = ctx.state.primary.get(arrangementKey);
  return key === undefined ? {} : { chosenOptionKey: key };
}

function careOption(
  ctx: Context,
  template: CareOptionTemplate,
  arrangementKey: string,
  requirementKey: string,
  item: Item,
  needDate: LocalDate,
  live: boolean,
  tasks: Task[],
): OptionPlan {
  const optionKey = keys.option(arrangementKey, template.id);
  const result = optionDeadline(template, needDate, ctx.household, ctx.now);
  const basis = { itemIds: [item.id], requirementKey, arrangementKey, optionKey };
  const taskKeys: string[] = [];
  template.steps.forEach((step, index) => {
    const placed = result.steps[index];
    const key = keys.task(optionKey, step.id);
    taskKeys.push(key);
    const previous = template.steps[index - 1];
    tasks.push(
      task(ctx, key, {
        step: { templateId: template.id, stepId: step.id },
        titleKey: step.titleKey,
        titleParams: {},
        basis,
        durationMin: step.durationMin,
        deadline: ctx.fmt(result.ruleDeadline),
        after: previous
          ? [{ taskKey: keys.task(optionKey, previous.id), waitMin: previous.waitAfterMin }]
          : [],
        segments: step.segments,
        ...(step.placeId === undefined ? {} : { placeId: step.placeId }),
        ...(step.external === undefined ? {} : { external: step.external }),
        ...(placed
          ? {
              assigneeId: placed.memberId,
              start: ctx.fmt(placed.start),
              end: ctx.fmt(placed.end),
              ...(placed.slot.placeId === undefined ? {} : { atPlaceId: placed.slot.placeId }),
            }
          : {}),
        live,
      }),
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
        titleParams: {},
        basis,
        durationMin: extra.durationMin,
        earliestStart: ctx.fmt(zonedToEpochMinutes(day, '00:00', ctx.tz)),
        deadline: ctx.fmt(zonedToEpochMinutes(day, '23:59', ctx.tz)),
        after: [],
        segments: extra.segments,
        ...(extra.placeKind === undefined ? {} : { placeKind: extra.placeKind }),
        ...(extra.goods === undefined ? {} : { goods: extra.goods }),
        live,
      }),
    );
  }
  const decisionDeadline = result.decisionDeadline;
  return {
    key: optionKey,
    arrangementKey,
    templateId: template.id,
    titleKey: template.titleKey,
    ...(decisionDeadline === undefined ? {} : { decisionDeadline: ctx.fmt(decisionDeadline) }),
    deadlineCertainty: decisionDeadline === undefined ? 'undetermined' : 'estimate',
    expired: result.expired,
    cost: template.cost,
    taskKeys,
  };
}

function task(
  ctx: Context,
  key: string,
  fields: Omit<Task, 'key' | 'commitment' | 'travelBeforeMin' | 'travelAfterMin' | 'travelSource'> &
    Partial<Pick<Task, 'travelBeforeMin' | 'travelAfterMin' | 'travelSource'>>,
): Task {
  const assignee = ctx.state.assignees.get(key);
  return {
    key,
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    ...fields,
    ...(assignee === undefined ? {} : { assigneeId: assignee }),
    commitment: ctx.state.commitments.get(key) ?? 'proposed',
  };
}

/** 選んだ案が使えなくなったか：依頼が断られた、または決め時を過ぎても始めていない。 */
function failure(ctx: Context, option: OptionPlan): Reason | undefined {
  const requests = [...ctx.state.requests.values()].filter((r) =>
    option.taskKeys.includes(r.taskKey),
  );
  const turned = requests.filter((r) => r.state === 'turnedDown');
  if (turned.length > 0) return { code: 'turnedDown', refs: turned.map((r) => r.requestId) };
  const started =
    requests.length > 0 || option.taskKeys.some((k) => ctx.state.commitments.get(k) === 'done');
  if (option.expired && !started) return { code: 'missedDeadline', refs: [option.key] };
  return undefined;
}

/**
 * 手配の状態（§7）。本命が使えなくなったら（断られた・決め時を過ぎた）、押さえた予備へ移る。
 * 予備も無ければ、残る案から選び直してもらう（勧める案を出す）。
 */
function withStatus(ctx: Context, arrangement: Arrangement, tasks: Task[]): Arrangement {
  if (!arrangement.live) return arrangement;
  void tasks;
  const byKey = new Map(arrangement.options.map((o) => [o.key, o]));
  const chosenKeys = [arrangement.chosenOptionKey, ...arrangement.backupOptionKeys].filter(
    (k): k is string => k !== undefined && byKey.has(k),
  );
  const reasons: Reason[] = [];
  const failed = new Set<string>();
  for (const key of chosenKeys) {
    const option = byKey.get(key);
    const reason = option && failure(ctx, option);
    if (reason) {
      failed.add(key);
      reasons.push(reason);
    }
  }
  const inUse = chosenKeys.find((k) => !failed.has(k));
  if (inUse) {
    const option = byKey.get(inUse);
    const waiting = [...ctx.state.requests.values()].filter(
      (r) => r.state === 'awaitingReply' && option?.taskKeys.includes(r.taskKey),
    );
    if (waiting.length > 0) {
      reasons.push({ code: 'awaitingReply', refs: waiting.map((r) => r.requestId) });
      return { ...arrangement, status: 'dependsOnReply', reasons };
    }
    return { ...arrangement, status: 'decidable', reasons };
  }
  const open = arrangement.options.filter(
    (o) => !o.expired && o.decisionDeadline !== undefined && !failed.has(o.key),
  );
  if (open.length === 0) {
    reasons.push({ code: 'noOptionLeft', refs: arrangement.options.map((o) => o.key) });
    return { ...arrangement, status: 'infeasible', reasons };
  }
  const recommended = [...open].sort(
    (a, b) =>
      costScore(a.cost) - costScore(b.cost) ||
      (b.decisionDeadline ?? '').localeCompare(a.decisionDeadline ?? ''),
  )[0];
  return {
    ...arrangement,
    status: 'decidable',
    reasons,
    ...(recommended ? { recommendedOptionKey: recommended.key } : {}),
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
  items: { item: Item; rootSourceId: string; live: boolean }[],
): EpochMinutes | undefined {
  if (item.interpretation.deadline) return toEpochMinutes(item.interpretation.deadline);
  if (item.interpretation.date)
    return zonedToEpochMinutes(item.interpretation.date, '08:00', ctx.tz);
  const dates = items
    .filter(
      (e) =>
        e.live &&
        e.rootSourceId === rootSourceId &&
        e.item.kind === 'event' &&
        e.item.interpretation.date,
    )
    .map((e) => e.item.interpretation.date as LocalDate)
    .sort();
  const first = dates[0];
  return first === undefined ? undefined : zonedToEpochMinutes(first, '08:00', ctx.tz);
}

function purchase(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  by: EpochMinutes | undefined,
  assignment: ReadonlyMap<string, string>,
  requirements: Requirement[],
  arrangements: Arrangement[],
  tasks: Task[],
  questions: Question[],
): void {
  const what = item.interpretation.what ?? item.written;
  const requirementKey = keys.belongingsRequirement(rootId);
  const basis = { itemIds: [item.id], requirementKey };
  requirements.push({
    key: requirementKey,
    kind: 'belongings',
    what,
    ...(by === undefined ? {} : { by: ctx.fmt(by) }),
    nature: 'required',
    basis,
    live,
  });
  const unknownId = keys.atHomeUnknown(rootId);
  const atHome = assignment.get(unknownId);
  if (atHome === 'yes' || by === undefined) return;

  const arrangementKey = keys.purchaseArrangement(rootId);
  const optionKey = keys.option(arrangementKey, 'buy');
  const goods = goodsFor(what);
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
  if (goods === undefined) {
    status = 'undetermined';
    reasons.push({ code: 'inputMissing', refs: ['storeKind'] });
  } else {
    const key = keys.task(optionKey, 'buy');
    // 誰かが引き受けた・頼まれた買い物は、その人の機会から選ぶ（別の人に勝手に移さない）。
    // 済んだ買い物は、置き直さない。
    const assignee = ctx.state.assignees.get(key);
    const done = ctx.state.commitments.get(key) === 'done';
    const all = purchaseOpportunities(ctx.household, goods, PURCHASE_MINUTES, ctx.now, by);
    const chances = assignee === undefined ? all : all.filter((c) => c.memberId === assignee);
    const first = chances[0];
    const last = chances.at(-1);
    if (done) {
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
    } else if (!first || !last) {
      status = 'infeasible';
      option.expired = true;
      reasons.push({ code: 'noOptionLeft', refs: [optionKey] });
    } else {
      option.decisionDeadline = ctx.fmt(last.start);
      option.deadlineCertainty = 'estimate';
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
          assigneeId: first.memberId,
          start: ctx.fmt(first.start),
          end: ctx.fmt(first.end),
          atPlaceId: first.storeId,
          travelBeforeMin: first.travelBeforeMin,
          travelAfterMin: first.travelAfterMin,
          travelSource: 'estimate',
          ...(first.detour
            ? {
                detour: {
                  plannedArrival: ctx.fmt(first.detour.plannedArrival),
                  delayedArrival: ctx.fmt(first.detour.delayedArrival),
                },
              }
            : {}),
          live,
        }),
      );
      if (atHome === undefined) {
        const questionKey = keys.question(unknownId);
        reasons.push({ code: 'askFirst', refs: [questionKey] });
        questions.push({
          key: questionKey,
          unknownId,
          askBy: ctx.fmt(Math.max(ctx.now, last.start - QUESTION_LEAD_MIN)),
          fallbackValue: 'no',
          affects: [arrangementKey],
        });
      }
    }
  }
  arrangements.push({
    key: arrangementKey,
    requirementKey,
    kind: 'purchase',
    start: ctx.fmt(ctx.now),
    end: ctx.fmt(by),
    status: live ? status : 'decidable',
    options: [option],
    backupOptionKeys: [],
    reasons: live ? reasons : [],
    live,
    ...chosen(ctx, arrangementKey),
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
function optionStillNeeded(ctx: Context, tasks: readonly Task[], task: Task): boolean {
  const { arrangementKey, optionKey } = task.basis;
  if (arrangementKey === undefined || optionKey === undefined) return true;
  if (ctx.state.dropped.get(arrangementKey)?.has(optionKey)) return false;
  const primary = ctx.state.primary.get(arrangementKey);
  const backups = ctx.state.backups.get(arrangementKey) ?? new Set<string>();
  if (primary === undefined && backups.size === 0) return true;
  if (optionKey === primary) return true;
  if (!backups.has(optionKey)) return false;
  if (primary === undefined) return true;
  const primaryTasks = new Set(
    tasks.filter((t) => t.basis.optionKey === primary).map((t) => t.key),
  );
  const primaryRequests = [...ctx.state.requests.values()].filter((r) =>
    primaryTasks.has(r.taskKey),
  );
  const primaryConfirmed =
    primaryRequests.length > 0 && primaryRequests.every((r) => r.state === 'confirmed');
  return !primaryConfirmed;
}

function externalRequests(ctx: Context, tasks: readonly Task[]): ExternalRequest[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const result: ExternalRequest[] = [];
  for (const request of ctx.state.requests.values()) {
    const source = byKey.get(request.taskKey);
    if (!source?.external) continue;
    const live = source.live && optionStillNeeded(ctx, tasks, source);
    result.push({
      requestId: request.requestId,
      taskKey: request.taskKey,
      to: source.external.to,
      kind: source.external.kind,
      sentAt: request.sentAt,
      sentBy: request.sentBy,
      state: request.state,
      basis: source.basis,
      live,
    });
  }
  return result;
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
