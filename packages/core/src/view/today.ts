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
import { addDays, type DateTime, toEpochMinutes } from '../time';

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
  /**
   * 担当がいない作業（02-foundation の不変 7「誰かが持つ」）：担当が付いていないか、担当の人が断った・
   * できなくなった。大人の全員に出し、誰かが自分で持つか、頼むか、その案をやめるまで残す。
   */
  | { kind: 'unowned'; task: Task; arrangement?: Arrangement }
  /**
   * 登録した手立て（ふだんの週・店・取れる手と決め時）では、間に合う方法が見つからなかった
   * （01-model §8「このままでは無理」）。必要な日までは大人の全員に出し、ほかの手を考えてもらう。
   * 探した範囲で見つからなかっただけで、実際にできないとは言わない。
   */
  | { kind: 'stuck'; arrangement: Arrangement; requirement?: Requirement }
  /** 答えで段取りが変わる問い。 */
  | { kind: 'question'; question: Question; requirement?: Requirement }
  /** 自分が頼んで、返事を待っている。 */
  | { kind: 'waiting'; request: ExternalRequest }
  /** 自分が引き受けた、まだ済んでいない作業。 */
  | { kind: 'todo'; task: Task }
  /**
   * 使う日の前の日と使う日の、持って行く物（家にあると答えた物、買い終えた物、用意の締切の後に無いと
   * 答えた物）。大人の全員に、静かに出す。reanswer：家にあるかを、まだ答え直せるか（atHomeAnswerable）。
   */
  | { kind: 'bring'; requirement: Requirement; bought: boolean; reanswer: boolean };

/**
 * 持ち物が家にあるかに答えられる間（画面・一言・サーバーで同じ決まり）。要件が生きていて、用意の締切の前か、
 * 書かれた使う日が終わるまで。締切の後の答えでは買う手配を作らず、家族が知った事として二人に見せる（無ければ、
 * どうするかは家族が決める）。使う日の書かれていない物は、締切の前だけ。now は計画の今（家庭の時区で書いた
 * 時刻。日をそのまま読める）。
 */
export function atHomeAnswerable(requirement: Requirement, now: DateTime): boolean {
  if (!requirement.live || requirement.atHomeUnknownId === undefined) return false;
  if (requirement.by !== undefined && toEpochMinutes(requirement.by) > toEpochMinutes(now)) {
    return true;
  }
  return requirement.date !== undefined && now.slice(0, 10) <= requirement.date;
}

/** 予備を勧め始める時：次の案の決め時のこの時間前から（前の晩に知らせる）。 */
export const BACKUP_LEAD_MIN = 26 * 60;

/** その作業が、家族が選んだ（または勧められた買い物の）案の物か。比べるための候補の作業は出さない。 */
export function isActiveTask(
  plan: Pick<PlanResult, 'arrangements' | 'requests'>,
  task: Task,
): boolean {
  const { arrangementKey, optionKey } = task.basis;
  if (arrangementKey === undefined || optionKey === undefined) return true;
  const arrangement = plan.arrangements.find((a) => a.key === arrangementKey);
  if (!arrangement?.live) return false;
  // 当日の準備は、今使う案の物だけ（本命が生きている間の予備の弁当は、まだ候補）。
  if (task.extra && arrangement.inUseOptionKey !== optionKey) return false;
  if (arrangement.chosenOptionKey === optionKey) return true;
  // 予備は、本命が「はい」で決まるまでと、予備を使う時（本命が決まったら、もう進めない。送った依頼の
  // 取り消しは、別に出す）。返事を待っていないだけ（送っていなかった等）は、決まったとしない。
  if (arrangement.backupOptionKeys.includes(optionKey)) {
    return arrangement.inUseOptionKey === optionKey || !primaryConfirmed(plan, arrangement);
  }
  return (
    arrangement.kind === 'purchase' &&
    arrangement.status === 'decidable' &&
    arrangement.recommendedOptionKey === optionKey
  );
}

/**
 * 依頼が、今の手配の日の分か（エンジンと同じ見方：子の居場所の手配は、控えの頼んだ日が今の日と同じ物だけ。
 * 控えに時間の無い古い事象は、時間からは決めない。時刻は家庭の時区で書いてあるので、日をそのまま読める）。
 * 日が直されたら、前の日の返事で今の日を決めない。
 */
function forDay(request: ExternalRequest, arrangement: Arrangement): boolean {
  return (
    arrangement.kind !== 'childCare' ||
    request.window === undefined ||
    request.window.start.slice(0, 10) === arrangement.start.slice(0, 10)
  );
}

/**
 * 本命の案が、外の相手の「はい」で決まった（今の日の分で、返事を待つ依頼も、確かめの要る依頼も無く、確定の
 * 依頼がある）。「はい」の後に疑いが生じた依頼は、確かめるまで決まったとしない（予備をたたまない）。
 */
function primaryConfirmed(plan: Pick<PlanResult, 'requests'>, arrangement: Arrangement): boolean {
  const chosen = arrangement.chosenOptionKey;
  if (chosen === undefined || arrangement.inUseOptionKey !== chosen) return false;
  const requests = plan.requests.filter(
    (r) =>
      r.live && r.state !== 'cancelled' && r.basis.optionKey === chosen && forDay(r, arrangement),
  );
  return (
    requests.some((r) => r.state === 'confirmed') &&
    !requests.some((r) => r.state === 'awaitingReply' || r.needsCheck === true)
  );
}

