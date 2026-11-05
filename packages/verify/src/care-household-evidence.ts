// 家族の現在の記録から、その日の見守りの根拠を独立に組む。
// 読み取り事項と履歴の確かさは、この部品の呼出側で照らす。
import { type Household, LocalDate } from '@maniau/core';
import { recordedCareDay } from './care-day-evidence';
import { type CareKnowledge, type CarePersonEvidence, careKnowledge } from './care-knowledge';
import { recordedCareSchedule } from './care-schedule-evidence';
import { routinesOn } from './routine';

/** 重複・不正で根拠が一意でなければ undefined（違反だと決めるのではなく、照らせない）。 */
export function householdCareKnowledge(
  household: Household,
  date: string,
): CareKnowledge | undefined {
  if (!LocalDate.safeParse(date).success) return undefined;
  const adults = household.members.filter((member) => member.kind === 'adult' && member.active);
  const evidence: CarePersonEvidence[] = [];
  for (const adult of adults) {
    const busy = (household.unavailable ?? [])
      .filter((row) => row.memberId === adult.id && row.date === date)
      .map((row) => ({ start: row.start, end: row.end }));
    const answers = (household.dayAnswers ?? []).filter(
      (row) => row.memberId === adult.id && row.date === date,
    );
    if (answers.length > 1) return undefined;
    const answer = answers[0];
    if (answer) {
      const record = recordedCareDay(answer, busy);
      if (!record) return undefined;
      evidence.push(record);
      continue;
    }
    const days = routinesOn(household, adult.id, date);
    if (days.length > 1) return undefined;
    const record = recordedCareSchedule(adult.id, days[0]?.segments ?? [], busy);
    if (!record) return undefined;
    evidence.push(record);
  }
  return careKnowledge(evidence);
}
