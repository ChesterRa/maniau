// 「きょう」の画面に、誰に何を出すか（docs/plan/02-product.md の画面、§7 の引き受け）。
// 一人の大人に、今やる事だけを出す。決める事・頼まれた事・取り消し・聞く事を上に、
// 返事待ちと引き受けた事は下に静かに並べる。計画の計算はしない（PlanResult を読むだけ）。
import type {
  Arrangement,
  ExternalRequest,
  OptionPlan,
  PlanResult,
  Question,
  Released,
  Requirement,
  Task,
} from '../schema/plan';
import { addDays, type DateTime, toEpochMinutes } from '../time';

export type TodayCard =
  /**
   * 引き受けた作業が、もう要らなくなった（後のお知らせの取り消し、条件が外れた等）。本人だけに、一番上に出し、
   * 分かったと言う（引き受けの取り下げ）まで残す（約束どおりに動いてしまわないように）。
   */
  | { kind: 'released'; released: Released }
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
  /**
   * 通用の「すること」で、家族が決めることが残っている（needOpen：やり方を選ぶ・選び直す、本命を選ぶ、間に合う
   * やり方が見つからない、やり方の約束がそろった後も受け持ちを確かめられない時間が残る）。大人の全員に出し、
   * 「すること」の画面で決める。
   */
  | { kind: 'need'; arrangement: Arrangement; requirement?: Requirement }
  /**
   * 通用の「すること」で、モデルが読んだ物を、家族がまだ確かめていない（合っている・直す・読み取りが違う）。確かめる
   * まで計画に入れない（手配も作業も無い）。大人の全員に出し、元の文と読み取り（何を・いつ・条件・作用）を見せる。
   */
  | { kind: 'needCheck'; requirement: Requirement }
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

/**
 * 窓の「すること」で、受け持ちを確かめられない時間が残る時、返事待ち・作業の途中でも札を出し始める時：窓の
 * 始まりのこの時間前から（前の晩。返事を待つだけで、間際まで「決めることは無い」と見せない）。
 */
export const NEED_LEAD_MIN = 26 * 60;

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
 * 家族が本命を選び直す時か：選んだ本命・予備のどれも、今は使えない（断られた・決め時を逃した）が、開いた案は
 * 残る（エンジンの withStatus で、使う案が無く、決めてよい）。勧めがあるかとは別（やめたやり方・代償や行ける時間の
 * 分からない案があって勧めない時も、選び直しは要る）。
 */
export function mustChooseAgain(arrangement: Arrangement): boolean {
  return (
    arrangement.live &&
    arrangement.chosenOptionKey !== undefined &&
    arrangement.inUseOptionKey === undefined &&
    arrangement.status === 'decidable'
  );
}

/**
 * 通用の「すること」の手配で、家族が決めることが残っているか。やり方を選ぶ（選び直す）、本命を選ぶ（勧めがある時も）、
 * 間に合うやり方が見つからない、そして窓の「すること」で、今使うやり方の約束を進め終えた後も受け持ちを確かめ
 * られない時間が残る時。返事待ち・作業の途中は、その返事と作業の札が出すので、窓の始まりが近づくまで（NEED_LEAD_MIN）
 * は出さない（同じ事を二度言わない）。近づいたら、まだ確かめられない時間を二人に出す（返事を待つだけで、間際まで
 * 「決めることは無い」と見せない）。聞いてから決める手配は、問いの札が先。
 */
export function needOpen(
  plan: Pick<PlanResult, 'tasks' | 'requests' | 'arrangements' | 'now'>,
  arrangement: Arrangement,
): boolean {
  if (arrangement.kind !== 'need' || arrangement.status === 'askFirst') return false;
  if (arrangement.status === 'undetermined' || arrangement.status === 'infeasible') return true;
  if (arrangement.reasons.some((r) => r.code === 'noOptionLeft')) return true;
  if (arrangement.options.length > 0 && arrangement.chosenOptionKey === undefined) return true;
  if (mustChooseAgain(arrangement)) return true;
  if (!arrangement.reasons.some((r) => r.code === 'notCovered')) return false;
  const inUse = arrangement.inUseOptionKey;
  if (inUse === undefined) return true;
  if (toEpochMinutes(arrangement.start) - toEpochMinutes(plan.now) <= NEED_LEAD_MIN) return true;
  const waiting = plan.requests.some(
    (r) =>
      r.live &&
      r.basis.optionKey === inUse &&
      (r.state === 'awaitingReply' || r.needsCheck === true),
  );
  // 家族の受け持ちは、本人が引き受けて時刻に置いてあれば、もう進める事は無い（覆ったと言えるかは計算が決める）。
  const open = plan.tasks.some(
    (t) =>
      t.live &&
      t.cancels === undefined &&
      t.basis.optionKey === inUse &&
      isActiveTask(plan, t) &&
      t.commitment !== 'done' &&
      !(t.cover === true && t.commitment === 'accepted' && !t.reconfirm && t.start !== undefined),
  );
  return !waiting && !open;
}

