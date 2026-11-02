// 家庭の情報の、型の外の検査：参照の実在と、ふだんの週の区間の重なり。
// 家族の情報を受け取る時（householdSet の事象）と、試験で使う。
import type { Household, RoutineSegment } from './household';

export interface HouseholdIssue {
  path: string;
  problem: 'unknownRef' | 'badSegment' | 'overlap' | 'duplicateId';
  detail: string;
}

export function validateHousehold(household: Household): HouseholdIssue[] {
  const issues: HouseholdIssue[] = [];
  const memberIds = new Set<string>();
  const placeIds = new Set<string>();
  for (const [i, m] of household.members.entries()) {
    if (memberIds.has(m.id))
      issues.push({ path: `members.${i}`, problem: 'duplicateId', detail: m.id });
    memberIds.add(m.id);
  }
  for (const [i, p] of household.places.entries()) {
    if (placeIds.has(p.id))
      issues.push({ path: `places.${i}`, problem: 'duplicateId', detail: p.id });
    placeIds.add(p.id);
  }
  const anyIds = new Set([...memberIds, ...placeIds]);
  const ref = (path: string, id: string | undefined, pool: Set<string>): void => {
    if (id !== undefined && !pool.has(id)) issues.push({ path, problem: 'unknownRef', detail: id });
  };

  for (const [i, p] of household.places.entries()) {
    ref(`places.${i}.nearStationId`, p.nearStationId, placeIds);
  }

  for (const [i, day] of household.routines.entries()) {
    const base = `routines.${i}`;
    ref(`${base}.memberId`, day.memberId, memberIds);
    let previous: RoutineSegment | undefined;
    for (const [j, s] of day.segments.entries()) {
      const at = `${base}.segments.${j}`;
      ref(`${at}.placeId`, s.placeId, placeIds);
      ref(`${at}.fromId`, s.fromId, placeIds);
      ref(`${at}.toId`, s.toId, placeIds);
      for (const [k, v] of s.viaStationIds.entries()) ref(`${at}.viaStationIds.${k}`, v, placeIds);
      if (s.start >= s.end)
        issues.push({ path: at, problem: 'badSegment', detail: `${s.start}–${s.end}` });
      if (s.kind === 'commute' && (s.fromId === undefined || s.toId === undefined)) {
        issues.push({ path: at, problem: 'badSegment', detail: 'commute には出発と到着が要る' });
      }
      if (previous && previous.end > s.start) {
        issues.push({ path: at, problem: 'overlap', detail: `${previous.end} > ${s.start}` });
      }
      previous = s;
    }
  }
  const seen = new Set<string>();
  for (const [i, day] of household.routines.entries()) {
    const key = `${day.memberId}:${day.weekday}`;
    if (seen.has(key)) issues.push({ path: `routines.${i}`, problem: 'duplicateId', detail: key });
    seen.add(key);
  }

  for (const [i, o] of household.careOptions.entries()) {
    const base = `careOptions.${i}`;
    ref(`${base}.providerId`, o.providerId, anyIds);
    for (const [j, s] of [...o.steps, ...o.extraSteps].entries()) {
      ref(`${base}.steps.${j}.placeId`, s.placeId, placeIds);
      ref(`${base}.steps.${j}.external.to`, s.external?.to, anyIds);
      ref(`${base}.steps.${j}.assigneeId`, s.assigneeId, memberIds);
    }
  }
  return issues;
}
