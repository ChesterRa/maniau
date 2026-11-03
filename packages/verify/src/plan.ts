import {
  type Arrangement,
  type Basis,
  type CareOptionTemplate,
  type Household,
  japaneseHolidayName,
  type OptionPlan,
  type PlanResult,
  type Task,
} from '@maniau/core';
import { type FactState, historicalItem } from './facts';
import { doneContentMatches, type History, otherAnswerPossible } from './history';
import type { Collector } from './report';
import { dateFromIndex, dateIndex, instantMinute, localMinute, weekday } from './time';

function indexUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  kind: string,
  report: Collector,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) report.violation('duplicate_key', id, `${kind}のキーが重複している。`);
    else result.set(id, item);
  }
  return result;
}

function checkBasis(
  basis: Basis,
  subject: string,
  live: boolean,
  facts: FactState,
  plan: PlanResult,
  report: Collector,
  exempt: boolean,
  missingReferencesUncertain = false,
  historical = false,
): void {
  if (!live || exempt) return;
  if (basis.itemIds.length === 0 && !basis.requirementKey && !basis.arrangementKey) {
    report.undetermined('basis_missing', subject, '生きている物の根拠をたどれない。');
  }
  for (const itemId of basis.itemIds) {
    const resolved = historical ? historicalItem(facts, itemId) : undefined;
    const item = facts.items.get(resolved?.itemId ?? itemId);
    const active = resolved?.active ?? facts.active.get(itemId);
    if (!item || active === undefined) {
      report.undetermined('basis_item_missing', subject, '元の事項を事象から確認できない。');
    } else if (active === false) {
      if (historical && missingReferencesUncertain)
        report.undetermined('item_condition_unknown', subject, '依頼の根拠の一部を確認できない。');
      else
        report.violation(
          'inactive_item_basis',
          subject,
          '適用されない元の事項から導いた物が残っている。',
        );
    } else if (active === 'unknown') {
      report.undetermined(
        'item_condition_unknown',
        subject,
        '元の事項の適用または証拠を確認できない。',
      );
    }
  }
  if (basis.requirementKey) {
    const requirement = plan.requirements.find((entry) => entry.key === basis.requirementKey);
    if (!requirement) {
      if (missingReferencesUncertain)
        report.undetermined('requirement_unverified', subject, '根拠の要件を確認できない。');
      else report.violation('requirement_missing', subject, '根拠の要件がない。');
    } else if (!requirement.live) {
      if (missingReferencesUncertain)
        report.undetermined('requirement_unverified', subject, '根拠の要件が必要か確認できない。');
      else
        report.violation(
          'inactive_requirement_basis',
          subject,
          '不要な要件から導いた物が残っている。',
        );
    }
  }
  if (basis.arrangementKey) {
    const arrangement = plan.arrangements.find((entry) => entry.key === basis.arrangementKey);
    if (!arrangement) {
      if (missingReferencesUncertain)
        report.undetermined('arrangement_unverified', subject, '根拠の手配を確認できない。');
      else report.violation('arrangement_missing', subject, '根拠の手配がない。');
    } else if (!arrangement.live) {
      if (missingReferencesUncertain)
        report.undetermined('arrangement_unverified', subject, '根拠の手配が必要か確認できない。');
      else
        report.violation(
          'inactive_arrangement_basis',
          subject,
          '不要な手配から導いた物が残っている。',
        );
    } else if (
      basis.optionKey &&
      !arrangement.options.some((option) => option.key === basis.optionKey)
    ) {
      report.violation('basis_option_missing', subject, '根拠の案が手配の中にない。');
    }
  } else if (basis.optionKey) {
    report.undetermined(
      'option_arrangement_missing',
      subject,
      '案の属する手配を根拠からたどれない。',
    );
  }
}

function optionDeadline(
  household: Household,
  arrangement: Arrangement,
  template: CareOptionTemplate,
  report: Collector,
): number | undefined {
  const date = localMinute(instantMinute(arrangement.start), household.timeZone).date;
  let day = dateIndex(date);
  const rule = template.deadline;
  if (rule.type === 'daysBefore') day -= rule.days * 24 * 60;
  else if (rule.type === 'weekdayOfPreviousWeek') {
    day -= (weekday(date) - 1 + 7 - (rule.weekday - 1)) * 24 * 60;
  } else {
    if (rule.days > 730) {
      report.undetermined(
        'deadline_range',
        arrangement.key,
        '営業日の締切を確認できる範囲を超える。',
      );
      return undefined;
    }
    let left = rule.days;
    while (left > 0) {
      day -= 24 * 60;
      const candidate = dateFromIndex(day);
      const dayOfWeek = weekday(candidate);
      if (dayOfWeek === 6 || dayOfWeek === 7) continue;
      try {
        if (
          japaneseHolidayName(candidate) !== undefined ||
          household.closedDates.includes(candidate)
        )
          continue;
      } catch {
        report.undetermined(
          'holiday_data_missing',
          arrangement.key,
          '営業日の祝日を確認できない。',
        );
        return undefined;
      }
      left -= 1;
    }
  }
  // 対象の地域は Asia/Tokyo のみであり、この期間に夏時間はない。
  return Date.parse(`${dateFromIndex(day)}T${rule.at}:00+09:00`) / 60_000;
}

