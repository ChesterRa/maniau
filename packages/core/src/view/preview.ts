// 選ぶ前に、選んだら何が起きるか（docs/plan/02-product.md「G1 の結果」の決める画面）。サーバーが、選ぶ命令を
// 書き込まずに事象へ展開し、同じ計算で作った後の計画（after）を、今の計画（before）と比べる。ここは比べる
// だけで、計画は作らない（画面の文も作らない）。
import type {
  Arrangement,
  ExternalRequest,
  OptionPlan,
  PlanResult,
  Released,
  Task,
} from '../schema/plan';
import { type DateTime, toEpochMinutes } from '../time';
import { isActiveTask } from './today';

/** 選んだ後の、この案の作業の一つ。 */
export interface PreviewStep {
  taskKey: string;
  titleKey: string;
  titleParams: Record<string, string>;
  assigneeId?: string;
  start?: DateTime;
  end?: DateTime;
  /** 外の相手に頼む・出す作業か。 */
  external: boolean;
}

/** 案を選んだら何が起きるか。 */
export interface ChoicePreview {
  arrangementKey: string;
  optionKey: string;
  /** 選んでも何も変わらない（選ぶ命令が事象を足さない。今の本命を、同じ担当で選び直す等）。 */
  current: boolean;
  /** 選んだ後の、この案の作業（当日の準備を除く。始まりの早い順。時刻の無い物は後）。 */
  steps: PreviewStep[];
  /** 選んだ後の、この案の決め時（大人の誰かが間に合う最後。担当の人の物とは限らない）。 */
  decisionDeadline?: DateTime;
  /**
   * 選ぶ命令で担当にする人（サーバーが付ける。画面の選ぶ操作も同じ人にする）。案に決まった担当が無ければ
   * 自分。自分の時間にもう置けなければ、置ける大人（その人に作業を提案する）。
   */
  assigneeId?: string;
  /** ほかの大人なら、もっと後まで間に合う（その人の最初の作業の始まり。サーバーが付ける）。 */
  later?: { memberId: string; start: DateTime };
  /**
   * 選ぶと、ほかに進める案の作業と同じ人の同じ時間にしか置けなくなる案（時刻を置かない。手配に
   * timeConflict が付く）。今の計画に無かった物だけ。
   */
  conflicts: string[];
  /** 選ぶと要らなくなり、取り消しを伝える作業が新しく出る依頼。 */
  cancels: ExternalRequest[];
  /** 選ぶと、だれかが引き受けていた作業が要らなくなる（その人に知らせる）。今の計画に無かった物だけ。 */
  released: Released[];
  /**
   * 選んだ後の計画を、独立した検証器で確かめて、今の計画に無かった違反（符号）。重なり（task_overlap）は、
   * ほかの作業と両方を置けていないこと。空なら、確かめた範囲で新しい違反は無い（サーバーが付ける）。
   */
  issues?: string[];
  /** 見せた物の要約（サーバーが付ける）。選ぶ命令に添えて送り返し、同じ計算の今の結果と違えば断られる。 */
  seen?: string;
  /**
   * 家族が進めている（今も、選んだ後も）ほかの作業で、時刻が動く物（一緒に置き直したため）。比べるための
   * 候補の作業は数えない。時刻が無くなる物は、conflicts で示す。
   */
  moved: {
    taskKey: string;
    before: Pick<Task, 'start' | 'end'>;
    after: Pick<Task, 'start' | 'end'>;
  }[];
}

const startOf = (t: Pick<Task, 'start'>) =>
  t.start === undefined ? Number.POSITIVE_INFINITY : toEpochMinutes(t.start);

const sameTime = (a: DateTime | undefined, b: DateTime | undefined) =>
  a === undefined || b === undefined ? a === b : toEpochMinutes(a) === toEpochMinutes(b);

