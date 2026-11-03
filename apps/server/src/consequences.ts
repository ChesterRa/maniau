// 決める画面の「選んだら」の中身（docs/plan/02-product.md「G1 の結果」）。preview.ts が見せ、commands.ts が
// 選ぶ命令を受ける時に、見せた物と今の同じ計算の結果が同じかを比べる（同じ関数で作り、要約で比べる）。
import {
  type ChoicePreview,
  choicePreview,
  type DomainEvent,
  type Household,
  type PlanResult,
} from '@maniau/core';
import { verifyPlan } from '@maniau/verify';
import { sha256Of } from './digest';

/** 計画を、独立した検証器で確かめた違反（符号と対象）。 */
export function violationsOf(
  household: Household,
  events: readonly DomainEvent[],
  plan: PlanResult,
): string[] {
  return verifyPlan({ household, events, plan })
    .issues.filter((i) => i.kind === 'violation')
    .map((i) => `${i.code} ${i.subject}`);
}

/** 選ぶ命令を書き込まずに展開した結果（今の計画、足すはずの事象、足した後の計画）。 */
export interface Simulated {
  before: PlanResult;
  added: DomainEvent[];
  after: PlanResult;
}

/**
 * 見せる「選んだら」。issues は、今の計画に無かった違反（選んだから起きる物。already は今の違反）。検証器は
 * 事象から選択を読むので、足すはずの事象を足した列で確かめる。seen は見せる物の要約（担当・日・作業・
 * 取り消し・動く作業・重なり・違反）で、選ぶ命令に添えて送り返してもらう。
 */
export function consequencesOf(
  household: Household,
  events: readonly DomainEvent[],
  already: ReadonlySet<string>,
  simulated: Simulated,
  choice: { arrangementKey: string; optionKey: string; assigneeId?: string },
): ChoicePreview {
  const issues = [
    ...new Set(
      violationsOf(household, [...events, ...simulated.added], simulated.after)
        .filter((v) => !already.has(v))
        .map((v) => v.split(' ')[0] ?? v),
    ),
  ];
  const shown: ChoicePreview = {
    ...choicePreview(simulated.before, simulated.after, choice.arrangementKey, choice.optionKey),
    ...(choice.assigneeId === undefined ? {} : { assigneeId: choice.assigneeId }),
    issues,
  };
  return { ...shown, seen: sha256Of(shown).slice(0, 32) };
}