function checkStep(task: Task, household: Household, plan: PlanResult, report: Collector): void {
  if (task.commitment === 'done' && task.end && instantMinute(task.end) < instantMinute(plan.now)) {
    if (task.step)
      report.undetermined(
        'historical_step_unverified',
        task.key,
        '完了時の家庭の決まりと今の決まりが同じか分からない。',
      );
    return;
  }
  if (!task.step) {
    if (task.live && task.basis.optionKey && !task.cancels) {
      report.undetermined('step_missing', task.key, '案の作業を家庭の手順と照らせない。');
    }
    return;
  }
  const template = household.careOptions.find((entry) => entry.id === task.step?.templateId);
  if (!template) {
    report.violation('step_template_missing', task.key, '元の取れる手がない。');
    return;
  }
  const matches = [...template.steps, ...template.extraSteps].filter(
    (step) => step.id === task.step?.stepId,
  );
  if (matches.length !== 1 || !matches[0]) {
    report.violation('step_reference_invalid', task.key, '元の手順がない、または一意でない。');
    return;
  }
  const step = matches[0];
  if (
    task.durationMin !== step.durationMin ||
    task.segments.some((segment) => !step.segments.includes(segment))
  ) {
    report.violation(
      'step_constraints_mismatch',
      task.key,
      '所要時間または置いてよい区間が家庭の決まりと違う。',
    );
  }
  if (
    (step.placeId && task.placeId !== step.placeId) ||
    (step.placeKind && task.placeKind !== step.placeKind) ||
    (step.goods && task.goods !== step.goods)
  ) {
    report.violation('step_place_mismatch', task.key, '場所または品物の条件が家庭の決まりと違う。');
  }
  if (
    step.external &&
    (!task.external ||
      task.external.to !== step.external.to ||
      task.external.kind !== step.external.kind)
  ) {
    report.violation('step_external_mismatch', task.key, '外の相手への依頼が家庭の手順と違う。');
  }
  if (step.assigneeId && task.assigneeId !== step.assigneeId) {
    if (task.assigneeId)
      report.violation('step_assignee_mismatch', task.key, '本人が決まった手順の担当が違う。');
    else
      report.undetermined(
        'step_assignee_missing',
        task.key,
        '本人が決まった手順の担当がまだない。',
      );
  }
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  const option = arrangement?.options.find((entry) => entry.key === task.basis.optionKey);
  if (option && option.templateId !== template.id)
    report.violation('step_option_mismatch', task.key, '案と作業の取れる手が違う。');

  const extra = template.extraSteps.find((entry) => entry.id === step.id);
  if (extra && (!arrangement || !task.start || !task.end)) {
    report.undetermined('extra_step_date_unverified', task.key, '追加の準備の日付を確認できない。');
  } else if (extra && arrangement && task.start && task.end) {
    const start = instantMinute(task.start);
    const end = instantMinute(task.end);
    const target =
      dateIndex(localMinute(instantMinute(arrangement.start), household.timeZone).date) +
      extra.dayOffset * 24 * 60;
    const first = dateIndex(localMinute(start, household.timeZone).date);
    const last = dateIndex(localMinute(Math.max(start, end - 1), household.timeZone).date);
    if (first !== target || last !== target)
      report.violation('extra_step_wrong_date', task.key, '追加の準備の日付が家庭の決まりと違う。');
  }

  const stepIndex = template.steps.findIndex((entry) => entry.id === step.id);
  if (stepIndex >= 0 && task.live && task.basis.optionKey && task.basis.arrangementKey) {
    // 案の中の連続した手順について、出力の印に頼らず担当を照らす。
    // 前後の担当が違えば、その先も含めて一つの鎖として未配置にする。
    const chain = template.steps.map((entry) =>
      plan.tasks.find(
        (candidate) =>
          candidate.live &&
          candidate.basis.optionKey === task.basis.optionKey &&
          candidate.basis.arrangementKey === task.basis.arrangementKey &&
          candidate.step?.templateId === template.id &&
          candidate.step.stepId === entry.id,
      ),
    );
    const differentAssignees = chain.some((current, index) => {
      const previous = chain[index - 1];
      return Boolean(
        current?.assigneeId && previous?.assigneeId && current.assigneeId !== previous.assigneeId,
      );
    });
    const completed = chain.some((entry) => entry?.commitment === 'done');
    if (differentAssignees && completed) {
      // 済んだ作業は実際に受け渡された可能性もあるので、違反ではなく未判定とする。
      report.undetermined(
        'step_handoff_unverified',
        task.key,
        '済んだ手順を含む鎖で、別の担当への受け渡しを確かめられない。',
      );
    } else if (differentAssignees) {
      if (!task.handoff)
        report.violation(
          'step_handoff_unmarked',
          task.key,
          '別の担当への受け渡しが必要な手順に、未確認の印がない。',
        );
      if (task.start || task.end || task.atPlaceId)
        report.violation(
          'step_handoff_scheduled',
          task.key,
          '別の担当が続ける手順に、受け渡しの確認なしで時刻または場所が置かれている。',
        );
    }
  }
  if (stepIndex > 0) {
    const previous = template.steps[stepIndex - 1];
    if (previous) {
      const candidates = plan.tasks.filter(
        (entry) =>
          entry.live &&
          entry.basis.optionKey === task.basis.optionKey &&
          entry.step?.templateId === template.id &&
          entry.step.stepId === previous.id,
      );
      if (candidates.length === 0) {
        report.undetermined(
          'step_predecessor_missing',
          task.key,
          '前の手順を計画から確認できない。',
        );
      } else if (candidates.length > 1) {
        report.violation('step_predecessor_duplicate', task.key, '前の手順が複数ある。');
      } else {
        const predecessor = candidates[0];
        const edge = task.after.find((entry) => entry.taskKey === predecessor?.key);
        if (!edge || edge.waitMin < previous.waitAfterMin) {
          report.violation(
            'step_wait_missing',
            task.key,
            '前の手順と必要な待ち時間が含まれていない。',
          );
        }
      }
    }
  }
  const lastStep = template.steps.at(-1);
  if (arrangement && option && lastStep?.id === step.id && task.end) {
    const deadline = optionDeadline(household, arrangement, template, report);
    if (deadline !== undefined && instantMinute(task.end) > deadline) {
      report.violation(
        'template_deadline_missed',
        task.key,
        '家庭の決まりの締切より後に最後の手順が終わる。',
      );
    }
  }
}

