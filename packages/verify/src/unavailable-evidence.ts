// 手が離せない時間は、場所とは別に、家庭に明示された記録だけを照らす。
import { DateTime, type Household, LocalDate, type Way } from '@maniau/core';
import { dateIndex, instantMinute, localMinute, timeOfDay } from './time';

export interface RecordedUnavailable {
  id: string;
  memberId: string;
  date: string;
  start: string;
  end: string;
}

export interface CandidateLocalWindow {
  date: string;
  startTime: string;
  endTime: string;
}

export interface AnsweringPerson {
  id: string;
  kind: 'member' | 'guest';
}

export interface CandidateUnavailable {
  personId: string;
  unavailableId: string;
  start: string;
  end: string;
}

interface LocalUnavailable {
  personId: string;
  unavailableId: string;
  start: number;
  end: number;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 互いに違う表示形式でも、同じ瞬間なら家庭の時区で同じ局所分になる。 */
function shownLocal(value: string, timeZone: string): number | undefined {
  if (!DateTime.safeParse(value).success) return undefined;
  try {
    return localMinute(instantMinute(value), timeZone).localIndex;
  } catch {
    return undefined;
  }
}

/**
 * 事象からたどった名簿と候補、家庭の記録を受け取る。重なった占用の ID と元の全区間を比べ、
 * 未記録を空きとは言わない。端が接するだけの場合は重ならない。
 */
export function checkCandidateUnavailable(
  household: Household,
  people: readonly AnsweringPerson[],
  candidate: CandidateLocalWindow,
  recorded: readonly RecordedUnavailable[],
  shown: readonly CandidateUnavailable[] | undefined,
): 'match' | 'mismatch' | 'undetermined' {
  if (
    !LocalDate.safeParse(candidate.date).success ||
    !CLOCK.test(candidate.startTime) ||
    !CLOCK.test(candidate.endTime) ||
    timeOfDay(candidate.startTime) >= timeOfDay(candidate.endTime) ||
    new Set(people.map((person) => person.id)).size !== people.length
  )
    return 'undetermined';
  const day = dateIndex(candidate.date);
  const start = day + timeOfDay(candidate.startTime);
  const end = day + timeOfDay(candidate.endTime);
  const expected: LocalUnavailable[] = [];
  const ids = new Set<string>();
  for (const person of people) {
    if (person.kind !== 'member') continue;
    const members = household.members.filter((member) => member.id === person.id);
    if (members.length !== 1) return 'undetermined';
    // 家庭に登録した頼める人も member として名簿に入る。占用の登録対象ではない。
    if (members[0]?.kind === 'helper') continue;
    if (members[0]?.kind !== 'adult') return 'undetermined';
    const rows = recorded
      .filter((entry) => entry.memberId === person.id && entry.date === candidate.date)
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    for (const row of rows) {
      if (!row.id || ids.has(row.id) || !CLOCK.test(row.start) || !CLOCK.test(row.end))
        return 'undetermined';
      ids.add(row.id);
      const from = day + timeOfDay(row.start);
      const to = day + timeOfDay(row.end);
      if (from >= to) return 'undetermined';
      if (from < end && start < to)
        expected.push({ personId: person.id, unavailableId: row.id, start: from, end: to });
    }
  }
  if (expected.length === 0) return shown === undefined ? 'match' : 'mismatch';
  if (!shown || shown.length !== expected.length) return 'mismatch';
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const got = shown[index];
    if (!want || !got) return 'mismatch';
    const from = shownLocal(got.start, household.timeZone);
    const to = shownLocal(got.end, household.timeZone);
    if (from === undefined || to === undefined) return 'undetermined';
    if (
      got.personId !== want.personId ||
      got.unavailableId !== want.unavailableId ||
      from !== want.start ||
      to !== want.end
    )
      return 'mismatch';
  }
  return 'match';
}

/** 担当が決まった家族の受け持ちに、候補の窓と重なる明示の占用があるか。 */
export function fixedFamilyCoverBusy(
  way: Way,
  candidate: CandidateLocalWindow,
  recorded: readonly RecordedUnavailable[],
): 'blocked' | 'clear' | 'undetermined' {
  if (
    !LocalDate.safeParse(candidate.date).success ||
    !CLOCK.test(candidate.startTime) ||
    !CLOCK.test(candidate.endTime) ||
    timeOfDay(candidate.startTime) >= timeOfDay(candidate.endTime)
  )
    return 'undetermined';
  const from = timeOfDay(candidate.startTime);
  const to = timeOfDay(candidate.endTime);
  let uncertain = false;
  for (const step of way.steps) {
    if (!step.cover || step.external || !step.assigneeId) continue;
    for (const row of recorded) {
      if (row.memberId !== step.assigneeId || row.date !== candidate.date) continue;
      if (!CLOCK.test(row.start) || !CLOCK.test(row.end)) {
        uncertain = true;
        continue;
      }
      const start = timeOfDay(row.start);
      const end = timeOfDay(row.end);
      if (start >= end) {
        uncertain = true;
        continue;
      }
      if (start < to && from < end) return 'blocked';
    }
  }
  return uncertain ? 'undetermined' : 'clear';
}
