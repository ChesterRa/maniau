// 決める画面の、案ごとの「選んだら」（docs/plan/02-product.md「G1 の結果」）。案ごとに、画面と同じ選ぶ命令
// （本命に選び、作業を担当に提案する）を書き込まずに展開し、同じ計算で作った後の計画を今と比べる。何も
// 書かない。
import {
  type ChoicePreview,
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type Household,
  type HouseholdPreview,
  type PreviewCommand,
  toEpochMinutes,
} from '@maniau/core';
import { foldEvents, planFromState } from '@maniau/core/engine';
import { previewCommand, previewedInput } from './commands';
import { consequencesOf, householdConsequences, violationsOf } from './consequences';

/**
 * その手配の、選べる案（決め時を過ぎていない物と、今の本命）ごとの「選んだら」。どの案も、画面と同じ命令を
 * 書き込まずに通して見る。手配が無ければ無し。
 *
 * 担当：案に決まった担当があればその人。無ければ自分。自分の時間にもう置けなければ（決め時は、大人の
 * 誰かが間に合う最後なので、自分の分は先に過ぎることがある）、置ける大人にする（その人に作業を提案する）。
 * 誰にも置けなければ自分のまま（時刻の無い作業になることを見せる）。ほかの大人なら自分より後まで間に合う
 * 時は、その人と時刻も添える（later。見せた物の要約には入れない：選ぶ命令の結果ではない）。
 */
export function previewChoices(
  events: readonly DomainEvent[],
  context: { memberId: string; now: DateTime },
  arrangementKey: string,
): ChoicePreview[] | undefined {
  const state = foldEvents(events);
  const household = state.household;
  if (!household) return undefined;
  const now =
    state.clock === undefined ? context.now : formatDateTime(state.clock, household.timeZone);
  const plan = planFromState(state, now);
  const arrangement = plan.arrangements.find(
    (a) => a.key === arrangementKey && a.live && a.kind === 'childCare',
  );
  if (!arrangement) return undefined;
  // 今すでにある違反は除く（選んだから起きる物だけを見せる）。
  const already = new Set(violationsOf(household, events, plan));
  const adults = household.members
    .filter((m) => m.kind === 'adult' && m.active)
    .map((m) => m.id)
    .filter((id) => id !== context.memberId);
  const startOf = (at: DateTime | undefined) =>
    at === undefined ? Number.NEGATIVE_INFINITY : toEpochMinutes(at);
  return arrangement.options.flatMap((option) => {
    // 今の本命も、同じ命令を通して見る（別の大人が選び直せば、担当がその人に替わる）。
    if (option.expired && option.key !== arrangement.chosenOptionKey) return [];
    const template = household.careOptions.find((t) => t.id === option.templateId);
    const fixed = template?.steps[0]?.assigneeId;
    const people = fixed === undefined ? [context.memberId, ...adults] : [fixed];
    const tried = people.flatMap((assigneeId) => {
      const result = previewCommand(
        events,
        { memberId: context.memberId, now },
        {
          type: 'chooseOption',
          arrangementKey,
          optionKey: option.key,
          role: 'primary',
          assigneeId,
        },
        { state, plan },
      );
      if (result.status !== 'ok') return [];
      const own = result.after.tasks.filter(
        (t) =>
          t.live &&
          !t.extra &&
          t.cancels === undefined &&
          t.basis.optionKey === option.key &&
          t.assigneeId === assigneeId,
      );
      const first = own
        .map((t) => t.start)
        .filter((s): s is DateTime => s !== undefined)
        .sort((a, b) => startOf(a) - startOf(b))[0];
      // 済んだ手順は、もう時間を使わない（時刻が無くてよい）。残りの手順が全部置けたかで見る。
      const placed = own.every((t) => t.commitment === 'done' || t.start !== undefined);
      return [{ assigneeId, result, placed, first }];
    });
    const pick = tried.find((t) => t.placed) ?? tried[0];
    if (!pick) return [];
    const shown = consequencesOf(household, events, already, pick.result, {
      arrangementKey,
      optionKey: option.key,
      assigneeId: pick.assigneeId,
    });
    const later = tried
      .filter((t) => t !== pick && t.placed && startOf(t.first) > startOf(pick.first))
      .sort((a, b) => startOf(b.first) - startOf(a.first))[0];
    return [
      later?.first === undefined
        ? shown
        : { ...shown, later: { memberId: later.assigneeId, start: later.first } },
    ];
  });
}

/**
 * 保存の前に見せる「この変更で変わること」（家と暮らしの情報の直し・「すること」の言明・やり方の選び）。書く時と
 * 同じ命令を書き込まずに展開し、同じ計算で比べる（頼み直し reopened も含む）。何も書かない（事象・操作・知らせ・
 * 家の情報）。書けない変更は、書く時と同じ理由で断る。見た物の要約（seen）は、書く時に押さえた中で作り直す物と
 * 同じ作り方（previewedInput）。
 */
export function previewChange(
  events: readonly DomainEvent[],
  context: { memberId: string; now: DateTime },
  command: PreviewCommand,
): HouseholdPreview | { status: 'conflict' | 'forbidden' | 'invalid'; reason: string } {
  const state = foldEvents(events);
  const current = state.household;
  if (!current) return { status: 'invalid', reason: 'householdMissing' };
  const now =
    state.clock === undefined ? context.now : formatDateTime(state.clock, current.timeZone);
  const plan = planFromState(state, now);
  const result = previewCommand(events, { memberId: context.memberId, now }, command, {
    state,
    plan,
  });
  if (result.status !== 'ok') return result;
  const set = result.added.find((e) => e.type === 'householdSet');
  return householdConsequences(
    { household: current, events, plan },
    {
      household: set?.type === 'householdSet' ? set.household : current,
      added: result.added,
      plan: result.after,
    },
    previewedInput(command)?.input,
  );
}

/** 家と暮らしの情報を直したら、計画の何が変わるか（previewChange の updateHousehold）。 */
export function previewHousehold(
  events: readonly DomainEvent[],
  context: { memberId: string; now: DateTime },
  household: Household,
): ReturnType<typeof previewChange> {
  return previewChange(events, context, { type: 'updateHousehold', household });
}