function optionStarted(
  option: OptionPlan,
  arrangement: Arrangement,
  plan: PlanResult,
  history: History,
  timeZone: string,
  byDeadline = false,
): boolean {
  if (
    arrangement.chosenOptionKey !== option.key &&
    !arrangement.backupOptionKeys.includes(option.key)
  )
    return false;
  if (!option.decisionDeadline) return false;
  const choice = history.events
    .filter(
      (entry) =>
        entry.type === 'optionChosen' &&
        entry.arrangementKey === arrangement.key &&
        entry.optionKey === option.key,
    )
    .at(-1);
  if (!choice) return false;
  const deadline = instantMinute(option.decisionDeadline);
  const assignments = new Map<string, string>();
  for (const entry of history.events) {
    if (entry.type === 'assignmentProposed') assignments.set(entry.taskKey, entry.assigneeId);
    if (entry.seq < choice.seq) continue;
    let taskKey: string | undefined;
    if (
      entry.type === 'commitmentChanged' &&
      entry.action === 'done' &&
      entry.actorId === entry.assigneeId &&
      (assignments.get(entry.taskKey) ?? entry.assigneeId) === entry.assigneeId
    ) {
      // 今の状態が本人の「済んだ」でないなら、以前の済みを今の進捗にしない（送信による済みは依頼の日で見る）。
      if (
        history.commitments.get(entry.taskKey) !== 'done' ||
        history.requestBasedDone.has(entry.taskKey)
      )
        continue;
      // 用件が今と違う「済んだ」は、今の案の進捗の証拠にしない。作業が見つからず照らせない時も同様。
      if (entry.content) {
        const current = plan.tasks.find((task) => task.key === entry.taskKey);
        if (!current || !doneContentMatches(current, entry.content)) continue;
      }
      taskKey = entry.taskKey;
    } else if (entry.type === 'externalRequestSent') {
      // 訂正で消えた送信は進捗にしない。控えの日が違う依頼も、現在の日を始めた証拠にはならない。
      // 日の控えが無い旧い依頼は、これまでどおり扱う。
      const sent = history.requests.get(entry.requestId);
      if (!sent || sent.seq !== entry.seq) continue;
      const window = sent.snapshot?.window;
      if (
        window &&
        localMinute(instantMinute(window.start), timeZone).date !==
          localMinute(instantMinute(arrangement.start), timeZone).date
      )
        continue;
      taskKey = entry.taskKey;
    }
    if (!taskKey || !option.taskKeys.includes(taskKey)) continue;
    if (!byDeadline) return true;
    // 所要時間は計画の目安であり、実際に同じ時間がかかった証拠ではない。
    if (instantMinute(entry.occurredAt) <= deadline) return true;
  }
  return false;
}

/** expired は計画の申告なので、現在時刻と決め時から求め直す。 */
function isPastDecision(option: OptionPlan, plan: PlanResult): boolean | 'unknown' {
  return option.decisionDeadline === undefined
    ? 'unknown'
    : instantMinute(plan.now) > instantMinute(option.decisionDeadline);
}

export function optionFailure(
  option: OptionPlan,
  arrangement: Arrangement,
  plan: PlanResult,
  history: History,
  timeZone: string,
): { code: 'turnedDown' | 'missedDeadline'; refs: string[] } | undefined {
  const turnedDown = [...history.requests.entries()]
    .filter(([, sent]) => option.taskKeys.includes(sent.taskKey) && sent.state === 'turnedDown')
    .map(([id]) => id);
  if (turnedDown.length) return { code: 'turnedDown', refs: turnedDown };
  if (
    history.complete &&
    isPastDecision(option, plan) === true &&
    !optionStarted(option, arrangement, plan, history, timeZone)
  )
    return { code: 'missedDeadline', refs: [option.key] };
  return undefined;
}