/**
 * 案を始めたか（手順を一つでも済ませた・今の日の分の依頼を送った）。手配の「決め時を過ぎても始めていない」と
 * 同じ見方。取り消しを伝えた依頼は、送ったことにしない。
 */
function started(plan: PlanResult, arrangement: Arrangement, optionKey: string): boolean {
  return (
    plan.tasks.some((t) => t.basis.optionKey === optionKey && t.commitment === 'done') ||
    plan.requests.some(
      (r) => r.basis.optionKey === optionKey && r.state !== 'cancelled' && forDay(r, arrangement),
    )
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

  const stuck: TodayCard[] = [];
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live || arrangement.status === 'askFirst') continue;
    // 間に合う手が見つからない時と、買い物でどの店で買えるか分からない時（家に無いと分かった後）。
    const noStore =
      arrangement.kind === 'purchase' &&
      arrangement.reasons.some((r) => r.code === 'inputMissing' && r.refs.includes('storeKind'));
    if (!noStore && !arrangement.reasons.some((r) => r.code === 'noOptionLeft')) continue;
    if (toEpochMinutes(arrangement.end) <= now) continue;
    const requirement = requirementOf(arrangement);
    stuck.push({ kind: 'stuck', arrangement, ...(requirement ? { requirement } : {}) });
  }

  const unowned: TodayCard[] = [];
  for (const task of plan.tasks) {
    if (!task.live || task.cancels !== undefined || !isActiveTask(plan, task)) continue;
    const nobody =
      task.assigneeId === undefined ||
      task.commitment === 'declined' ||
      task.commitment === 'withdrawn';
    if (!nobody) continue;
    const arrangement = plan.arrangements.find((a) => a.key === task.basis.arrangementKey);
    // 決め時を過ぎて、まだ始めていない案の作業は、もう持てない（手配の状態が、選び直しを出す）。始めた
    // 案（手順を済ませた・依頼を送った）の残りの手順は、決め時の後も出す（手配もまだその案を使う）。
    const option = arrangement?.options.find((o) => o.key === task.basis.optionKey);
    if (arrangement && option?.expired && !started(plan, arrangement, option.key)) continue;
    unowned.push({ kind: 'unowned', task, ...(arrangement ? { arrangement } : {}) });
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

  const bring: TodayCard[] = [];
  // 使う日の前の日と、使う日（一日中。家を出る時刻は家庭ごとに違うので、朝で消さない）。計画の今は、
  // 家庭の時区で書いてある（日をそのまま読める）。
  const today = plan.now.slice(0, 10);
  for (const requirement of plan.requirements) {
    const day = requirement.date;
    if (requirement.kind !== 'belongings' || !requirement.live || !day) continue;
    if (today !== addDays(day, -1) && today !== day) continue;
    const reanswer = atHomeAnswerable(requirement, plan.now);
    // 買い終えた物（用意の締切の後で買い物の手配が無くても、要件が覚えている）。買った後に見つからなければ、
    // 「やっぱり無かった」と答え直せる（後の答えが今の事実になる）。
    if (requirement.bought) {
      bring.push({ kind: 'bring', requirement, bought: true, reanswer });
      continue;
    }
    if (requirement.atHome === 'yes') {
      bring.push({ kind: 'bring', requirement, bought: false, reanswer });
    } else if (
      requirement.atHome === 'no' &&
      requirement.by !== undefined &&
      toEpochMinutes(requirement.by) <= now
    ) {
      // 無いと答えて、用意の締切を過ぎた物（もう買う手配は作らない）。無いことを二人に見せる。締切の前の
      // 物は、買い物の作業や「このままでは無理」が出す。
      bring.push({ kind: 'bring', requirement, bought: false, reanswer });
    }
  }

  const waiting: TodayCard[] = plan.requests
    .filter(
      (r) =>
        r.live && r.needsCheck !== true && r.state === 'awaitingReply' && r.sentBy === memberId,
    )
    .map((request) => ({ kind: 'waiting', request }));

  // 担当の決まっていない作業と、引き受けを待つ作業は、要る時の早い順に並べる（遠い日の当日の準備で、明日の
  // 作業を下に押しやらない。初めに見せる札の数は限られる）。要る時：置いた時刻、無ければ始められる時、締切、
  // 案の決め時の順。分からない物は後。同じなら、担当の決まっていない物を先に（元の順を保つ）。
  const dueOf = (card: TodayCard): number => {
    if (card.kind !== 'unowned' && card.kind !== 'proposal') return Number.POSITIVE_INFINITY;
    const { task } = card;
    const option = plan.arrangements
      .find((a) => a.key === task.basis.arrangementKey)
      ?.options.find((o) => o.key === task.basis.optionKey);
    const when = task.start ?? task.earliestStart ?? task.deadline ?? option?.decisionDeadline;
    return when === undefined ? Number.POSITIVE_INFINITY : toEpochMinutes(when);
  };
  const work = [...unowned, ...proposal]
    .map((card, index) => ({ card, index, due: dueOf(card) }))
    .sort((x, y) => x.due - y.due || x.index - y.index)
    .map((x) => x.card);
  return {
    main: [...cancel, ...check, ...backup, ...decide, ...stuck, ...work, ...question],
    quiet: [...bring, ...waiting, ...todo],
  };
}
