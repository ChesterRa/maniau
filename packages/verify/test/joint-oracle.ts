// 複数の作業を同時に置く試験用正解。エンジン・検証器を使わず、有限集合を分単位で列挙する。
// この型は製品の API ではない。実家庭の材料・移動・読み取りの網羅は、この試験だけでは確かめられない。

export interface Interval {
  start: number;
  end: number;
}

export interface Placement extends Interval {
  task: string;
  person: string;
  content: string;
  place?: string;
  condition?: string;
  recipient?: string;
  /** 作業の前後の移動と、寄り道で遅れた帰着。候補ごとに変わる場合は別の試験域にする。 */
  travelBefore?: number;
  travelAfter?: number;
  delayedArrival?: number;
}

export interface TrialTask {
  id: string;
  content: string;
  duration: number;
  earliest: number;
  deadline: number;
  people: readonly string[];
  place?: string;
  condition?: string;
  recipient?: string;
  travelBefore?: number;
  travelAfter?: number;
  delayedArrival?: number;
  /** 作業自体を行える時間。人・場所の時間とすべて重なる必要がある。 */
  windows?: readonly Interval[];
  after?: readonly { task: string; wait: number }[];
  when?: { group: string; choice: string };
  /** 既に本人が承諾した物。変更には本人の確認が必要。 */
  locked?: Pick<
    Placement,
    | 'person'
    | 'start'
    | 'end'
    | 'content'
    | 'place'
    | 'condition'
    | 'recipient'
    | 'travelBefore'
    | 'travelAfter'
    | 'delayedArrival'
  >;
}

export interface TrialDomain {
  availability: Readonly<Record<string, readonly Interval[]>>;
  placeAvailability?: Readonly<Record<string, readonly Interval[]>>;
  /** この試験域の全候補が前提とする外の返事。列挙されない未知の事実は発見できない。 */
  assumptions?: Readonly<Record<string, 'confirmed' | 'waiting' | 'unasked' | 'rejected'>>;
  groups?: Readonly<Record<string, readonly string[]>>;
  tasks: readonly TrialTask[];
}

export interface TrialSchedule {
  choices: Readonly<Record<string, string>>;
  placements: readonly Placement[];
}

export interface Enumeration {
  schedules: readonly TrialSchedule[];
  /** 上限で探索を切った場合は false。見つからなくても「無解」とは言えない。 */
  complete: boolean;
}

export type TrialClaim =
  | { kind: 'feasible'; schedule: TrialSchedule; minimumChanges?: boolean }
  | { kind: 'conditional'; schedule: TrialSchedule; requires: readonly string[] }
  | { kind: 'infeasible' }
  | { kind: 'unknown' };

export interface TrialAssessment {
  kind: 'pass' | 'violation' | 'undetermined';
  reasons: readonly string[];
}