/** 作業を、見せる一行の形にする。 */
const stepOf = (t: Task): PreviewStep => ({
  taskKey: t.key,
  titleKey: t.titleKey,
  titleParams: t.titleParams,
  ...(t.assigneeId === undefined ? {} : { assigneeId: t.assigneeId }),
  ...(t.start === undefined ? {} : { start: t.start }),
  ...(t.end === undefined ? {} : { end: t.end }),
  external: t.external !== undefined,
});

/** 家族が進めている作業（比べるための候補と、取り消しを伝える作業を除く）。 */
const inPlay = (plan: PlanResult, t: Task) =>
  t.live && t.cancels === undefined && isActiveTask(plan, t);

/** 取り消しを伝える作業が、後の計画で新しく出る依頼。 */
function newCancels(before: PlanResult, after: PlanResult): ExternalRequest[] {
  const cancelling = new Set(
    before.tasks.filter((t) => t.live && t.cancels !== undefined).map((t) => t.cancels),
  );
  return after.tasks
    .filter((t) => t.live && t.cancels !== undefined && !cancelling.has(t.cancels))
    .flatMap((t) => after.requests.filter((r) => r.requestId === t.cancels));
}

/** 送った依頼のうち、後の計画で新しく確かめが要る物（頼んだ時間や根拠が、送った時と変わった）。 */
function newChecks(before: PlanResult, after: PlanResult): ExternalRequest[] {
  const checking = new Set(before.requests.filter((r) => r.needsCheck).map((r) => r.requestId));
  return after.requests.filter((r) => r.needsCheck && !checking.has(r.requestId));
}

/** だれかが引き受けていた作業が、後の計画で新しく要らなくなる物。 */
function newReleased(before: PlanResult, after: PlanResult): Released[] {
  const releasedBefore = new Set(
    (before.released ?? []).map((r) => `${r.taskKey}:${r.assigneeId}`),
  );
  return (after.released ?? []).filter((r) => !releasedBefore.has(`${r.taskKey}:${r.assigneeId}`));
}

/** 前も後も家族が進めていて、時刻が動く作業（skip の作業は数えない）。時刻が無くなる物は数えない。 */
function movedTasks(
  before: PlanResult,
  after: PlanResult,
  skip: (t: Task) => boolean,
): ChoicePreview['moved'] {
  return after.tasks.flatMap((t) => {
    if (!t.live || skip(t) || t.start === undefined) return [];
    if (!isActiveTask(after, t)) return [];
    const earlier = before.tasks.find((b) => b.key === t.key);
    if (!earlier?.live || earlier.start === undefined || !isActiveTask(before, earlier)) return [];
    if (sameTime(earlier.start, t.start) && sameTime(earlier.end, t.end)) return [];
    return [
      {
        taskKey: t.key,
        before: { start: earlier.start, ...(earlier.end ? { end: earlier.end } : {}) },
        after: { start: t.start, ...(t.end ? { end: t.end } : {}) },
      },
    ];
  });
}

/** ほかの作業と同じ人の同じ時間にしか置けない手（timeConflict）で、後の計画で新しく出る物。 */
function newConflicts(before: PlanResult, after: PlanResult): string[] {
  const conflicted = (plan: PlanResult) =>
    plan.arrangements.flatMap((a) =>
      a.reasons.filter((r) => r.code === 'timeConflict').flatMap((r) => r.refs),
    );
  const already = new Set(conflicted(before));
  return [...new Set(conflicted(after).filter((key) => !already.has(key)))];
}

/** 手の決め時の、前と後（無ければ、その手が無い）。 */
/**
 * 手の決め時の様子。deadlineCertainty が undetermined の時は決め時を計算できず、間に合うとも間に合わないとも
 * 言えない（expired でも、確かめた「もう間に合わない」ではない）。
 */
export interface DeadlineState {
  decisionDeadline?: DateTime;
  deadlineCertainty: OptionPlan['deadlineCertainty'];
  expired: boolean;
}