function checkReasons(
  arrangement: Arrangement,
  plan: PlanResult,
  history: History,
  report: Collector,
  timeZone: string,
): void {
  if (arrangement.status !== 'decidable' && arrangement.reasons.length === 0) {
    report.violation('reason_missing', arrangement.key, '判断できない理由がない。');
  }
  if (
    arrangement.status === 'dependsOnReply' &&
    !arrangement.reasons.some((reason) => reason.code === 'awaitingReply')
  ) {
    report.violation(
      'waiting_status_without_reason',
      arrangement.key,
      '返事しだいの手配に、返事待ちの理由がない。',
    );
  }
  if (
    arrangement.status === 'askFirst' &&
    !arrangement.reasons.some((reason) => reason.code === 'askFirst')
  ) {
    report.violation(
      'question_status_without_reason',
      arrangement.key,
      '聞いてから決める手配に、問いの理由がない。',
    );
  }
  for (const reason of arrangement.reasons) {
    if (reason.code === 'awaitingReply') {
      if (
        reason.refs.length === 0 ||
        reason.refs.some(
          (id) =>
            !plan.requests.some(
              (request) => request.requestId === id && request.state === 'awaitingReply',
            ),
        )
      ) {
        report.violation(
          'waiting_reason_invalid',
          arrangement.key,
          '返事待ちの理由が実際の依頼を指していない。',
        );
      }
    } else if (reason.code === 'askFirst') {
      if (
        reason.refs.length === 0 ||
        reason.refs.some((key) => !plan.questions.some((question) => question.key === key))
      ) {
        report.violation(
          'question_reason_invalid',
          arrangement.key,
          '問いの理由が実際の問いを指していない。',
        );
      }
    } else if (reason.code === 'noOptionLeft') {
      const options = arrangement.options;
      if (reason.refs.some((key) => !options.some((option) => option.key === key))) {
        report.violation(
          'reason_option_missing',
          arrangement.key,
          '理由が手配にない案を指している。',
        );
      }
      if (
        options.some(
          (option) =>
            isPastDecision(option, plan) !== true ||
            optionStarted(option, arrangement, plan, history, timeZone),
        )
      ) {
        report.undetermined(
          'no_option_left_unverified',
          arrangement.key,
          '期限以外の条件も含め、使える案がないか確かめられない。',
        );
      }
    } else {
      report.undetermined(
        'reason_not_independently_proved',
        arrangement.key,
        '探索・祝日・入力不足の理由を完全には検証できない。',
      );
    }
  }
  if (arrangement.status === 'infeasible') {
    if (
      arrangement.reasons.some((reason) =>
        ['searchLimit', 'holidayDataMissing', 'inputMissing'].includes(reason.code),
      )
    ) {
      report.violation(
        'infeasible_without_proof',
        arrangement.key,
        '探索の不足や入力不足を、不可能と扱っている。',
      );
    }
    if (
      arrangement.options.some(
        (option) =>
          option.deadlineCertainty === 'undetermined' && isPastDecision(option, plan) !== true,
      )
    ) {
      report.violation(
        'infeasible_with_unknown_option',
        arrangement.key,
        '取れるか未判定の案を残したまま不可能としている。',
      );
    }
    report.undetermined(
      'infeasibility_not_proved',
      arrangement.key,
      'すべての実行可能な案を独立に探索していない。',
    );
  }
}

