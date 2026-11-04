// 計画エンジンを使わず、検証する日だけの区間を家庭の記録から選ぶ。
import type { Household, RoutineSegment } from '@maniau/core';
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
