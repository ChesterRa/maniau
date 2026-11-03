// 選ぶ前に、選んだら何が起きるか（docs/plan/02-product.md「G1 の結果」の決める画面）。サーバーが、選ぶ命令を
// 書き込まずに事象へ展開し、同じ計算で作った後の計画（after）を、今の計画（before）と比べる。ここは比べる
// だけで、計画は作らない（画面の文も作らない）。
import type { ExternalRequest, PlanResult, Task } from '../schema/plan';
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
    .map((t) => ({
      taskKey: t.key,
      titleKey: t.titleKey,
      titleParams: t.titleParams,
      ...(t.assigneeId === undefined ? {} : { assigneeId: t.assigneeId }),
      ...(t.start === undefined ? {} : { start: t.start }),
      ...(t.end === undefined ? {} : { end: t.end }),
      external: t.external !== undefined,
    }));
  const cancelling = new Set(
    before.tasks.filter((t) => t.live && t.cancels !== undefined).map((t) => t.cancels),
  );
  const cancels = after.tasks
    .filter((t) => t.live && t.cancels !== undefined && !cancelling.has(t.cancels))
    .flatMap((t) => after.requests.filter((r) => r.requestId === t.cancels));
  const moved = after.tasks.flatMap((t) => {
    if (!t.live || t.basis.optionKey === optionKey || t.start === undefined) return [];
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
  const conflicted = (plan: PlanResult) =>
    plan.arrangements.flatMap((a) =>
      a.reasons.filter((r) => r.code === 'timeConflict').flatMap((r) => r.refs),
    );
  const already = new Set(conflicted(before));
  const conflicts = [...new Set(conflicted(after).filter((key) => !already.has(key)))];
  return {
    arrangementKey,
    optionKey,
    current: after.throughSeq === before.throughSeq,
    steps,
    ...(option?.decisionDeadline === undefined
      ? {}
      : { decisionDeadline: option.decisionDeadline }),
    cancels,
    conflicts,
    moved,
  };
}