export function checkPlan(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const requirements = indexUnique(plan.requirements, (entry) => entry.key, '要件', report);
  indexUnique(household.careOptions, (entry) => entry.id, '取れる手', report);
  const arrangements = indexUnique(plan.arrangements, (entry) => entry.key, '手配', report);
  const tasks = indexUnique(plan.tasks, (entry) => entry.key, '作業', report);
  indexUnique(plan.questions, (entry) => entry.key, '問い', report);
  indexUnique(plan.requests, (entry) => entry.requestId, '依頼', report);
  indexUnique(
    plan.arrangements.flatMap((entry) => entry.options),
    (entry) => entry.key,
    '案',
    report,
  );
  for (const requirement of plan.requirements) {
    // 家にあると示す時は、その言明が家族の最後の答えと品物に対応するかを、事象から確かめる。
    // 別の出典の作用・退休・欠落で答えが変わり得る時は、ここでは断定しない。
    if (
      requirement.kind === 'belongings' &&
      requirement.atHome !== undefined &&
      !requirement.atHomeUnknownId
    ) {
      report.undetermined(
        'at_home_answer_unverified',
        requirement.key,
        '持ち物についての答えの識別子が無い。',
      );
    }
    if (
      requirement.kind === 'belongings' &&
      requirement.atHome !== undefined &&
      requirement.atHomeUnknownId
    ) {
      const id = requirement.atHomeUnknownId;
      const possibleOtherAnswer = otherAnswerPossible(history.events, id);
      if (!history.complete || possibleOtherAnswer) {
        report.undetermined(
          'at_home_answer_unverified',
          requirement.key,
          '持ち物についての家族の答えを独立に確かめられない。',
        );
      } else {
        const answer = history.events.findLast(
          (entry) => entry.type === 'answered' && entry.unknownId === id,
        );
        if (
          answer?.type !== 'answered' ||
          answer.value !== requirement.atHome ||
          (answer.about !== undefined && answer.about !== requirement.what)
        )
          report.violation(
            'at_home_answer_mismatch',
            requirement.key,
            '持ち物に示した答えが、最後の答えか、その時の品物と違う。',
          );
      }
    }
    if (requirement.kind === 'belongings' && requirement.bought === true) {
      // 手配が締切後に消えても、安定した要件キーから購入作業の事象をたどる。形が未知なら断定しない。
      const prefix = 'req:belongings:';
      const root = requirement.key.startsWith(prefix) ? requirement.key.slice(prefix.length) : '';
      const taskKey = root ? `task:opt:arr:purchase:${root}:buy:buy` : '';
      if (!history.complete || !taskKey || history.requestBasedDone.has(taskKey)) {
        report.undetermined(
          'belonging_bought_unverified',
          requirement.key,
          '買い終えた事象を独立に確かめられない。',
        );
      } else if (history.commitments.get(taskKey) !== 'done') {
        report.violation(
          'belonging_bought_mismatch',
          requirement.key,
          '購入を済ませた事象がない。',
        );
      } else {
        const content = history.doneContents.get(taskKey);
        if (!content) {
          report.undetermined(
            'belonging_bought_unverified',
            requirement.key,
            '昔の済みには購入した品物の控えが無い。',
          );
        } else if (
          content.titleKey !== 'task.buy' ||
          Object.keys(content.titleParams).length !== 1 ||
          content.titleParams.what !== requirement.what
        ) {
          report.violation(
            'belonging_bought_mismatch',
            requirement.key,
            '済ませた購入の品物と、今の品物が違う。',
          );
        } else {
          const unknownId = `u-atHome:${root}`;
          const answer = history.events.findLast(
            (entry) => entry.type === 'answered' && entry.unknownId === unknownId,
          );
          const doneSeq = history.commitmentSeq.get(taskKey);
          if (
            answer?.type === 'answered' &&
            (answer.value === 'yes' || answer.value === 'no') &&
            (answer.about === undefined || answer.about === requirement.what) &&
            doneSeq !== undefined &&
            answer.seq > doneSeq
          ) {
            const family = history.events.findLast(
              (entry) => entry.type === 'householdSet' && entry.seq <= answer.seq,
            );
            const member =
              family?.type === 'householdSet'
                ? family.household.members.find((entry) => entry.id === answer.actorId)
                : undefined;
            if (
              member?.kind !== 'adult' ||
              !member.active ||
              otherAnswerPossible(history.events, unknownId)
            )
              report.undetermined(
                'belonging_bought_unverified',
                requirement.key,
                '購入の後の答えを独立に確かめられない。',
              );
            else
              report.violation(
                'belonging_bought_mismatch',
                requirement.key,
                '購入の後に持ち物の状態を答え直している。',
              );
          }
        }
      }
    }
    checkBasis(requirement.basis, requirement.key, requirement.live, facts, plan, report, false);
    if (requirement.live && requirement.nature === 'required') {
      if (
        requirement.kind === 'childCare' &&
        !plan.arrangements.some((entry) => entry.live && entry.requirementKey === requirement.key)
      ) {
        report.undetermined(
          'required_arrangement_missing',
          requirement.key,
          '必須の子の居場所を満たす手配を確認できない。',
        );
      }
      if (
        requirement.kind === 'belongings' &&
        requirement.by !== undefined &&
        instantMinute(requirement.by) > instantMinute(plan.now) &&
        !plan.arrangements.some(
          (entry) =>
            entry.kind === 'purchase' && entry.live && entry.requirementKey === requirement.key,
        )
      ) {
        // 家にあると答えた場合も手配は出ない。答えと現在の品物の対応をここでは再生していないため、
        // 手配が無いことだけから読み落としや違反と断定しない。
        report.undetermined(
          'purchase_arrangement_absence_unverified',
          requirement.key,
          '持ち物の手配が無い理由を、家にあるかの答えまで含めて確認できない。',
        );
      }
      for (const id of requirement.basis.itemIds) {
        const item = facts.items.get(id);
        const correction = facts.corrections.get(id);
        if (facts.staleItems.has(id) && requirement.conditional !== true) {
          report.violation(
            'stale_item_unmarked',
            requirement.key,
            '書き直し前の読み取りによる要件を、確かな物としている。',
          );
        }
        // 一つの事項に対応する品物・提出物なら、現在の読み取り（家族の直しを含む）と要件の名前を照らせる。
        // 置き換えで両方とも旧い名前のままになれば、作業と要件の相互比較だけでは気づけない。
        if (
          requirement.basis.itemIds.length === 1 &&
          item &&
          ((requirement.kind === 'belongings' && item.kind === 'belongings') ||
            (requirement.kind === 'submission' && item.kind === 'submission')) &&
          requirement.what !== (item.interpretation.what ?? item.written)
        ) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true)
            report.undetermined(
              'requirement_content_unverified',
              requirement.key,
              '元の事項の適用や読み取りを確かめられず、現在の用件を照らせない。',
            );
          else
            report.violation(
              'requirement_content_mismatch',
              requirement.key,
              '要件の用件が、元の事項の今の用件と違う。',
            );
        }
        if (
          requirement.basis.itemIds.length === 1 &&
          ((requirement.kind === 'childCare' && item?.kind === 'dayChange') ||
            (requirement.kind === 'belongings' && item?.kind === 'belongings')) &&
          requirement.date &&
          item.interpretation.date &&
          requirement.date !== item.interpretation.date
        ) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true)
            report.undetermined(
              'requirement_date_unverified',
              requirement.key,
              '元の事項の適用や読み取りを確かめられず、要件の日を照らせない。',
            );
          else
            report.violation(
              'requirement_date_mismatch',
              requirement.key,
              '要件の日が、元の事項の今の日と違う。',
            );
        }
        if (
          requirement.kind === 'belongings' &&
          requirement.date &&
          item?.kind === 'belongings' &&
          item.interpretation.date === undefined
        ) {
          report.undetermined(
            'requirement_date_unverified',
            requirement.key,
            '持ち物を使う日が元の事項に明記されていない。',
          );
        }
        if (
          requirement.kind === 'belongings' &&
          item?.kind === 'belongings' &&
          correction?.what &&
          requirement.what !== correction.what
        ) {
          if (facts.staleItems.has(id)) {
            report.undetermined(
              'corrected_requirement_stale',
              requirement.key,
              '書き直し前の訂正と現在の要件を照らせない。',
            );
          } else {
            report.violation(
              'corrected_requirement_mismatch',
              requirement.key,
              '家族が直した品名と要件が違う。',
            );
          }
        }
        if (item && (item.evidence === 'inferred' || item.evidence === 'conflicting')) {
          report.violation(
            'unconfirmed_required_item',
            requirement.key,
            '未確認の推定・食い違いから必須の要件を作っている。',
          );
        }
      }
    }
  }
  for (const arrangement of plan.arrangements) {
    const requirement = requirements.get(arrangement.requirementKey);
    if (!requirement)
      report.violation('arrangement_requirement_missing', arrangement.key, '手配の要件がない。');
    else if (arrangement.live && !requirement.live)
      report.violation(
        'arrangement_requirement_inactive',
        arrangement.key,
        '不要な要件から手配が残っている。',
      );
    if (!arrangement.live) continue;
    if (arrangement.kind === 'purchase') {
      const requirementUnknown =
        requirement?.kind === 'belongings' ? requirement.atHomeUnknownId : undefined;
      if (
        arrangement.atHomeUnknownId !== undefined &&
        requirementUnknown !== undefined &&
        arrangement.atHomeUnknownId !== requirementUnknown
      ) {
        report.violation(
          'purchase_unknown_mismatch',
          arrangement.key,
          '買い物の手配と要件が別の「家にあるか」を指している。',
        );
      }
      if (arrangement.status === 'askFirst') {
        const expectedUnknown = arrangement.atHomeUnknownId ?? requirementUnknown;
        if (arrangement.atHomeUnknownId === undefined || requirementUnknown === undefined) {
          report.undetermined(
            'purchase_unknown_unverified',
            arrangement.key,
            '買い物の手配と要件の「家にあるか」を照らせない。',
          );
        }
        for (const reason of arrangement.reasons.filter((entry) => entry.code === 'askFirst')) {
          for (const ref of reason.refs) {
            const question = plan.questions.find((entry) => entry.key === ref);
            if (!question) continue; // 問いの不在は checkReasons が検出する。
            if (expectedUnknown !== undefined && question.unknownId !== expectedUnknown) {
              report.violation(
                'purchase_question_unknown_mismatch',
                question.key,
                '買い物の問いが、別の「家にあるか」を指している。',
              );
            }
            if (!question.affects.includes(arrangement.key)) {
              report.violation(
                'purchase_question_target_mismatch',
                question.key,
                '買い物の問いが、その手配に影響すると記されていない。',
              );
            }
          }
        }
      }
    }
    if (
      arrangement.kind === 'childCare' &&
      requirement?.kind === 'childCare' &&
      requirement.date &&
      localMinute(instantMinute(arrangement.start), household.timeZone).date !== requirement.date
    )
      report.violation(
        'arrangement_requirement_date_mismatch',
        arrangement.key,
        '子の居場所の手配の日が、要件の日と違う。',
      );
    if (instantMinute(arrangement.end) < instantMinute(arrangement.start)) {
      report.violation('arrangement_time_invalid', arrangement.key, '手配の終わりが始まりより前。');
    }
    checkReasons(arrangement, plan, history, report, household.timeZone);
    for (const option of arrangement.options) {
      if (option.arrangementKey !== arrangement.key)
        report.violation('option_arrangement_mismatch', option.key, '案が別の手配を指している。');
      if (!household.careOptions.some((template) => template.id === option.templateId)) {
        if (arrangement.kind === 'purchase') {
          report.undetermined(
            'purchase_template_unverified',
            option.key,
            '買い物の案を家庭の取れる手の雛形とは照らせない。',
          );
        } else {
          report.violation('option_template_missing', option.key, '案の取れる手がない。');
        }
      }
      if (
        (option.deadlineCertainty === 'undetermined') !==
        (option.decisionDeadline === undefined)
      ) {
        report.violation(
          'decision_deadline_inconsistent',
          option.key,
          '決め時と確かさの状態が一致しない。',
        );
      }
      const past = isPastDecision(option, plan);
      if (past !== 'unknown' && option.expired !== past)
        report.violation('expired_state_mismatch', option.key, '決め時の経過と計画の状態が違う。');
      for (const key of option.taskKeys)
        if (!tasks.has(key))
          report.violation('option_task_missing', option.key, '案が存在しない作業を指している。');
      const template = household.careOptions.find((entry) => entry.id === option.templateId);
      if (template && option.decisionDeadline) {
        const deadline = optionDeadline(household, arrangement, template, report);
        if (deadline !== undefined && instantMinute(option.decisionDeadline) > deadline) {
          report.violation(
            'decision_after_rule_deadline',
            option.key,
            '決め時が家庭の申込期限より後。',
          );
        }
      }
    }
    if (
      new Set(arrangement.backupOptionKeys).size !== arrangement.backupOptionKeys.length ||
      (arrangement.chosenOptionKey &&
        arrangement.backupOptionKeys.includes(arrangement.chosenOptionKey))
    ) {
      report.violation(
        'duplicate_selected_option',
        arrangement.key,
        '本命と予備、または予備同士が重複している。',
      );
    }
    for (const key of [
      arrangement.recommendedOptionKey,
      arrangement.chosenOptionKey,
      ...arrangement.backupOptionKeys,
    ]) {
      if (key && !arrangement.options.some((option) => option.key === key))
        report.violation(
          'selected_option_missing',
          arrangement.key,
          '選択または推薦した案が手配の中にない。',
        );
    }
    const recommended = arrangement.options.find(
      (option) => option.key === arrangement.recommendedOptionKey,
    );
    if (recommended) {
      if (recommended.decisionDeadline) {
        report.undetermined(
          'latest_deadline_unproved',
          recommended.key,
          '決め時が最も遅い時刻かは独立に証明していない。',
        );
      } else {
        report.undetermined(
          'decision_deadline_unknown',
          recommended.key,
          '推薦した案の決め時が分からない。',
        );
      }
      if (
        isPastDecision(recommended, plan) === true &&
        !optionStarted(recommended, arrangement, plan, history, household.timeZone)
      ) {
        if (
          arrangement.chosenOptionKey === recommended.key ||
          arrangement.backupOptionKeys.includes(recommended.key)
        ) {
          report.undetermined(
            'started_option_unknown',
            recommended.key,
            '選択済みの案が期限内に実行され始めたか分からない。',
          );
        } else {
          report.violation(
            'expired_option_recommended',
            recommended.key,
            '決め時を過ぎた未選択の案を推薦している。',
          );
        }
      }
    }
    const selection = history.selections.get(arrangement.key);
    const selectedKeys = history.complete
      ? [selection?.primary, ...(selection?.backups ?? [])].filter(
          (key): key is string => key !== undefined,
        )
      : [arrangement.chosenOptionKey, ...arrangement.backupOptionKeys].filter(
          (key): key is string => key !== undefined,
        );
    const selected = selectedKeys
      .map((key) => arrangement.options.find((option) => option.key === key))
      .filter((option): option is OptionPlan => option !== undefined);
    const failures = new Map(
      selected.map((option) => [
        option.key,
        optionFailure(option, arrangement, plan, history, household.timeZone),
      ]),
    );
    for (const option of selected) {
      if (
        isPastDecision(option, plan) === true &&
        optionStarted(option, arrangement, plan, history, household.timeZone) &&
        !optionStarted(option, arrangement, plan, history, household.timeZone, true)
      )
        report.undetermined(
          'option_start_time_unverified',
          option.key,
          '作業は進んでいるが、決め時までに始めたか確かめられない。',
        );
    }
    if (history.complete) {
      for (const option of selected) {
        const failure = failures.get(option.key);
        if (!failure) continue;
        if (failure.code === 'missedDeadline')
          report.undetermined(
            'option_start_unverified',
            option.key,
            '済んだ・送った記録がなく、作業を始めたか分からない。',
          );
        const reported = arrangement.reasons.some(
          (reason) =>
            reason.code === failure.code && failure.refs.some((ref) => reason.refs.includes(ref)),
        );
        if (!reported && failure.code === 'turnedDown')
          report.violation(
            'rejected_option_unreported',
            option.key,
            '断られた案の理由が示されていない。',
          );
        else if (!reported)
          report.undetermined(
            'missed_deadline_unreported',
            option.key,
            '決め時後も進捗の記録がなく、手配の状態を確認できない。',
          );
      }
    }
    const usable = selected.find((option) => !failures.get(option.key));
    const replacement =
      recommended &&
      !optionFailure(recommended, arrangement, plan, history, household.timeZone) &&
      isPastDecision(recommended, plan) === false
        ? recommended
        : undefined;
    if (
      history.complete &&
      arrangement.status === 'decidable' &&
      selected.length > 0 &&
      !usable &&
      !replacement
    ) {
      if (selected.some((option) => failures.get(option.key)?.code === 'missedDeadline'))
        report.undetermined(
          'failed_option_treated_as_valid',
          arrangement.key,
          '進捗の記録がない案で手配が成立するか分からない。',
        );
      else
        report.violation(
          'failed_option_treated_as_valid',
          arrangement.key,
          '使えなくなった本命・予備の代わりがないまま決めてよいとしている。',
        );
    }
    const subjectOption =
      usable ?? replacement ?? (selected.length === 0 ? recommended : undefined);
    if (
      arrangement.status === 'decidable' &&
      subjectOption &&
      [...history.requests.values()].some(
        (request) =>
          subjectOption.taskKeys.includes(request.taskKey) && request.state === 'awaitingReply',
      )
    ) {
      const priorUnknown = selected
        .slice(0, selected.indexOf(subjectOption))
        .some((option) => failures.get(option.key)?.code === 'missedDeadline');
      if (priorUnknown)
        report.undetermined(
          'decidable_waiting_reply',
          arrangement.key,
          '進捗が不明な本命と返事待ちの予備を確認できない。',
        );
      else
        report.violation(
          'decidable_waiting_reply',
          arrangement.key,
          '外の返事待ちがある案を条件なしで決めてよいとしている。',
        );
    }
  }
  for (const task of plan.tasks) {
    // 買う物・用意して出す物の作業名は、今の要件と同じ物を指す。済んだ時の控えと作業だけが
    // 同じ古い品名であっても、要件と食い違っていれば前の物の済みを当てられない。
    const requirement = task.basis.requirementKey
      ? requirements.get(task.basis.requirementKey)
      : undefined;
    if (
      task.live &&
      requirement?.live &&
      ((task.titleKey === 'task.buy' && requirement.kind === 'belongings') ||
        (task.titleKey === 'task.submit' && requirement.kind === 'submission')) &&
      task.titleParams.what !== requirement.what
    ) {
      report.violation(
        'task_requirement_content_mismatch',
        task.key,
        '作業の用件が、今の要件に書かれた物と違う。',
      );
    }
    if (
      task.live &&
      task.step &&
      requirement?.live &&
      requirement.kind === 'childCare' &&
      requirement.date &&
      task.titleParams.date !== requirement.date
    )
      report.violation(
        'task_requirement_date_mismatch',
        task.key,
        '手配の手順の用件の日が、今の要件の日と違う。',
      );
    checkBasis(
      task.basis,
      task.key,
      task.live,
      facts,
      plan,
      report,
      task.commitment === 'done' || Boolean(task.cancels),
    );
    checkStep(task, household, plan, report);
    if (task.live && !task.cancels && task.basis.optionKey && task.basis.arrangementKey) {
      const arrangement = arrangements.get(task.basis.arrangementKey);
      const active =
        arrangement &&
        (arrangement.chosenOptionKey === task.basis.optionKey ||
          arrangement.backupOptionKeys.includes(task.basis.optionKey));
      if (arrangement && !active && task.commitment === 'accepted') {
        report.undetermined(
          'unselected_option_assignment',
          task.key,
          '以前に選んだ案の引き受けが不要になったか確認できない。',
        );
      }
    }
    for (const dependency of task.after) {
      if (!tasks.has(dependency.taskKey))
        report.violation('dependency_missing', task.key, '先行する作業がない。');
      if (dependency.taskKey === task.key)
        report.violation('dependency_self', task.key, '作業が自分自身を待っている。');
    }
  }
  const marks = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): void => {
    if (marks.get(key) === 'done') return;
    if (marks.get(key) === 'visiting') {
      report.violation('dependency_cycle', key, '作業の先後が循環している。');
      return;
    }
    marks.set(key, 'visiting');
    const task = tasks.get(key);
    if (task?.live)
      for (const dependency of task.after)
        if (tasks.has(dependency.taskKey)) visit(dependency.taskKey);
    marks.set(key, 'done');
  };
  for (const task of plan.tasks) if (task.live) visit(task.key);
  for (const request of plan.requests) {
    const original = history.requests.get(request.requestId)?.snapshot;
    // 根拠の不確かさは計画の needsCheck ではなく、送信時の控えと事象から判定する。
    const originalStates = original?.basis.itemIds.map((id) => historicalItem(facts, id).active);
    const uncertain =
      originalStates !== undefined &&
      (originalStates.some((active) => active === 'unknown') ||
        (originalStates.some((active) => active === false) &&
          originalStates.some((active) => active !== false)));
    checkBasis(
      request.basis,
      request.requestId,
      request.live,
      facts,
      plan,
      report,
      false,
      uncertain,
      original !== undefined,
    );
  }
  for (const question of plan.questions) {
    const owners = plan.requirements.filter(
      (entry) => entry.kind === 'belongings' && entry.atHomeUnknownId === question.unknownId,
    );
    const purchases = plan.arrangements.filter(
      (entry) => entry.kind === 'purchase' && entry.atHomeUnknownId === question.unknownId,
    );
    const ownerInactive =
      owners.length > 0
        ? owners.every((entry) => !entry.live)
        : purchases.length > 0 && purchases.every((entry) => !entry.live);
    if (ownerInactive) {
      report.violation(
        'purchase_question_inactive',
        question.key,
        '不要な持ち物の「家にあるか」を、答える問いとして残している。',
      );
    }
    if (!facts.unknowns.has(question.unknownId)) {
      report.undetermined(
        'question_unknown_not_declared',
        question.key,
        '問いの対象と答えの候補を事象から確認できない。',
      );
    }
    for (const key of question.affects) {
      const affected = arrangements.has(key)
        ? [arrangements.get(key)].filter((entry): entry is Arrangement => Boolean(entry?.live))
        : plan.arrangements.filter((entry) => entry.live && entry.requirementKey === key);
      if (!arrangements.has(key) && !requirements.has(key)) {
        report.violation(
          'question_target_missing',
          question.key,
          '問いが存在しない手配または要件を指している。',
        );
      }
      for (const arrangement of affected) {
        const options = arrangement.options.filter(
          (option) => isPastDecision(option, plan) !== true,
        );
        const expiredBeforeQuestion = options.filter(
          (option) =>
            option.decisionDeadline &&
            instantMinute(question.askBy) > instantMinute(option.decisionDeadline),
        );
        if (options.length === 1 && expiredBeforeQuestion.length === 1) {
          report.violation(
            'question_after_decision',
            question.key,
            '問いの期限が、それで変わる案の決め時より後。',
          );
        } else if (expiredBeforeQuestion.length > 0) {
          report.undetermined(
            'question_option_scope_unknown',
            question.key,
            'どの案が回答で変わるか分からず、問いの期限を確かめられない。',
          );
        }
      }
    }
  }
}