/**
 * 手配の時間（子の居場所が要る時間、買い物なら今から使う日まで）の変化。before だけなら、その手配が要らなく
 * なり、after だけなら新しく要る（生きている手配だけを比べる）。
 */
export interface WindowChange {
  arrangementKey: string;
  kind: Arrangement['kind'];
  childId?: string;
  /** 通用の「すること」だけ：何を（家族の言葉・原文）と形（締切か窓か）。 */
  what?: string;
  needShape?: Arrangement['needShape'];
  before?: { start: DateTime; end: DateTime };
  after?: { start: DateTime; end: DateTime };
}

export interface DeadlineChange {
  arrangementKey: string;
  optionKey: string;
  titleKey: string;
  before?: DeadlineState;
  after?: DeadlineState;
}

/**
 * 計画が変わる時の差分。選ぶ・家の情報を直す・「もし〜なら」に共通（選んだ手に依らない）。比べるだけで、
 * 計画も文も作らない。空の欄は、その種類の変化が無いこと。
 */
export interface PlanChanges {
  /** 新しく出る作業（家族が進める物。比べるための候補と、取り消しを伝える作業は除く。始まりの早い順）。 */
  added: PreviewStep[];
  /** 無くなる作業（同じく）。 */
  removed: PreviewStep[];
  /** 時刻が動く作業。 */
  moved: ChoicePreview['moved'];
  /** 前は時刻があり、後は時刻を置けなくなる作業（前も後も家族が進める物。重なりとは限らない）。 */
  unplaced: string[];
  /** 前は時刻が無く、後は時刻を置ける作業（同じく）。 */
  placed: string[];
  /** 担当（提案・引き受けの相手）が替わる作業（同じく。無いのは担当なし）。 */
  reassigned: { taskKey: string; before?: string; after?: string }[];
  /** 用件・条件・締切が替わる作業（同じく。引き受け直しが要る物は reconfirm にも出る）。 */
  changed: string[];
  /** 行く所（店など）が替わる作業（同じく。時刻と担当が同じでも、行く所が替われば計画は変わる）。 */
  relocated: { taskKey: string; before?: string; after?: string }[];
  /** 引き受けた後に中身が変わり、引き受け直してもらう作業（新しく付く物）。 */
  reconfirm: string[];
  /** だれかが引き受けていた作業が要らなくなる（新しい物。その人に知らせる）。 */
  released: Released[];
  /** 取り消しを伝える作業が新しく出る依頼。 */
  cancels: ExternalRequest[];
  /** 送った依頼のうち、新しく相手に確かめが要る物（頼んだ時間や根拠が、送った時と変わる）。 */
  checks: ExternalRequest[];
  /** 決め時が動く・間に合わなくなる・間に合うようになる・出る・無くなる手（生きている手配の物）。 */
  deadlines: DeadlineChange[];
  /** 手配の時間が変わる・新しく要る・要らなくなる。 */
  windows: WindowChange[];
  /** 新しく、ほかの作業と同じ人の同じ時間にしか置けなくなる手。 */
  conflicts: string[];
  /**
   * やり方の選びが新しく古くなる「すること」の手配のキー（選んだ時から、選んだやり方か「すること」の中身が替わった。
   * 前の選びは当てず、家族に選び直してもらう）。
   */
  rechoose: string[];
}

