// 事象の列と今の時刻から、計画の結果を作る（docs/design/01-model.md §1 の 3〜9）。
// v0：要件 → 手配 → 案と決め時（逆算の目安）→ 問い → 買い物の置き場所 → 取り消しの連絡。
// 計画全体を解いての決め時の確かめ（§5 の2）と、最小の組み直し（§8）は、まだ無い。
import { conditionShape, evaluateCondition, NO_CONDITION } from '../schema/condition';
import {
  type DomainEvent,
  proposalSnapshot,
  type RequestSnapshot,
  sameProposal,
} from '../schema/events';
import type { CareOptionTemplate, Cost, Household } from '../schema/household';
import type {
  Arrangement,
  Basis,
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
import { isActiveTask } from '../view/today';
import { noAdultAtHome } from './availability';
import { type Busy, optionDeadline, placeStep } from './deadline';
import { purchaseOpportunities } from './purchase';
import { currentItems, currentReadings, type EngineState, foldEvents, itemFate } from './state';

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

/** 安定したキー（§4）。種類と、置き換えをたどった元の事項の ID から作る。時刻や担当は入れない。 */
export const keys = {
  childCareRequirement: (rootId: string, childId: string) => `req:childCare:${rootId}:${childId}`,
  childCareArrangement: (rootId: string, childId: string) => `arr:childCare:${rootId}:${childId}`,
  belongingsRequirement: (rootId: string) => `req:belongings:${rootId}`,
  submissionRequirement: (rootId: string) => `req:submission:${rootId}`,
  submissionTask: (rootId: string) => `task:submit:${rootId}`,
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
  /** 今の事項（ID ごと）。作業の根拠が今、確かでないか（doubted）を引く。 */
  items: ReadonlyMap<string, LiveItem>;
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
}

/** 今の事項と、適用されるか・条件しだいか・確かか。 */
export function liveItems(state: EngineState): LiveItem[] {
  const nodes: ConditionNode[] = [...state.extractions.values()].flatMap((e) => e.conditions);
  const assignment = new Map([...state.resolved].map(([id, r]) => [id, r.value]));
  return currentItems(state).map(({ item, rootId, rootSourceId, doubted }) => {
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
}

export function computePlan(events: readonly DomainEvent[], now?: DateTime): PlanResult {
  return planFromState(foldEvents(events), now);
}

/** たたんだ状態から計画を作る（computePlan の中身。同じ状態を他の計算にも使う時に）。 */
export function planFromState(state: EngineState, now?: DateTime): PlanResult {
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
  };

  const requirements: Requirement[] = [];
  const arrangements: Arrangement[] = [];
  const tasks: Task[] = [];
  const questions: Question[] = [];
  const submissions: { item: Item; rootId: string; live: boolean; conditional: boolean }[] = [];

  for (const { item, rootId, rootSourceId, live, trusted, conditional } of items) {
    // 推定・食い違いは、家族が確かめるまで要件を作らない。画面は「確かめてください」として出す。
    if (!trusted) continue;
    if (item.kind === 'dayChange' && item.interpretation.dayType === 'noSchool') {
      childCare(ctx, item, rootId, live, conditional, requirements, arrangements, tasks);
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
        requirements,
        arrangements,
        tasks,
        questions,
      );
    }
    if (item.kind === 'submission') submissions.push({ item, rootId, live, conditional });
  }
  const requests = externalRequests(ctx, tasks, arrangements, items);
  // 提出物の作業は、ほかの作業と依頼がそろった後に置く（持った人の、選んだ案のほかの作業と重ならない
  // ように）。提出物は外の相手が無いので、依頼には影響しない。
  for (const s of submissions) {
    submission(ctx, s.item, s.rootId, s.live, s.conditional, requirements, tasks, {
      arrangements,
      requests,
    });
  }
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
  };
}