/**
 * 「すること」で家族が次に決めること（札・画面・知らせが同じ物を使う）。やり方を選ぶ・選び直す、間に合う進め方が
 * 無い、本命を選ぶ（選べる案が、家族がやめたやり方の物しか無ければ、やり方を選び直す：waysStopped）、受け持ちを
 * 確かめられない時間が残る、の順に見る。
 */
export function needStep(
  arrangement: Arrangement,
): 'ways' | 'waysChanged' | 'waysStopped' | 'noSlot' | 'stuck' | 'choose' | 'gaps' | 'settled' {
  const missing = arrangement.reasons.find((r) => r.code === 'inputMissing');
  if (missing?.refs.includes('waysChanged')) return 'waysChanged';
  // 選んだやり方の案が、ふだんの予定に置ける時間の無い手順を持つ物だけ（まだ判断できない。取れないとは言わない）。
  if (arrangement.reasons.some((r) => r.code === 'noSlot')) return 'noSlot';
  if (arrangement.status === 'undetermined') return 'ways';
  if (
    arrangement.status === 'infeasible' ||
    arrangement.reasons.some((r) => r.code === 'noOptionLeft')
  ) {
    return 'stuck';
  }
  if (arrangement.chosenOptionKey === undefined || mustChooseAgain(arrangement)) {
    const stoppedOnly =
      !arrangement.options.some((o) => choosable(arrangement, o)) &&
      arrangement.options.some((o) => o.stopped === true);
    return stoppedOnly ? 'waysStopped' : 'choose';
  }
  return arrangement.reasons.some((r) => r.code === 'notCovered') ? 'gaps' : 'settled';
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

/**
 * 案を今、本命か予備に選べるか：決め時を過ぎていない。家族がやめたやり方の案は、今の本命・予備の時だけ（残せて、
 * 役を替えられる。新しくは選べない）。予備の勧め・決める事の知らせ・断られた時の次の案は、これで数える。
 */
export function choosable(
  arrangement: Pick<Arrangement, 'chosenOptionKey' | 'backupOptionKeys'>,
  option: Pick<OptionPlan, 'key' | 'expired' | 'stopped'>,
): boolean {
  return (
    !option.expired &&
    (option.stopped !== true ||
      option.key === arrangement.chosenOptionKey ||
      arrangement.backupOptionKeys.includes(option.key))
  );
}

/**
 * 予備に押さえた案のうち、もう確保できている物（本命に断られた時に移れる物）。当日の準備（extra）を除く手順が
 * 一つ以上あって全部済み、外の相手の受け付けが要る手順は、その依頼が今も生きていて、今の日の分として受け付け
 * られている（確かめ待ちでない）時だけ。引き受けただけ・返事待ち・断られた・取り消した物は、確保とは言わない。決め時（申し込みの締切）が
 * 過ぎていても、その前に済ませて受け付けられた物は確保できている。次の予備を勧めるか（きょうの札）と、返事待ちの
 * 行で同じ物を使う（二つの画面で食い違わない）。子の居場所の手配だけ（通用の「すること」は判定しない）。
 */
export function securedBackup(plan: PlanResult, arrangement: Arrangement): OptionPlan | undefined {
  // 子の居場所の手配だけを判定する（その案は、どれも一日を受け持つ手として登録されている）。通用の「すること」の
  // 窓は、受け持ちを別に数える（承認が済んでも、だれかが受け持つとは限らない。将来の受け持ちは引き受けで約束に
  // なる）ので、ここでは確保と言わない（次の予備の勧めも、返事の期限も、今までどおり出す）。
  if (arrangement.kind !== 'childCare') return undefined;
  for (const key of arrangement.backupOptionKeys) {
    const option = arrangement.options.find((o) => o.key === key);
    if (!option) continue;
    const steps = option.taskKeys
      .map((taskKey) => plan.tasks.find((t) => t.key === taskKey))
      .filter((t): t is Task => t !== undefined && !t.extra);
    if (steps.length === 0) continue;
    const secured = steps.every(
      (t) =>
        t.live &&
        t.commitment === 'done' &&
        (t.external === undefined ||
          plan.requests.some(
            (r) =>
              r.taskKey === t.key &&
              r.live &&
              r.needsCheck !== true &&
              r.state === 'confirmed' &&
              forDay(r, arrangement),
          )),
    );
    if (secured) return option;
  }
  return undefined;
}

export function todayCards(
  plan: PlanResult,
  memberId: string,
): { main: TodayCard[]; quiet: TodayCard[] } {
  const now = toEpochMinutes(plan.now);
  const requirementOf = (arrangement?: Arrangement) =>
    plan.requirements.find((r) => r.key === arrangement?.requirementKey);

  const released: TodayCard[] = (plan.released ?? [])
    .filter((r) => r.assigneeId === memberId)
    .map((r) => ({ kind: 'released', released: r }));

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
    // 予備の勧めは、通用の「すること」にも出す（選び直す所は「すること」の画面）。決める札は、子の居場所だけ
    // （「すること」は need の札）。
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
        .filter(
          (o) => !taken.has(o.key) && choosable(arrangement, o) && o.decisionDeadline !== undefined,
        )
        .sort((a, b) => (a.decisionDeadline ?? '').localeCompare(b.decisionDeadline ?? ''))[0];
      // 確保できた予備があれば、次の予備は勧めない（断られたら、その予備に移る）。
      if (waitingFor && next?.decisionDeadline && !securedBackup(plan, arrangement)) {
        const left = toEpochMinutes(next.decisionDeadline) - now;
        if (left > 0 && left <= BACKUP_LEAD_MIN) {
          backup.push({ kind: 'backup', arrangement, option: next, waitingFor });
        }
      }
      continue;
    }
    if (arrangement.kind === 'childCare' && arrangement.status !== 'askFirst') {
      const needsChoice = arrangement.chosenOptionKey === undefined || mustChooseAgain(arrangement);
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

  const need: TodayCard[] = [];
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live || arrangement.kind !== 'need') continue;
    if (toEpochMinutes(arrangement.end) <= now || !needOpen(plan, arrangement)) continue;
    const requirement = requirementOf(arrangement);
    need.push({ kind: 'need', arrangement, ...(requirement ? { requirement } : {}) });
  }

  // モデルが読んだ「すること」で、家族の確かめを待つ物。読み取りの条件で今は要らない物も出す（その条件こそ確かめる
  // 物で、読み違えた条件で確かめの入口を隠さない）。読み取りの日時が過ぎた物も、エンジンが残す。
  const needCheck: TodayCard[] = plan.requirements
    .filter((r) => r.kind === 'need' && r.unconfirmed === true)
    .map((requirement) => ({ kind: 'needCheck', requirement }));

  const stuck: TodayCard[] = [];
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live || arrangement.status === 'askFirst' || arrangement.kind === 'need')
      continue;
    // 間に合う手が見つからない時と、買い物でどの店で買えるか分からない時・店の営業時間か道のりを確かめられず
    // 買う時を決められない時・いつもの店に寄れる時が無い時・扱う店が「使わない」の店だけの時（家に無いと分かった後。
    // どれも、ほかの店で買うかは家族が選ぶ）。
    const noStore =
      arrangement.kind === 'purchase' &&
      arrangement.reasons.some(
        (r) =>
          (r.code === 'inputMissing' &&
            (r.refs.includes('storeKind') || r.refs.includes('storeHours'))) ||
          r.code === 'usualStoreUnavailable' ||
          r.code === 'storeNotUsed',
      );
    if (!noStore && !arrangement.reasons.some((r) => r.code === 'noOptionLeft')) continue;
    if (toEpochMinutes(arrangement.end) <= now) continue;
    const requirement = requirementOf(arrangement);
    stuck.push({ kind: 'stuck', arrangement, ...(requirement ? { requirement } : {}) });
  }

  // 家族が決める値の問いで変わる要件の作業は、答えるまで「だれがやるか」に出さない（決まっていない事を
  // 割り振らない。問いの札に、値ごとに要る物を書く）。もう持った人がいる作業は、そのまま出す。
  const undecided = new Set(plan.questions.flatMap((q) => (q.family ? q.affects : [])));
  const unowned: TodayCard[] = [];
  for (const task of plan.tasks) {
    if (!task.live || task.cancels !== undefined || !isActiveTask(plan, task)) continue;
    if (task.basis.requirementKey !== undefined && undecided.has(task.basis.requirementKey))
      continue;
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

  // 家にあるかの問いも、その持ち物が家族の決める値しだいなら、決めるまで聞かない（先に決める方を聞く）。
  const question: TodayCard[] = plan.questions
    .filter((q) => q.toMemberId === undefined || q.toMemberId === memberId)
    .flatMap((q): TodayCard[] => {
      const arrangement = plan.arrangements.find((a) => q.affects.includes(a.key));
      const requirement = requirementOf(arrangement);
      if (!q.family && requirement && undecided.has(requirement.key)) return [];
      return [{ kind: 'question', question: q, ...(requirement ? { requirement } : {}) }];
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
    main: [
      ...released,
      ...cancel,
      ...check,
      ...backup,
      ...decide,
      ...need,
      ...needCheck,
      ...stuck,
      ...work,
      ...question,
    ],
    quiet: [...bring, ...waiting, ...todo],
  };
}
