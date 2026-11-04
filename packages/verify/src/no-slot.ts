// 置けないという案の表示を、計画エンジンを使わず家庭に登録された区間と照らす。
import type { CareOptionTemplate, Household, OptionPlan, Way } from '@maniau/core';
import type { Collector } from './report';
import { timeOfDay, weekday } from './time';

export function checkNoSlot(
  household: Household,
  option: OptionPlan,
  way: Way | undefined,
  care: CareOptionTemplate | undefined,
  report: Collector,
): void {
  if (!option.noSlot) return;
  if (option.decisionDeadline !== undefined || option.deadlineCertainty !== 'undetermined') {
    report.violation('no_slot_inconsistent', option.key, '置けない案に確かな決め時がある。');
  }

  // 受け持ちの手順は窓に固定する。前もって行う手順のみ、案の決め時の対象。
  const steps = way ? way.steps.filter((step) => !(step.cover && !step.external)) : care?.steps;
  if (!steps?.length) {
    report.undetermined('no_slot_unverified', option.key, '対象の手順を確かめられない。');
    return;
  }
  const adults = household.members.filter((member) => member.kind === 'adult' && member.active);
  const matches = steps.map((step) => {
    const who =
      step.assigneeId === undefined ? adults.map((member) => member.id) : [step.assigneeId];
    const fits = (segments: Household['routines'][number]['segments']) =>
      segments.some(
        (segment) =>
          step.segments.includes(segment.kind) &&
          (step.placeId === undefined || step.placeId === segment.placeId) &&
          timeOfDay(segment.end) - timeOfDay(segment.start) >= step.durationMin,
      );
    // 二週間に曜日は各二回ある。その曜日を、置けない例外が二回以上覆う可能性があれば、
    // 週の区間が二週間の中に残るとは証明できない。窓の日付をここでは独立に確定しない。
    const guaranteed = household.routines.some((day) => {
      if (!who.includes(day.memberId) || !fits(day.segments)) return false;
      const replaced = household.routineExceptions.filter(
        (entry) =>
          entry.memberId === day.memberId &&
          weekday(entry.date) === day.weekday &&
          !fits(entry.segments),
      );
      return replaced.length < 2;
    });
    if (guaranteed) return 'guaranteed';
    const possible =
      household.routines.some((day) => who.includes(day.memberId) && fits(day.segments)) ||
      household.routineExceptions.some((day) => who.includes(day.memberId) && fits(day.segments));
    return possible ? 'possible' : 'none';
  });
  // 全手順に時刻があり、店などの営業時間も無関係なら、どの手順が済みでも「区間が無い」とは言えない。
  if (
    matches.every((match) => match === 'guaranteed') &&
    steps.every((step) => step.placeId === undefined)
  ) {
    report.violation(
      'no_slot_mismatch',
      option.key,
      'どの手順にも、登録された二週間の区間がある。',
    );
  } else if (matches.some((match) => match !== 'none')) {
    // 前の手順が済んだか、営業時間や休業日がどう効くかは、この比較だけでは分からない。
    report.undetermined('no_slot_unverified', option.key, '置けない手順を独立に確かめきれない。');
  }
}
