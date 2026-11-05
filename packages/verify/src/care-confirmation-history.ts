// 新しく始めた家庭の日程確認の印を、家庭を書いた事象から独立に照らす。
import type { Household } from '@maniau/core';
import type { History } from './history';
import { sameValue } from './need-proof';
import type { Collector } from './report';

type Day = Household['routines'][number] | Household['routineExceptions'][number];

function recordedDays(household: Household): Map<string, Day> | undefined {
  const adults = new Set(
    household.members.filter((member) => member.kind === 'adult').map((member) => member.id),
  );
  const out = new Map<string, Day>();
  for (const row of household.routines) {
    if (!adults.has(row.memberId)) continue;
    const key = JSON.stringify(['weekly', row.memberId, row.weekday]);
    if (out.has(key)) return undefined;
    out.set(key, row);
  }
  for (const row of household.routineExceptions) {
    if (!adults.has(row.memberId)) continue;
    const key = JSON.stringify(['date', row.memberId, row.date]);
    if (out.has(key)) return undefined;
    out.set(key, row);
  }
  return out;
}

/**
 * confirmDays のある家庭は、新しく書く・直す日程を全日として家族が見た印を必要とする。
 * 古い家庭には後から印を要求しない。印から、書いた人が対象の大人であることや記録の真偽は証明しない。
 */
export function checkCareConfirmationHistory(
  household: Household,
  history: History,
  report: Collector,
): void {
  const snapshots = history.events.filter((event) => event.type === 'householdSet');
  if (!history.complete || snapshots.length === 0) {
    if (household.confirmDays) {
      report.undetermined(
        'care_confirmation_history_unverified',
        household.id,
        '日程の確認履歴を照らせない。',
      );
    }
    return;
  }
  let previous: Household | undefined;
  for (const event of snapshots) {
    const current = event.household;
    if (previous && previous.confirmDays !== current.confirmDays) {
      report.violation(
        'care_confirmation_policy_changed',
        event.id,
        '日程の確認の決まりが途中で変わっている。',
      );
    }
    if (current.confirmDays) {
      const before = previous ? recordedDays(previous) : new Map<string, Day>();
      const after = recordedDays(current);
      if (!before || !after) {
        report.undetermined(
          'care_confirmation_history_unverified',
          event.id,
          '重複した日程を一意に照らせない。',
        );
      } else {
        for (const [key, row] of after) {
          const prior = before.get(key);
          if (!sameValue(prior, row) && row.allDay !== true) {
            report.violation('care_day_not_confirmed', event.id, '新しい日程に全日の確認がない。');
          }
        }
      }
    }
    previous = current;
  }
}
