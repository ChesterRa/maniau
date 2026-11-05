import { DomainEvent, Household, PlanResult, validateHousehold } from '@maniau/core';
import { checkSplitCareClaims } from './child-care-split';
import { collectFacts } from './facts';
import { checkHistory, checkRequestNeed } from './history';
import { checkNeedConfirmation } from './need-confirmation';
import { checkNeedCoverage, checkNeedSelections } from './need-coverage';
import { checkNeedPotentialCoverage } from './need-potential';
import { checkNeedWhen } from './need-when';
import { checkPlan } from './plan';
import { checkPreparations } from './preparations';
import { checkProposals } from './proposal';
import { checkReleased } from './released';
import { Collector, type VerificationReport } from './report';
import { checkExceptionTransitions } from './routine';
import { checkSchedule } from './schedule';
import { checkStorePreferences } from './store-preferences';

export type {
  NotificationMessageVerificationInput,
  NotificationVerificationInput,
} from './notifications';
export { verifyNotificationMessage, verifyNotifications } from './notifications';
export type { VerificationIssue, VerificationReport, VerificationStatus } from './report';

/** JSON を読み直した入力にも使うため、公開の入口では実行時に型を確かめる。 */
export interface VerificationInput {
  household: unknown;
  plan: unknown;
  events: unknown;
}

export function verifyPlan(input: VerificationInput): VerificationReport {
  const report = new Collector();
  const household = Household.safeParse(input.household);
  const plan = PlanResult.safeParse(input.plan);
  if (!household.success)
    report.violation('invalid_household', 'household', '家庭の情報の型が不正。');
  if (!plan.success) report.violation('invalid_plan', 'plan', '計画の型が不正。');
  if (!Array.isArray(input.events))
    report.violation('invalid_events', 'events', '事象の列ではない。');
  if (!household.success || !plan.success || !Array.isArray(input.events)) return report.result();
  if (household.data.id !== plan.data.householdId) {
    report.violation('household_mismatch', 'plan', '計画と家庭の ID が違う。');
    return report.result();
  }
  for (const issue of validateHousehold(household.data)) {
    report.violation(
      `household_${issue.problem}`,
      issue.path,
      '家庭の情報の参照または区間が不正。',
    );
  }
  const events = [];
  for (const [index, value] of input.events.entries()) {
    const event = DomainEvent.safeParse(value);
    if (!event.success) report.violation('invalid_event', `events.${index}`, '事象の型が不正。');
    else if (event.data.householdId !== household.data.id) {
      report.violation(
        'event_household_mismatch',
        `events.${index}`,
        '別の家庭の事象が混じっている。',
      );
    } else events.push(event.data);
  }
  if (report.issues.some((issue) => issue.code === 'event_household_mismatch'))
    return report.result();
  const history = checkHistory(household.data, plan.data, events, report);
  const recordedHousehold = history.events.findLast((event) => event.type === 'householdSet');
  if (!recordedHousehold && history.events.length > 0) {
    report.undetermined(
      'household_history_missing',
      'household',
      '計画時点の家庭の情報を事象から確認できない。',
    );
  } else if (
    recordedHousehold &&
    JSON.stringify(recordedHousehold.household) !== JSON.stringify(household.data)
  ) {
    report.violation(
      'household_snapshot_mismatch',
      'household',
      '計画時点の家庭の情報と検証に渡された情報が違う。',
    );
  }
  const facts = collectFacts(history.events, report);
  const whenWindows = checkNeedWhen(household.data, plan.data, facts, history, report);
  checkExceptionTransitions(household.data, report);
  checkNeedConfirmation(plan.data, facts, history, report);
  checkReleased(household.data, plan.data, facts, history, report);
  checkProposals(plan.data, history, report, household.data, facts);
  checkRequestNeed(plan.data, history, facts, report, household.data.timeZone);
  checkPlan(household.data, plan.data, facts, history, report, whenWindows);
  checkSplitCareClaims(household.data, plan.data, facts, history, report);
  checkPreparations(household.data, plan.data, facts, history, report, whenWindows);
  checkStorePreferences(household.data, plan.data, facts, history, report);
  checkNeedSelections(household.data, plan.data, facts, history, report);
  checkNeedCoverage(household.data, plan.data, facts, history, report, whenWindows);
  checkNeedPotentialCoverage(household.data, plan.data, facts, history, report, whenWindows);
  checkSchedule(household.data, plan.data, history, report);
  if (facts.items.size > 0) {
    report.undetermined(
      'requirement_coverage_unverified',
      'plan',
      '全ての事項から必要な要件が導かれたかは、この検証だけでは分からない。',
    );
  }
  return report.result();
}
