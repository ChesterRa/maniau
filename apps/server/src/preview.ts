// 決める画面の、案ごとの「選んだら」（docs/plan/02-product.md「G1 の結果」）。案ごとに、画面と同じ選ぶ命令
// （本命に選び、作業を担当に提案する）を書き込まずに展開し、同じ計算で作った後の計画を今と比べる。何も
// 書かない。
import {
  type ChoicePreview,
  type Command,
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type Household,
  type HouseholdPreview,
  type PreviewCommand,
  toEpochMinutes,
} from '@maniau/core';
import { foldEvents, itemsOf, planFromState } from '@maniau/core/engine';
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
  // 子の居場所の手配と、通用の「すること」の手配（どちらも同じ選ぶ所を使う）。
  const arrangement = plan.arrangements.find(
    (a) => a.key === arrangementKey && a.live && (a.kind === 'childCare' || a.kind === 'need'),
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
    // 決まった担当は、手の最初の手順から（「すること」の案は家庭のやり方、子の居場所の案は取れる手）。
    const template =
      arrangement.kind === 'need'
        ? household.ways.find((w) => w.id === option.templateId)
        : household.careOptions.find((t) => t.id === option.templateId);
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
 * 保存の前に見せる「この変更で変わること」（家と暮らしの情報の直し・「すること」の言明・やり方の選び・「すること」の
 * 直しと外し）。書く時と
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
  // 事項の直しと外しは、「すること」の物だけ見せる（ほかの事項は、今の札の確かめのまま）。モデルが読んだ「すること」
  // は書く時に見せた番号が要るので、今の番号で通す（見るのは今の中身。書く時に番号と要約を確かめる）。
  let asCommand: Command = command;
  if (command.type === 'correctItem' || command.type === 'dismissItem') {
    const item = itemsOf(state).find((i) => i.id === command.itemId);
    if (!item) return { status: 'conflict', reason: 'itemGone' };
    if (item.kind !== 'need') return { status: 'invalid', reason: 'previewNeedOnly' };
    asCommand = { ...command, seen: { throughSeq: state.lastSeq } };
  }
  const result = previewCommand(events, { memberId: context.memberId, now }, asCommand, {
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
