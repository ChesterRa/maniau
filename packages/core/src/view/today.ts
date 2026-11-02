// 「きょう」の画面に、誰に何を出すか（docs/plan/02-product.md の画面、§7 の引き受け）。
// 一人の大人に、今やる事だけを出す。決める事・頼まれた事・取り消し・聞く事を上に、
// 返事待ちと引き受けた事は下に静かに並べる。計画の計算はしない（PlanResult を読むだけ）。
import type {
  Arrangement,
  ExternalRequest,
  OptionPlan,
  PlanResult,
  Question,
  Requirement,
  Task,
} from '../schema/plan';
import { toEpochMinutes } from '../time';

export type TodayCard =
  /** 要らなくなった依頼の取り消しを伝える（頼んだ本人に）。 */
  | { kind: 'cancel'; task: Task; request: ExternalRequest }
  /**
   * 頼んだ依頼の根拠が分からなくなった（読み直しで見つからない、条件しだいの取り消しが来た等）。
   * 取り消したとも、続けてよいとも決めず、まだ要るかを頼んだ本人に確かめる（02-foundation §5.6）。
   */
  | { kind: 'check'; request: ExternalRequest }
  /** 本命の返事待ちのまま、次の案の決め時が近い：予備を押さえるか（頼んだ本人に）。 */
  | { kind: 'backup'; arrangement: Arrangement; option: OptionPlan; waitingFor: ExternalRequest }
  /** 選ぶ事（まだ選んでいない、または選んだ案が使えなくなった）。 */
  | {
      kind: 'decide';
      arrangement: Arrangement;
      requirement?: Requirement;
      recommended?: OptionPlan;
    }
  /** 自分に頼まれた作業（引き受けるか）。 */
  | { kind: 'proposal'; task: Task; arrangement?: Arrangement }
  /** 答えで段取りが変わる問い。 */
  | { kind: 'question'; question: Question; requirement?: Requirement }
  /** 自分が頼んで、返事を待っている。 */
  | { kind: 'waiting'; request: ExternalRequest }
  /** 自分が引き受けた、まだ済んでいない作業。 */
  | { kind: 'todo'; task: Task };

/** 予備を勧め始める時：次の案の決め時のこの時間前から（前の晩に知らせる）。 */
export const BACKUP_LEAD_MIN = 26 * 60;

/** その作業が、家族が選んだ（または勧められた買い物の）案の物か。比べるための候補の作業は出さない。 */
export function isActiveTask(plan: PlanResult, task: Task): boolean {
  const { arrangementKey, optionKey } = task.basis;
  if (arrangementKey === undefined || optionKey === undefined) return true;
  const arrangement = plan.arrangements.find((a) => a.key === arrangementKey);
  if (!arrangement?.live) return false;
  // 当日の準備は、今使う案の物だけ（本命が生きている間の予備の弁当は、まだ候補）。
  if (task.extra && arrangement.inUseOptionKey !== optionKey) return false;
  if (arrangement.chosenOptionKey === optionKey) return true;
  if (arrangement.backupOptionKeys.includes(optionKey)) return true;
  return (
    arrangement.kind === 'purchase' &&
    arrangement.status === 'decidable' &&
    arrangement.recommendedOptionKey === optionKey
  );
}

export function todayCards(
  plan: PlanResult,
  memberId: string,
): { main: TodayCard[]; quiet: TodayCard[] } {
  const now = toEpochMinutes(plan.now);
  const requirementOf = (arrangement?: Arrangement) =>
    plan.requirements.find((r) => r.key === arrangement?.requirementKey);

  const cancel: TodayCard[] = [];
  for (const task of plan.tasks) {
    if (!task.live || task.cancels === undefined || task.assigneeId !== memberId) continue;
    if (task.commitment === 'done' || task.commitment === 'declined') continue;
    const request = plan.requests.find((r) => r.requestId === task.cancels);
    if (request && request.state !== 'cancelled') cancel.push({ kind: 'cancel', task, request });
  }

  const check: TodayCard[] = plan.requests
    .filter(
      (r) =>
        r.needsCheck === true &&
        r.sentBy === memberId &&
        (r.state === 'awaitingReply' || r.state === 'confirmed'),
    )
    .map((request) => ({ kind: 'check', request }));

  const backup: TodayCard[] = [];
  const decide: TodayCard[] = [];
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live) continue;
    if (arrangement.status === 'dependsOnReply') {
      // 根拠が分からない依頼は、ふつうの返事待ちとして予備を勧めない（まず要るかを確かめる）。
      const waitingFor = plan.requests.find(
        (r) =>
          r.live &&
          r.needsCheck !== true &&
          r.state === 'awaitingReply' &&
          r.sentBy === memberId &&
          r.basis.arrangementKey === arrangement.key,
      );
      const taken = new Set([arrangement.chosenOptionKey, ...arrangement.backupOptionKeys]);
      const next = arrangement.options
        .filter((o) => !taken.has(o.key) && !o.expired && o.decisionDeadline !== undefined)
        .sort((a, b) => (a.decisionDeadline ?? '').localeCompare(b.decisionDeadline ?? ''))[0];
      if (waitingFor && next?.decisionDeadline) {
        const left = toEpochMinutes(next.decisionDeadline) - now;
        if (left > 0 && left <= BACKUP_LEAD_MIN) {
          backup.push({ kind: 'backup', arrangement, option: next, waitingFor });
        }
      }
      continue;
    }
    if (arrangement.kind === 'childCare' && arrangement.status !== 'askFirst') {
      const needsChoice =
        arrangement.chosenOptionKey === undefined || arrangement.recommendedOptionKey !== undefined;
      if (needsChoice && arrangement.status !== 'infeasible') {
        const recommended = arrangement.options.find(
          (o) => o.key === arrangement.recommendedOptionKey,
        );
        const requirement = requirementOf(arrangement);
        decide.push({
          kind: 'decide',
          arrangement,
          ...(requirement ? { requirement } : {}),
          ...(recommended ? { recommended } : {}),
        });
      }
    }
  }

  const proposal: TodayCard[] = [];
  const todo: TodayCard[] = [];
  for (const task of plan.tasks) {
    if (!task.live || task.assigneeId !== memberId || task.cancels !== undefined) continue;
    if (!isActiveTask(plan, task)) continue;
    const arrangement = plan.arrangements.find((a) => a.key === task.basis.arrangementKey);
    // 引き受けた後に中身が変わった作業は、提案として見せ直す（引き受け直してもらう）。
    if (task.commitment === 'proposed' || (task.commitment === 'accepted' && task.reconfirm)) {
      proposal.push({ kind: 'proposal', task, ...(arrangement ? { arrangement } : {}) });
    } else if (task.commitment === 'accepted') {
      todo.push({ kind: 'todo', task });
    }
  }

  const question: TodayCard[] = plan.questions
    .filter((q) => q.toMemberId === undefined || q.toMemberId === memberId)
    .map((q) => {
      const arrangement = plan.arrangements.find((a) => q.affects.includes(a.key));
      const requirement = requirementOf(arrangement);
      return { kind: 'question', question: q, ...(requirement ? { requirement } : {}) };
    });

  const waiting: TodayCard[] = plan.requests
    .filter(
      (r) =>
        r.live && r.needsCheck !== true && r.state === 'awaitingReply' && r.sentBy === memberId,
    )
    .map((request) => ({ kind: 'waiting', request }));

  return {
    main: [...cancel, ...check, ...backup, ...decide, ...proposal, ...question],
    quiet: [...waiting, ...todo],
  };
}
