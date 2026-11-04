// 計画エンジンを使わず、検証する日だけの区間を家庭の記録から選ぶ。
import type { Household, RoutineSegment } from '@maniau/core';
import type { Collector } from './report';
import { weekday } from './time';

export function routinesOn(
  household: Household,
  memberId: string,
  date: string,
): readonly { segments: RoutineSegment[] }[] {
  const exceptions = household.routineExceptions.filter(
    (entry) => entry.memberId === memberId && entry.date === date,
  );
  if (exceptions.length > 0) return exceptions;
  return household.routines.filter(
    (entry) => entry.memberId === memberId && entry.weekday === weekday(date),
  );
}

/** その日だけの一日で、隣り合う場所のつながりを、エンジンとは別に照らす。 */
export function checkExceptionTransitions(household: Household, report: Collector): void {
  for (const day of household.routineExceptions) {
    const ordinary = household.routines.find(
      (entry) => entry.memberId === day.memberId && entry.weekday === weekday(day.date),
    );
    const boundary = (before: RoutineSegment, after: RoutineSegment) =>
      JSON.stringify([
        before.end,
        before.kind,
        before.kind === 'commute' ? before.toId : before.placeId,
        after.start,
        after.kind,
        after.kind === 'commute' ? after.fromId : after.placeId,
      ]);
    const existing = new Set<string>();
    for (let i = 1; i < (ordinary?.segments.length ?? 0); i += 1) {
      const before = ordinary?.segments[i - 1];
      const after = ordinary?.segments[i];
      if (before && after && before.end === after.start) existing.add(boundary(before, after));
    }
    for (let i = 1; i < day.segments.length; i += 1) {
      const before = day.segments[i - 1];
      const after = day.segments[i];
      if (!before || !after || before.end !== after.start) continue;
      // 前から登録されていた境界を、例外を足しただけで新しい問題にしない。
      if (existing.has(boundary(before, after))) continue;
      const from = before.kind === 'commute' ? before.toId : before.placeId;
      const to = after.kind === 'commute' ? after.fromId : after.placeId;
      if (from !== undefined && to !== undefined && from === to) continue;
      report.undetermined(
        'routine_transition_unverified',
        `${day.memberId}:${day.date}`,
        'その日の区間の場所と、その間の移動を確かめられない。',
      );
      break;
    }
  }
}