function childCare(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  conditional: boolean,
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
      ...(conditional ? { conditional } : {}),
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
          ...(conditional ? { conditional } : {}),
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
  const placedSteps =
    lead === undefined
      ? result.steps
      : optionDeadline(
          {
            ...template,
            steps: template.steps.map((s, i) => {
              const who = assigned[i];
              return who !== undefined && s.assigneeId === undefined
                ? { ...s, assigneeId: who }
                : s;
            }),
          },
          needDate,
          ctx.household,
          ctx.now,
          lead,
        ).steps;
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
        ...(handoff ? { handoff: true } : {}),
        ...(placed && !handoff
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
        extra: true,
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
  const condition = taskCondition(ctx, fields.basis.itemIds);
  const built: Task = {
    key,
    travelBeforeMin: 0,
    travelAfterMin: 0,
    travelSource: 'none',
    ...fields,
    ...(condition === undefined ? {} : { condition }),
    ...(assignee === undefined ? {} : { assigneeId: assignee }),
    commitment: ctx.state.commitments.get(key) ?? 'proposed',
  };
  if (built.commitment !== 'accepted') return built;
  // 引き受けた時に見た提案と、今の提案が同じでなければ、見せ直す（控えの無い古い形も同じ）。
  const shown = ctx.state.shown.get(key);
  const now = proposalSnapshot(built);
  return shown !== undefined && now !== undefined && sameProposal(shown, now)
    ? built
    : { ...built, reconfirm: true };
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
      return { ...arrangement, status: 'dependsOnReply', reasons, inUseOptionKey: inUse };
    }
    return { ...arrangement, status: 'decidable', reasons, inUseOptionKey: inUse };
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
  items: readonly LiveItem[],
): EpochMinutes | undefined {
  if (item.interpretation.deadline) return toEpochMinutes(item.interpretation.deadline);
  if (item.interpretation.date)
    return zonedToEpochMinutes(item.interpretation.date, '08:00', ctx.tz);
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
 * 時間には置かない）。出す日の分からない物は、要件だけにする（作業は作らない）。
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
  if (by === undefined) return;
  const key = keys.submissionTask(rootId);
  const assignee = ctx.state.assignees.get(key);
  const commitment = ctx.state.commitments.get(key) ?? 'proposed';
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
      titleKey: 'task.submit',
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

function purchase(
  ctx: Context,
  item: Item,
  rootId: string,
  live: boolean,
  conditional: boolean,
  by: EpochMinutes | undefined,
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
    ...(conditional ? { conditional } : {}),
  });
  const unknownId = keys.atHomeUnknown(rootId);
  // 答えた時に見せた品物が、今の品物と違えば（直されて別の物になった）、その答えは使わない（家に
  // あるかは、まだ分からないものとして扱う）。
  const answer = ctx.state.resolved.get(unknownId);
  const atHome =
    answer === undefined || (answer.about !== undefined && answer.about !== what)
      ? undefined
      : answer.value;
  // 持って行く時（by）を過ぎたら、もう買う手配も問いも出さない（要件は記録に残す）。
  if (atHome === 'yes' || by === undefined || by <= ctx.now) return;

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
      )
        .filter((c) => c.start < ctx.now && (assignee === undefined || c.memberId === assignee))
        .at(-1);
      option.expired = true;
      if (missed) {
        option.decisionDeadline = ctx.fmt(missed.start);
        option.deadlineCertainty = 'estimate';
      }
      reasons.push({ code: 'noOptionLeft', refs: [optionKey] });
      if (atHome === undefined) {
        status = 'askFirst';
        const questionKey = keys.question(unknownId);
        reasons.push({ code: 'askFirst', refs: [questionKey] });
        // 答えが役に立つのは、持って行く時まで（無ければ、ほかの手を考える時が要る）。
        questions.push({
          key: questionKey,
          unknownId,
          askBy: ctx.fmt(by),
          fallbackValue: 'no',
          affects: [arrangementKey],
        });
      } else {
        // 家に無く、買える時も過ぎた。過ぎた決め時を示せる時だけ「このままでは無理」と言い、示せなければ
        // 判断できないとする（確かめられない時刻で、不可能と言わない）。
        status = missed ? 'infeasible' : 'undetermined';
      }
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
    atHomeUnknownId: unknownId,
    start: ctx.fmt(ctx.now),
    end: ctx.fmt(by),
    status: live ? status : 'decidable',
    options: [option],
    backupOptionKeys: [],
    reasons: live ? reasons : [],
    live,
    ...(conditional ? { conditional } : {}),
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
function optionStillNeeded(ctx: Context, tasks: readonly Task[], basis: Basis): boolean {
  const { arrangementKey, optionKey } = basis;
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
    ...(arrangement?.kind === 'childCare'
      ? { window: { start: arrangement.start, end: arrangement.end } }
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
 * - 手配が無く、根拠がはっきり外れた（取り消し、確かな事項で手当てが要らなくなった）なら、要らない。
 */
function requestStanding(
  ctx: Context,
  tasks: readonly Task[],
  arrangements: ReadonlyMap<string, Arrangement>,
  items: ReadonlyMap<string, LiveItem>,
  snapshot: RequestSnapshot,
): { live: boolean; needsCheck: boolean; conditional: boolean } {
  const { basis } = snapshot;
  const fates = basis.itemIds.map((id) => itemFate(ctx.state, id));
  const current = fates.flatMap((fate) =>
    fate.status === 'current' ? [items.get(fate.item.id)].filter((i) => i !== undefined) : [],
  );
  const conditional = current.some((i) => i.conditional);
  // 根拠のどれか一つでも分からなければ、他の根拠が残っていても疑いにする。
  const unclear = fates.some(
    (fate) =>
      fate.status === 'vanished' ||
      (fate.status === 'current' &&
        fate.item.evidence !== 'stated' &&
        fate.item.evidence !== 'confirmed'),
  );
  const arrangement =
    basis.arrangementKey === undefined ? undefined : arrangements.get(basis.arrangementKey);
  if (arrangement) {
    const live = arrangement.live && optionStillNeeded(ctx, tasks, basis);
    const changed =
      fates.some((fate) => fate.status === 'cancelled') ||
      current.some((i) => i.doubted) ||
      (conditional && snapshot.conditional === false) ||
      (snapshot.condition !== undefined &&
        snapshot.condition !== basisCondition(ctx.state, basis.itemIds)) ||
      (snapshot.window !== undefined &&
        (!sameTime(snapshot.window.start, arrangement.start) ||
          !sameTime(snapshot.window.end, arrangement.end)));
    return { live, needsCheck: live && (unclear || changed), conditional };
  }
  return unclear
    ? { live: true, needsCheck: true, conditional }
    : { live: false, needsCheck: false, conditional };
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
  const result: ExternalRequest[] = [];
  for (const request of ctx.state.requests.values()) {
    const task = byKey.get(request.taskKey);
    const snapshot =
      request.snapshot ??
      (task?.external
        ? { to: task.external.to, kind: task.external.kind, basis: task.basis }
        : undefined);
    if (!snapshot) continue;
    const { live, needsCheck, conditional } = requestStanding(
      ctx,
      tasks,
      arrangementByKey,
      itemById,
      snapshot,
    );
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
      live,
      ...(needsCheck ? { needsCheck } : {}),
      ...(conditional ? { conditional } : {}),
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