/** 今の計画（before）と、変えた後の計画（after）を比べる。 */
export function planChanges(before: PlanResult, after: PlanResult): PlanChanges {
  const was = new Map(before.tasks.filter((t) => inPlay(before, t)).map((t) => [t.key, t]));
  const now = new Map(after.tasks.filter((t) => inPlay(after, t)).map((t) => [t.key, t]));
  const byStart = (a: Task, b: Task) => startOf(a) - startOf(b);
  const added = [...now.values()]
    .filter((t) => !was.has(t.key))
    .sort(byStart)
    .map(stepOf);
  const removed = [...was.values()]
    .filter((t) => !now.has(t.key))
    .sort(byStart)
    .map(stepOf);
  const both = [...now.values()].flatMap((t) => {
    const earlier = was.get(t.key);
    return earlier ? [{ earlier, t }] : [];
  });
  const unplaced = both
    .filter(({ earlier, t }) => t.start === undefined && earlier.start !== undefined)
    .map(({ t }) => t.key);
  const placed = both
    .filter(({ earlier, t }) => t.start !== undefined && earlier.start === undefined)
    .map(({ t }) => t.key);
  const reassigned = both
    .filter(({ earlier, t }) => earlier.assigneeId !== t.assigneeId)
    .map(({ earlier, t }) => ({
      taskKey: t.key,
      ...(earlier.assigneeId === undefined ? {} : { before: earlier.assigneeId }),
      ...(t.assigneeId === undefined ? {} : { after: t.assigneeId }),
    }));
  const relocated = both
    .filter(({ earlier, t }) => earlier.atPlaceId !== t.atPlaceId)
    .map(({ earlier, t }) => ({
      taskKey: t.key,
      ...(earlier.atPlaceId === undefined ? {} : { before: earlier.atPlaceId }),
      ...(t.atPlaceId === undefined ? {} : { after: t.atPlaceId }),
    }));
  const changed = both
    .filter(
      ({ earlier, t }) =>
        earlier.titleKey !== t.titleKey ||
        JSON.stringify(Object.entries(earlier.titleParams).sort()) !==
          JSON.stringify(Object.entries(t.titleParams).sort()) ||
        earlier.condition !== t.condition ||
        !sameTime(earlier.deadline, t.deadline),
    )
    .map(({ t }) => t.key);
  const reconfirmed = new Set(before.tasks.filter((t) => t.reconfirm).map((t) => t.key));
  const reconfirm = after.tasks
    .filter((t) => t.live && t.reconfirm && !reconfirmed.has(t.key))
    .map((t) => t.key);
  const optionsOf = (plan: PlanResult) =>
    new Map(
      plan.arrangements
        .filter((a) => a.live)
        .flatMap((a) => a.options.map((o) => [`${a.key}\u0000${o.key}`, { a, o }] as const)),
    );
  const optionsBefore = optionsOf(before);
  const optionsAfter = optionsOf(after);
  const deadlines: DeadlineChange[] = [];
  for (const key of new Set([...optionsBefore.keys(), ...optionsAfter.keys()])) {
    const earlier = optionsBefore.get(key);
    const later = optionsAfter.get(key);
    const unknown = (o: OptionPlan) => o.deadlineCertainty === 'undetermined';
    const same =
      earlier !== undefined &&
      later !== undefined &&
      earlier.o.expired === later.o.expired &&
      unknown(earlier.o) === unknown(later.o) &&
      sameTime(earlier.o.decisionDeadline, later.o.decisionDeadline);
    if (same) continue;
    const either = later ?? earlier;
    if (!either) continue;
    const shape = (o: OptionPlan): DeadlineState => ({
      ...(o.decisionDeadline === undefined ? {} : { decisionDeadline: o.decisionDeadline }),
      deadlineCertainty: o.deadlineCertainty,
      expired: o.expired,
    });
    deadlines.push({
      arrangementKey: either.a.key,
      optionKey: either.o.key,
      titleKey: either.o.titleKey,
      ...(earlier ? { before: shape(earlier.o) } : {}),
      ...(later ? { after: shape(later.o) } : {}),
    });
  }
  const liveArrangements = (plan: PlanResult) =>
    new Map(plan.arrangements.filter((a) => a.live).map((a) => [a.key, a]));
  const arrangementsBefore = liveArrangements(before);
  const arrangementsAfter = liveArrangements(after);
  const windows: WindowChange[] = [];
  for (const key of new Set([...arrangementsBefore.keys(), ...arrangementsAfter.keys()])) {
    const earlier = arrangementsBefore.get(key);
    const later = arrangementsAfter.get(key);
    if (
      earlier &&
      later &&
      sameTime(earlier.start, later.start) &&
      sameTime(earlier.end, later.end)
    ) {
      continue;
    }
    const either = later ?? earlier;
    if (!either) continue;
    const what =
      either.kind === 'need'
        ? (later ? after : before).requirements.find((r) => r.key === either.requirementKey)?.what
        : undefined;
    windows.push({
      arrangementKey: key,
      kind: either.kind,
      ...(either.childId === undefined ? {} : { childId: either.childId }),
      ...(what === undefined ? {} : { what }),
      ...(either.needShape === undefined ? {} : { needShape: either.needShape }),
      ...(earlier ? { before: { start: earlier.start, end: earlier.end } } : {}),
      ...(later ? { after: { start: later.start, end: later.end } } : {}),
    });
  }
  return {
    added,
    removed,
    moved: movedTasks(before, after, () => false),
    unplaced,
    placed,
    reassigned,
    changed,
    relocated,
    reconfirm,
    released: newReleased(before, after),
    cancels: newCancels(before, after),
    checks: newChecks(before, after),
    deadlines,
    windows,
    conflicts: newConflicts(before, after),
    rechoose: waysChanged(after).filter((key) => !waysChanged(before).includes(key)),
  };
}

