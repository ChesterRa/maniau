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

  // ふだんの一日と、その日だけの一日の区間（同じ決まりで確かめる）。
  const days = [
    ...household.routines.map((day, i) => ({ day, base: `routines.${i}` })),
    ...household.routineExceptions.map((day, i) => ({ day, base: `routineExceptions.${i}` })),
  ];
  for (const { day, base } of days) {
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
  // その日だけの一日は、同じ人・同じ日に一つ。
  const dated = new Set<string>();
  for (const [i, day] of household.routineExceptions.entries()) {
    const key = `${day.memberId}:${day.date}`;
    if (dated.has(key)) {
      issues.push({ path: `routineExceptions.${i}`, problem: 'duplicateId', detail: key });
    }
    dated.add(key);
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
  // やり方：ID は一意、手順の参照は実在、受け持てる時間は始まりが終わりより前。
  const wayIds = new Set<string>();
  for (const [i, w] of household.ways.entries()) {
    const base = `ways.${i}`;
    if (wayIds.has(w.id)) issues.push({ path: base, problem: 'duplicateId', detail: w.id });
    wayIds.add(w.id);
    const stepIds = new Set<string>();
    for (const [j, s] of w.steps.entries()) {
      if (stepIds.has(s.id)) {
        issues.push({ path: `${base}.steps.${j}`, problem: 'duplicateId', detail: s.id });
      }
      stepIds.add(s.id);
      ref(`${base}.steps.${j}.placeId`, s.placeId, placeIds);
      ref(`${base}.steps.${j}.external.to`, s.external?.to, anyIds);
      ref(`${base}.steps.${j}.assigneeId`, s.assigneeId, memberIds);
    }
    if (w.covers && w.covers.start >= w.covers.end) {
      issues.push({
        path: `${base}.covers`,
        problem: 'badSegment',
        detail: `${w.covers.start}–${w.covers.end}`,
      });
    }
  }
  return issues;
}

/** 家族に見せる名前の比べ方（全角・半角を NFKC で揃え、前後の空白を除く）。 */
export const shownName = (name: string): string => name.normalize('NFKC').trim();

/**
 * 成員と場所の名前のうち、二つ以上の物が使っている名前（種類をまたいでも数える）。同じ名前の物があると、画面では
 * どれのことか見分けられず、別の人に頼むことがある（その名前の物は、新しく選ばせない。家族が足す・直す時に重ねた
 * かは sameNamePairs で比べる。02-foundation §3.4）。
 */
export function repeatedNames(household: Household): Set<string> {
  const counts = new Map<string, number>();
  for (const name of [
    ...household.members.map((m) => m.name),
    ...household.places.map((p) => p.name),
  ]) {
    const key = shownName(name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

/**
 * 名前の重なる物の組（成員と場所。種類をまたいでも組にする）。一つの組は、二つの物の種類と ID を並べた文字列。
 * 重なっている名前の集まりだけを比べると、前からある重なりの名前へ別の物が入っても（足す・名前を変えて入れる・
 * 一人と入れ替える）変わらないので、家族が足す・直す時は、前に無かった組ができたかで比べる。
 */
export function sameNamePairs(household: Household): Set<string> {
  const byName = new Map<string, [kind: 'member' | 'place', id: string][]>();
  const add = (kind: 'member' | 'place', id: string, name: string): void => {
    const key = shownName(name);
    byName.set(key, [...(byName.get(key) ?? []), [kind, id]]);
  };
  for (const m of household.members) add('member', m.id, m.name);
  for (const p of household.places) add('place', p.id, p.name);
  const pairs = new Set<string>();
  for (const things of byName.values()) {
    // 物ごとに［種類, ID］の JSON にして並べ、二つずつ空白でつなぐ（JSON は自分で閉じるので、つないでも取り違えない）。
    const keys = things.map((thing) => JSON.stringify(thing)).sort();
    for (const [i, a] of keys.entries()) {
      for (const b of keys.slice(i + 1)) pairs.add(`${a} ${b}`);
    }
  }
  return pairs;
}
