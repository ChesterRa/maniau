// 変わったこと（02-product：変更で要らなくなった物を片付ける）。後から届いたお知らせ一通で、前から用意
// していた物のうち、要らなくなった物と、日・期限が変わった物を、それで要る取り消し（誰が伝えるか・伝えた
// か）と一緒に一つにまとめる。二人の大人に同じ物を見せ、自分の分の他に、相手の分と済んだかも分かるように
// する（変わるたびに、何に響くかを頭の中で洗い出す仕事を減らす）。
// 計画は作らない。お知らせの前の事象で作った計画と、今の計画を比べるだけ（サーバーが二つを作って渡す）。
import type { ExternalRequest, PlanResult, Requirement } from '../schema/plan';
import { type DateTime, toEpochMinutes } from '../time';
import { isActiveTask } from './today';

/** 要らなくなった依頼の取り消し。 */
export interface ChangeUndo {
  /** 取り消す依頼。 */
  request: ExternalRequest;
  /** 取り消しを伝える大人（取り消しの作業の担当。済んだ物は、頼んだ人）。 */
  assigneeId: string;
  /** 伝えたと記録した。 */
  done: boolean;
}

export interface ChangedRequirement {
  /** お知らせの前の要件。 */
  before: Requirement;
  /** 今の要件（要らなくなった物には無い）。 */
  after?: Requirement;
  /** この要件のために送っていた依頼の取り消し。 */
  undo: ChangeUndo[];
  /** 日が変わった物の、今の用意：全部済み（true）・まだ有る（false）・作業が無い（無し）。 */
  ready?: boolean;
}

export interface ChangeSummary {
  /** 変えたお知らせ。 */
  sourceId: string;
  receivedAt: DateTime;
  /** 要らなくなった物。 */
  gone: ChangedRequirement[];
  /** 日・期限が変わった物。 */
  moved: ChangedRequirement[];
}

/** 取り消しが全部済んだ後も、届いてからこの間は見せる（何が変わったかを、後から見返せるように）。 */
export const CHANGE_SHOWN_MIN = 24 * 60;

const sameTime = (a: DateTime | undefined, b: DateTime | undefined) =>
  a === undefined || b === undefined ? a === b : toEpochMinutes(a) === toEpochMinutes(b);
const whenOf = (r: Requirement) => r.date ?? r.by ?? '';

/**
 * お知らせの前の計画（before）と今の計画（after）を比べる。前に要った物が要らなくなったか、日・期限が
 * 変わった時だけまとめを返す（新しく要る物だけなら、ふつうの札で足りる）。
 */
export function changeSummary(
  before: PlanResult,
  after: PlanResult,
  source: { id: string; receivedAt: DateTime },
): ChangeSummary | undefined {
  // 取り消しの作業がある依頼（まだ伝えていない）と、このお知らせの後に取り消した依頼（伝えた）。
  // 伝えると作業は計画から消えるので、依頼の状態で済んだと分かる。
  const undoFor = (key: string): ChangeUndo[] =>
    after.requests.flatMap((request) => {
      if (request.basis.requirementKey !== key) return [];
      const task = after.tasks.find((t) => t.cancels === request.requestId);
      const earlier = before.requests.find((r) => r.requestId === request.requestId);
      const cancelled = request.state === 'cancelled' && earlier?.state !== 'cancelled';
      if (!task && !cancelled) return [];
      return [
        {
          request,
          assigneeId: task?.assigneeId ?? request.sentBy,
          done: cancelled || task?.commitment === 'done',
        },
      ];
    });
  const readyOf = (key: string): boolean | undefined => {
    const tasks = after.tasks.filter(
      (t) =>
        t.live &&
        t.cancels === undefined &&
        t.basis.requirementKey === key &&
        isActiveTask(after, t),
    );
    return tasks.length === 0 ? undefined : tasks.every((t) => t.commitment === 'done');
  };
  const gone: ChangedRequirement[] = [];
  const moved: ChangedRequirement[] = [];
  for (const was of before.requirements) {
    if (!was.live) continue;
    const current = after.requirements.find((r) => r.key === was.key);
    if (!current?.live) {
      gone.push({ before: was, undo: undoFor(was.key) });
    } else if (current.date !== was.date || !sameTime(current.by, was.by)) {
      const ready = readyOf(was.key);
      moved.push({
        before: was,
        after: current,
        undo: undoFor(was.key),
        ...(ready === undefined ? {} : { ready }),
      });
    }
  }
  if (gone.length === 0 && moved.length === 0) return undefined;
  const byWhen = (a: ChangedRequirement, b: ChangedRequirement) =>
    whenOf(a.before).localeCompare(whenOf(b.before));
  return {
    sourceId: source.id,
    receivedAt: source.receivedAt,
    gone: gone.sort(byWhen),
    moved: moved.sort(byWhen),
  };
}

/** 今も見せるか：伝えていない取り消しが残る間と、届いてから一日。 */
export function changeOpen(summary: ChangeSummary, now: DateTime): boolean {
  const pending = [...summary.gone, ...summary.moved].some((c) => c.undo.some((u) => !u.done));
  return pending || toEpochMinutes(now) - toEpochMinutes(summary.receivedAt) < CHANGE_SHOWN_MIN;
}