/** やり方の選びが古い（選び直しが要る）「すること」の手配（生きている物）。 */
function waysChanged(plan: PlanResult): string[] {
  return plan.arrangements
    .filter(
      (a) =>
        a.live &&
        a.kind === 'need' &&
        a.reasons.some((r) => r.code === 'inputMissing' && r.refs.includes('waysChanged')),
    )
    .map((a) => a.key);
}

/** 選ぶ前の計画（before）と、選んだ後の計画（after）を比べる。 */
export function choicePreview(
  before: PlanResult,
  after: PlanResult,
  arrangementKey: string,
  optionKey: string,
): ChoicePreview {
  const arrangement = after.arrangements.find((a) => a.key === arrangementKey);
  const option = arrangement?.options.find((o) => o.key === optionKey);
  const steps = after.tasks
    .filter(
      (t) =>
        t.live &&
        t.cancels === undefined &&
        !t.extra &&
        t.basis.arrangementKey === arrangementKey &&
        t.basis.optionKey === optionKey,
    )
    .sort((a, b) => startOf(a) - startOf(b))
    .map(stepOf);
  const cancels = newCancels(before, after);
  const released = newReleased(before, after);
  const moved = movedTasks(before, after, (t) => t.basis.optionKey === optionKey);
  const conflicts = newConflicts(before, after);
  return {
    arrangementKey,
    optionKey,
    current: after.throughSeq === before.throughSeq,
    steps,
    ...(option?.decisionDeadline === undefined
      ? {}
      : { decisionDeadline: option.decisionDeadline }),
    cancels,
    released,
    conflicts,
    moved,
  };
}

/** 家と暮らしの情報を直したら、計画の何が変わるか（サーバーが作り、画面が見せる）。 */
export interface HouseholdPreview {
  changes: PlanChanges;
  /** 直した後の計画を、直した家の情報で独立に確かめて、今の計画に無かった違反（符号）。 */
  issues: string[];
  /**
   * 同じく、新しく確かめられなくなった点（未判定の符号）。「問題なし」とは言わず、確かめてと見せる（計算が
   * 足りない・根拠が足りない時に、無いことにしない）。
   */
  unverified: string[];
  /** 見せた物の要約（送られた直しと、上の三つ）。書く時に送り返し、今の同じ計算と違えば断られる。 */
  seen: string;
  /** 見た時の計画の事象の通し番号（書く時に seen と一緒に送り返す）。 */
  throughSeq: number;
  /**
   * 返事の仮定（recordReply）の時だけ：その依頼の手配の、仮定の後の姿（予備に進むか・選び直しか、残る手と決め時）。
   * 仮の計算の結果で、計画ではない（何も書いていない）。
   */
  arrangement?: Arrangement;
}