function assertDomain(domain: TrialDomain): void {
  const ids = new Set<string>();
  for (const table of [domain.availability, domain.placeAvailability ?? {}]) {
    for (const [id, spans] of Object.entries(table)) {
      if (!id) throw new Error('人・場所の ID が無い');
      for (const span of spans) {
        if (
          !Number.isSafeInteger(span.start) ||
          !Number.isSafeInteger(span.end) ||
          span.end <= span.start
        )
          throw new Error('使える区間が不正');
      }
    }
  }
  for (const [group, choices] of Object.entries(domain.groups ?? {})) {
    if (
      !group ||
      choices.length === 0 ||
      choices.some((choice) => !choice) ||
      new Set(choices).size !== choices.length
    )
      throw new Error('選択肢が不正');
  }
  for (const [id, value] of Object.entries(domain.assumptions ?? {})) {
    if (!id || !['confirmed', 'waiting', 'unasked', 'rejected'].includes(value))
      throw new Error('外の返事の前提が不正');
  }
  for (const task of domain.tasks) {
    if (!task.id || ids.has(task.id)) throw new Error('作業の ID が不正');
    ids.add(task.id);
    if (
      !task.content ||
      !Number.isSafeInteger(task.duration) ||
      task.duration <= 0 ||
      !Number.isSafeInteger(task.earliest) ||
      !Number.isSafeInteger(task.deadline) ||
      task.people.length === 0 ||
      new Set(task.people).size !== task.people.length ||
      task.people.some((person) => domain.availability[person] === undefined) ||
      !Number.isSafeInteger(task.travelBefore ?? 0) ||
      (task.travelBefore ?? 0) < 0 ||
      !Number.isSafeInteger(task.travelAfter ?? 0) ||
      (task.travelAfter ?? 0) < 0 ||
      (task.delayedArrival !== undefined && !Number.isSafeInteger(task.delayedArrival))
    )
      throw new Error('作業の条件が不正');
    if (task.when && !domain.groups?.[task.when.group]?.includes(task.when.choice))
      throw new Error('作業の選択肢が無い');
    if (task.place && !domain.placeAvailability?.[task.place])
      throw new Error('場所の使える区間が無い');
    for (const span of task.windows ?? []) {
      if (
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.end <= span.start
      )
        throw new Error('作業の区間が不正');
    }
    if (
      task.locked &&
      (!task.locked.person ||
        !Number.isSafeInteger(task.locked.start) ||
        !Number.isSafeInteger(task.locked.end) ||
        task.locked.end <= task.locked.start ||
        !Number.isSafeInteger(task.locked.travelBefore ?? 0) ||
        (task.locked.travelBefore ?? 0) < 0 ||
        !Number.isSafeInteger(task.locked.travelAfter ?? 0) ||
        (task.locked.travelAfter ?? 0) < 0 ||
        (task.locked.delayedArrival !== undefined &&
          !Number.isSafeInteger(task.locked.delayedArrival)))
    )
      throw new Error('引き受けの控えが不正');
  }
  for (const task of domain.tasks) {
    for (const earlier of task.after ?? []) {
      if (!ids.has(earlier.task) || !Number.isSafeInteger(earlier.wait) || earlier.wait < 0)
        throw new Error('前の作業か待ち時間が不正');
    }
  }
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
/** 人の占用は、作業本体だけではない。寄り道なら遅れた帰着までを含む。 */
const occupied = (placement: Placement, task: TrialTask | undefined): Interval => ({
  start: placement.start - (task?.travelBefore ?? placement.travelBefore ?? 0),
  end: Math.max(
    placement.end + (task?.travelAfter ?? placement.travelAfter ?? 0),
    task?.delayedArrival ?? placement.delayedArrival ?? placement.end,
  ),
});
const sameTravel = (
  a: Pick<Placement, 'travelBefore' | 'travelAfter' | 'delayedArrival'>,
  b: Pick<Placement, 'travelBefore' | 'travelAfter' | 'delayedArrival'>,
) =>
  (a.travelBefore ?? 0) === (b.travelBefore ?? 0) &&
  (a.travelAfter ?? 0) === (b.travelAfter ?? 0) &&
  a.delayedArrival === b.delayedArrival;
const active = (task: TrialTask, choices: Readonly<Record<string, string>>) =>
  !task.when || choices[task.when.group] === task.when.choice;
/** 隣り合う区間も合わせて、作業の全時間を覆えるか。入力の配列は変更しない。 */
function covered(spans: readonly Interval[] | undefined, interval: Interval): boolean {
  let through = interval.start;
  for (const span of [...(spans ?? [])].sort((a, b) => a.start - b.start)) {
    if (span.end <= through) continue;
    if (span.start > through) break;
    through = span.end;
    if (through >= interval.end) return true;
  }
  return false;
}

/** 指定された一つの候補が守るべき条件。空なら、この小さい型の範囲では条件を満たす。 */
export function checkTrial(domain: TrialDomain, schedule: TrialSchedule): string[] {
  assertDomain(domain);
  const issues = new Set<string>();
  const groups = domain.groups ?? {};
  for (const [group, choices] of Object.entries(groups)) {
    if (!choices.includes(schedule.choices[group] ?? '')) issues.add('choice');
  }
  if (Object.keys(schedule.choices).some((group) => !(group in groups))) issues.add('choice');
  const required = domain.tasks.filter((task) => active(task, schedule.choices));
  if (domain.tasks.some((task) => task.locked && !active(task, schedule.choices)))
    issues.add('locked');
  const byId = new Map<string, Placement>();
  for (const placement of schedule.placements) {
    if (byId.has(placement.task)) issues.add('duplicate');
    byId.set(placement.task, placement);
    if (!required.some((task) => task.id === placement.task)) issues.add('extra');
  }
  for (const task of required) {
    const placement = byId.get(task.id);
    if (!placement) {
      issues.add('missing');
      continue;
    }
    if (!task.people.includes(placement.person)) issues.add('person');
    if (
      !Number.isSafeInteger(placement.start) ||
      !Number.isSafeInteger(placement.end) ||
      placement.end !== placement.start + task.duration
    )
      issues.add('duration');
    if (placement.start < task.earliest || placement.end > task.deadline) issues.add('deadline');
    if (!covered(domain.availability[placement.person], occupied(placement, task)))
      issues.add('availability');
    if (placement.content !== task.content) issues.add('content');
    if (
      placement.place !== task.place ||
      placement.condition !== task.condition ||
      placement.recipient !== task.recipient
    )
      issues.add('content');
    if (!sameTravel(placement, task)) issues.add('travel');
    if (task.windows !== undefined && !covered(task.windows, placement)) issues.add('taskWindow');
    if (task.place && !covered(domain.placeAvailability?.[task.place], placement))
      issues.add('placeAvailability');
    if (
      task.locked &&
      (placement.person !== task.locked.person ||
        placement.start !== task.locked.start ||
        placement.end !== task.locked.end ||
        placement.content !== task.locked.content ||
        placement.place !== task.locked.place ||
        placement.condition !== task.locked.condition ||
        placement.recipient !== task.locked.recipient ||
        !sameTravel(placement, task.locked))
    )
      issues.add('locked');
    for (const earlier of task.after ?? []) {
      const before = byId.get(earlier.task);
      if (!before || before.end + earlier.wait > placement.start) issues.add('precedence');
    }
  }
  for (let i = 0; i < schedule.placements.length; i++) {
    const one = schedule.placements[i];
    if (!one) continue;
    for (const another of schedule.placements.slice(i + 1)) {
      const oneTask = domain.tasks.find((task) => task.id === one.task);
      const otherTask = domain.tasks.find((task) => task.id === another.task);
      if (
        one.person === another.person &&
        overlaps(occupied(one, oneTask), occupied(another, otherTask))
      )
        issues.add('overlap');
    }
  }
  return [...issues];
}

/**
 * 全候補を列挙する。時刻は整数の分、区間は [start, end)。規模を限定し、探索を打ち切った時は
 * complete=false とする。これを実際の多期間の全探索や、読み取りの正しさの証明として扱わない。
 */
export function enumerateTrial(domain: TrialDomain, maxNodes = 100_000): Enumeration {
  assertDomain(domain);
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error('探索上限が不正');
  const groups = Object.entries(domain.groups ?? {});
  const schedules: TrialSchedule[] = [];
  let complete = true;
  let visited = 0;
  const step = () => {
    if (visited >= maxNodes) {
      complete = false;
      return false;
    }
    visited++;
    return true;
  };

  const place = (
    choices: Record<string, string>,
    tasks: readonly TrialTask[],
    placed: Placement[],
  ) => {
    if (!step()) return;
    const task = tasks[placed.length];
    if (!task) {
      const candidate = { choices: { ...choices }, placements: [...placed] };
      if (checkTrial(domain, candidate).length === 0) schedules.push(candidate);
      return;
    }
    for (const person of task.people) {
      for (let start = task.earliest; start + task.duration <= task.deadline; start++) {
        if (!complete) return;
        if (!step()) return;
        const candidate = {
          task: task.id,
          person,
          start,
          end: start + task.duration,
          content: task.content,
          ...(task.place === undefined ? {} : { place: task.place }),
          ...(task.condition === undefined ? {} : { condition: task.condition }),
          ...(task.recipient === undefined ? {} : { recipient: task.recipient }),
          ...(task.travelBefore === undefined ? {} : { travelBefore: task.travelBefore }),
          ...(task.travelAfter === undefined ? {} : { travelAfter: task.travelAfter }),
          ...(task.delayedArrival === undefined ? {} : { delayedArrival: task.delayedArrival }),
        };
        if (
          !covered(domain.availability[person], occupied(candidate, task)) ||
          (task.place && !covered(domain.placeAvailability?.[task.place], candidate)) ||
          (task.windows !== undefined && !covered(task.windows, candidate)) ||
          (task.locked &&
            (person !== task.locked.person ||
              start !== task.locked.start ||
              candidate.end !== task.locked.end ||
              task.content !== task.locked.content ||
              task.place !== task.locked.place ||
              task.condition !== task.locked.condition ||
              task.recipient !== task.locked.recipient ||
              !sameTravel(task, task.locked))) ||
          placed.some(
            (other) =>
              other.person === person &&
              overlaps(
                occupied(
                  other,
                  domain.tasks.find((t) => t.id === other.task),
                ),
                occupied(candidate, task),
              ),
          )
        )
          continue;
        place(choices, tasks, [...placed, candidate]);
      }
    }
  };

  const choose = (index: number, choices: Record<string, string>) => {
    if (!step()) return;
    const group = groups[index];
    if (!group) {
      if (domain.tasks.some((task) => task.locked && !active(task, choices))) return;
      place(
        choices,
        domain.tasks.filter((task) => active(task, choices)),
        [],
      );
      return;
    }
    for (const choice of group[1]) {
      if (!complete) return;
      choose(index + 1, { ...choices, [group[0]]: choice });
    }
  };
  choose(0, {});
  return { schedules, complete };
}

/** 列挙済み候補の中で、以前の配置を変えた作業の数。優先するかは別の方針で決める。 */
export function changesFrom(schedule: TrialSchedule, before: readonly Placement[]): number {
  return before.filter((old) => {
    const now = schedule.placements.find((placement) => placement.task === old.task);
    return (
      !now ||
      now.person !== old.person ||
      now.start !== old.start ||
      now.end !== old.end ||
      now.content !== old.content ||
      now.place !== old.place ||
      now.condition !== old.condition ||
      now.recipient !== old.recipient ||
      !sameTravel(now, old)
    );
  }).length;
}

/**
 * 求解側が明示した主張を有限域で照らす。未完成の列挙でも、反例が一つ見つかればその主張は否定できる。
 * 反例が無いだけでは、列挙を完了していない「無解」「最小」を認めない。
 */
export function assessTrial(
  domain: TrialDomain,
  claim: TrialClaim,
  before: readonly Placement[] = [],
  maxNodes = 100_000,
): TrialAssessment {
  assertDomain(domain);
  if (claim.kind === 'unknown') return { kind: 'undetermined', reasons: ['solver_unknown'] };
  const assumptions = Object.values(domain.assumptions ?? {});
  if (claim.kind === 'conditional') {
    const issues = checkTrial(domain, claim.schedule);
    if (issues.length > 0) return { kind: 'violation', reasons: issues };
    if (assumptions.includes('rejected'))
      return { kind: 'violation', reasons: ['assumption_rejected'] };
    const required = Object.entries(domain.assumptions ?? {})
      .filter(([, state]) => state === 'waiting' || state === 'unasked')
      .map(([id]) => id);
    if (required.some((id) => !claim.requires.includes(id)))
      return { kind: 'violation', reasons: ['condition_missing'] };
    if (claim.requires.some((id) => !(id in (domain.assumptions ?? {}))))
      return { kind: 'violation', reasons: ['condition_unknown'] };
    return { kind: 'pass', reasons: [] };
  }
  if (claim.kind === 'feasible') {
    const issues = checkTrial(domain, claim.schedule);
    if (issues.length > 0) return { kind: 'violation', reasons: issues };
    if (assumptions.includes('rejected'))
      return { kind: 'violation', reasons: ['assumption_rejected'] };
    if (assumptions.includes('waiting'))
      return { kind: 'undetermined', reasons: ['assumption_waiting'] };
    if (assumptions.includes('unasked'))
      return { kind: 'undetermined', reasons: ['assumption_unasked'] };
    if (!claim.minimumChanges) return { kind: 'pass', reasons: [] };
  }
  if (claim.kind === 'infeasible' && assumptions.includes('rejected'))
    return { kind: 'pass', reasons: [] };
  const reference = enumerateTrial(domain, maxNodes);
  if (claim.kind === 'infeasible') {
    if (reference.schedules.length > 0)
      return assumptions.includes('waiting')
        ? { kind: 'undetermined', reasons: ['assumption_waiting'] }
        : assumptions.includes('unasked')
          ? { kind: 'undetermined', reasons: ['assumption_unasked'] }
          : { kind: 'violation', reasons: ['false_infeasible'] };
    return reference.complete
      ? { kind: 'pass', reasons: [] }
      : { kind: 'undetermined', reasons: ['reference_incomplete'] };
  }
  const claimedChanges = changesFrom(claim.schedule, before);
  if (reference.schedules.some((candidate) => changesFrom(candidate, before) < claimedChanges))
    return { kind: 'violation', reasons: ['not_minimum'] };
  return reference.complete
    ? { kind: 'pass', reasons: [] }
    : { kind: 'undetermined', reasons: ['reference_incomplete'] };
}
