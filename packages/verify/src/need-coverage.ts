// 窓を覆う証拠を、作業と依頼の事象から独立に確かめる。
import type { Household, PlanResult, Way } from '@maniau/core';
import { DateTime } from '@maniau/core';
import { collectFacts, type FactState } from './facts';
import { doneContentMatches, type History, needContent } from './history';
import { aboutMatches, sameValue } from './need-proof';
import { proposalMatches } from './proposal';
import { Collector } from './report';
import { type Interval, instantMinute, localMinute } from './time';

function remaining(window: Interval, covered: readonly Interval[]): Interval[] {
  let gaps = [window];
  for (const interval of covered) {
    gaps = gaps.flatMap((gap) =>
      interval.end <= gap.start || interval.start >= gap.end
        ? [gap]
        : [
            ...(interval.start > gap.start ? [{ start: gap.start, end: interval.start }] : []),
            ...(interval.end < gap.end ? [{ start: interval.end, end: gap.end }] : []),
          ],
    );
  }
  return gaps;
}

function statedGaps(refs: readonly string[]): Interval[] | undefined {
  const gaps: Interval[] = [];
  for (const ref of refs) {
    const pair = ref.split('/');
    if (
      pair.length !== 2 ||
      !DateTime.safeParse(pair[0]).success ||
      !DateTime.safeParse(pair[1]).success
    )
      return undefined;
    const start = instantMinute(pair[0] ?? '');
    const end = instantMinute(pair[1] ?? '');
    if (start >= end) return undefined;
    gaps.push({ start, end });
  }
  return gaps.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 選んだ事象とその時の控えを、今の候補や今の家庭だけから逆算しない。 */
export function checkNeedSelections(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  for (const arrangement of plan.arrangements) {
    if (arrangement.kind !== 'need' || !arrangement.live || arrangement.options.length === 0)
      continue;
    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    const itemId =
      requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
    const current = itemId ? facts.items.get(itemId) : undefined;
    if (!history.complete || !itemId || current?.kind !== 'need' || facts.staleItems.has(itemId)) {
      report.undetermined(
        'need_selection_unverified',
        arrangement.key,
        'やり方の選びと元の事項を確かめられない。',
      );
      continue;
    }
    for (const task of plan.tasks) {
      if (!task.live || task.basis.arrangementKey !== arrangement.key || !task.step) continue;
      const way = household.ways.find((entry) => entry.id === task.step?.templateId);
      if (!way) continue; // 手順の雛形の不在は checkStep で確かめる。
      const binding = aboutMatches(task.about, current, [way]);
      if (binding === false)
        report.violation(
          'need_task_about_mismatch',
          task.key,
          '作業の用件とやり方の控えが今の事実と違う。',
        );
      else if (binding === undefined)
        report.undetermined(
          'need_task_about_unverified',
          task.key,
          '作業の用件とやり方の控えを確かめられない。',
        );
    }
    const choice = history.events.findLast(
      (event) => event.type === 'needWaysSet' && event.itemId === itemId,
    );
    if (choice?.type !== 'needWaysSet') {
      report.violation(
        'need_selection_missing',
        arrangement.key,
        '家族が選んでいないやり方を案にしている。',
      );
      continue;
    }
    if (arrangement.options.some((option) => !choice.wayIds.includes(option.templateId)))
      report.violation(
        'need_option_not_selected',
        arrangement.key,
        '家族が選んでいないやり方を含む。',
      );
    const scratch = new Collector();
    const prior = collectFacts(
      history.events.filter((event) => event.seq < choice.seq),
      scratch,
    );
    const previous = prior.items.get(itemId);
    const priorHousehold = history.events.findLast(
      (event) => event.type === 'householdSet' && event.seq < choice.seq,
    );
    const oldWays =
      priorHousehold?.type === 'householdSet'
        ? choice.wayIds.map((id) => priorHousehold.household.ways.find((way) => way.id === id))
        : [];
    const nowWays = choice.wayIds.map((id) => household.ways.find((way) => way.id === id));
    if (
      scratch.issues.some((issue) => issue.kind === 'violation') ||
      previous?.kind !== 'need' ||
      prior.staleItems.has(itemId) ||
      priorHousehold?.type !== 'householdSet' ||
      oldWays.some((way) => way === undefined) ||
      nowWays.some((way) => way === undefined)
    ) {
      report.undetermined(
        'need_selection_unverified',
        arrangement.key,
        '選んだ時の内容や家庭を確かめられない。',
      );
      continue;
    }
    const binding = aboutMatches(
      choice.about,
      previous,
      oldWays.filter((way): way is Way => way !== undefined),
    );
    if (binding === false) {
      report.violation(
        'need_selection_basis_mismatch',
        arrangement.key,
        '選んだ時の控えがその時の内容と違う。',
      );
    } else if (binding === undefined) {
      report.undetermined(
        'need_selection_unverified',
        arrangement.key,
        '選んだ時の条件を確かめられない。',
      );
    } else if (
      !sameValue(
        needContent(previous, household.timeZone),
        needContent(current, household.timeZone),
      ) ||
      !sameValue(oldWays, nowWays)
    ) {
      report.violation(
        'need_selection_stale',
        arrangement.key,
        'することかやり方が変わった後の古い選びを使っている。',
      );
    }
  }
}

export function checkNeedCoverage(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const priorFacts = new Map<number, FactState>();
  const factsBefore = (seq: number): FactState | undefined => {
    const cached = priorFacts.get(seq);
    if (cached) return cached;
    const scratch = new Collector();
    const prior = collectFacts(
      history.events.filter((event) => event.seq < seq),
      scratch,
    );
    if (scratch.issues.some((issue) => issue.kind === 'violation')) return undefined;
    priorFacts.set(seq, prior);
    return prior;
  };
  for (const arrangement of plan.arrangements) {
    const reported = arrangement.reasons.filter((reason) => reason.code === 'notCovered');
    if (!arrangement.live) continue;
    if (arrangement.kind !== 'need') {
      if (reported.length > 0)
        report.violation(
          'need_coverage_shape_mismatch',
          arrangement.key,
          '窓のすることではない手配に不足時間を出している。',
        );
      continue;
    }
    if (history.needShapes.get(arrangement.key) === 'by') {
      if (reported.length > 0)
        report.violation(
          'need_coverage_shape_mismatch',
          arrangement.key,
          '締切型のすることに受け持ち窓を作っている。',
        );
      continue;
    }
    if (history.needShapes.get(arrangement.key) !== 'window' || !arrangement.inUseOptionKey) {
      if (reported.length > 0)
        report.undetermined(
          'need_coverage_unverified',
          arrangement.key,
          '窓か今使うやり方を確かめられない。',
        );
      continue;
    }
    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    const itemId =
      requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
    const item = itemId ? facts.items.get(itemId) : undefined;
    const option = arrangement.options.find((entry) => entry.key === arrangement.inUseOptionKey);
    const way = household.ways.find((entry) => entry.id === option?.templateId);
    const selection = history.selections.get(arrangement.key);
    if (
      !history.complete ||
      !itemId ||
      !item ||
      !option ||
      !way ||
      (!selection?.primary && !selection?.backups.size)
    ) {
      report.undetermined(
        'need_coverage_unverified',
        arrangement.key,
        '窓の根拠・選び・事象を確かめられない。',
      );
      continue;
    }
    if (selection?.primary !== option.key && !selection?.backups.has(option.key)) {
      report.violation(
        'need_coverage_option_not_selected',
        arrangement.key,
        '家族が選んでいない案を今使う案にしている。',
      );
      continue;
    }
    const whole = { start: instantMinute(arrangement.start), end: instantMinute(arrangement.end) };
    // 一つのやり方にある外への依頼と受け持ちは、全てそろって初めて有効になる。
    const required = way.steps.flatMap((step) => [
      ...(step.cover && !step.external ? [`cover:${step.id}`] : []),
      ...(step.external ? [`external:${step.id}`] : []),
    ]);
    // 前提の承認だけでは、窓を受け持つ人がいない。誰が受け持つかは手順の明示された印から確かめる。
    const hasCover = way.steps.some((step) => step.cover === true);
    const satisfied = new Set<string>();
    const uncertain = new Set<string>();
    for (const task of plan.tasks) {
      if (
        !task.live ||
        !task.cover ||
        task.basis.arrangementKey !== arrangement.key ||
        task.basis.optionKey !== option.key
      )
        continue;
      const step = way.steps.find((entry) => entry.id === task.step?.stepId);
      if (task.step?.templateId !== way.id || !step?.cover) continue;
      const evidence = `cover:${step.id}`;
      if (
        task.commitment === 'proposed' ||
        task.commitment === 'declined' ||
        task.commitment === 'withdrawn' ||
        task.commitment === 'cancelled' ||
        task.reconfirm
      )
        continue;
      if (
        !task.start ||
        !task.end ||
        !task.assigneeId ||
        !household.members.some(
          (member) => member.id === task.assigneeId && member.kind === 'adult' && member.active,
        )
      ) {
        uncertain.add(evidence);
        continue;
      }
      if (history.commitments.get(task.key) !== task.commitment) {
        uncertain.add(evidence);
        continue;
      }
      if (aboutMatches(task.about, item, [way]) !== true) {
        uncertain.add(evidence);
        continue;
      }
      if (task.commitment === 'accepted') {
        const accepted = history.approvals.get(task.key);
        const previous = accepted ? factsBefore(accepted.seq) : undefined;
        const old = previous?.items.get(itemId);
        const priorHousehold =
          accepted &&
          history.events.findLast(
            (event) => event.type === 'householdSet' && event.seq < accepted.seq,
          );
        const oldWay =
          priorHousehold?.type === 'householdSet'
            ? priorHousehold.household.ways.find((entry) => entry.id === way.id)
            : undefined;
        if (
          !accepted?.shown ||
          accepted.assigneeId !== task.assigneeId ||
          proposalMatches(task, accepted.shown) !== true ||
          !old ||
          old.kind !== 'need' ||
          !oldWay ||
          !sameValue(oldWay, way) ||
          !sameValue(needContent(old, household.timeZone), needContent(item, household.timeZone))
        ) {
          uncertain.add(evidence);
          continue;
        }
      } else {
        const done = history.doneContents.get(task.key);
        if (!done || !doneContentMatches(task, done)) {
          uncertain.add(evidence);
          continue;
        }
      }
      if (instantMinute(task.start) === whole.start && instantMinute(task.end) === whole.end)
        satisfied.add(evidence);
    }
    for (const [id, sent] of history.requests) {
      if (
        sent.state !== 'confirmed' ||
        sent.snapshot?.basis.arrangementKey !== arrangement.key ||
        sent.snapshot.basis.optionKey !== option.key
      )
        continue;
      const sentTask = plan.tasks.find((task) => task.key === sent.taskKey);
      const step = way.steps.find((entry) => entry.id === sentTask?.step?.stepId);
      if (!step?.external || sentTask?.step?.templateId !== way.id) continue;
      const evidence = `external:${step.id}`;
      const projected = plan.requests.find((entry) => entry.requestId === id);
      if (!projected) {
        uncertain.add(evidence);
        continue;
      }
      if (!projected.live || projected.needsCheck) continue;
      const requested = sent.snapshot.window;
      if (!requested) {
        uncertain.add(evidence);
        continue;
      }
      if (
        instantMinute(requested.start) !== whole.start ||
        instantMinute(requested.end) !== whole.end
      )
        continue;
      const prior = factsBefore(sent.seq);
      const old = prior?.items.get(itemId);
      const priorHousehold = history.events.findLast(
        (event) => event.type === 'householdSet' && event.seq < sent.seq,
      );
      const oldWay =
        priorHousehold?.type === 'householdSet'
          ? priorHousehold.household.ways.find((entry) => entry.id === way.id)
          : undefined;
      if (
        old?.kind !== 'need' ||
        !oldWay ||
        !sameValue(oldWay, way) ||
        !sameValue(needContent(old, household.timeZone), needContent(item, household.timeZone)) ||
        aboutMatches(sent.snapshot.about, old, [oldWay]) !== true ||
        step.external.to !== sent.snapshot.to ||
        step.external.kind !== sent.snapshot.kind
      ) {
        uncertain.add(evidence);
        continue;
      }
      satisfied.add(evidence);
    }
    const missing = required.filter((key) => !satisfied.has(key));
    const definitelyMissing = missing.some((key) => !uncertain.has(key));
    if (hasCover && missing.length > 0 && !definitelyMissing) {
      report.undetermined(
        'need_coverage_unverified',
        arrangement.key,
        '窓を受け持つ引き受けや返事の内容を確かめられない。',
      );
      continue;
    }
    const covered: Interval[] = [];
    if (hasCover && required.length > 0 && missing.length === 0) {
      if (way.covers) {
        const date = localMinute(whole.start, household.timeZone).date;
        covered.push({
          start: Date.parse(`${date}T${way.covers.start}:00+09:00`) / 60_000,
          end: Date.parse(`${date}T${way.covers.end}:00+09:00`) / 60_000,
        });
      } else covered.push(whole);
    }
    const expected = remaining(whole, covered);
    const reasons = arrangement.reasons.filter((reason) => reason.code === 'notCovered');
    const recorded = statedGaps(reasons.flatMap((reason) => reason.refs));
    if (expected.length === 0 && reasons.length > 0) {
      report.violation(
        'need_coverage_gap_unfounded',
        arrangement.key,
        '覆っている時間を足りないと示している。',
      );
    } else if (expected.length > 0 && (!recorded || !sameValue(recorded, expected))) {
      report.violation(
        'need_coverage_gap_missing',
        arrangement.key,
        '覆えない窓の時間が示されていない。',
      );
    }
  }
}
