// 画面：きょう・決める・頼む・よてい・お知らせ。計画と「きょう」の札はサーバーが作り、ここは見せ方と、
// 命令を送ることだけ（02-foundation §7.1・§7.2）。
import {
  type Arrangement,
  type ChangedRequirement,
  type ChangeSummary,
  type ChoicePreview,
  type Command,
  type ConditionView,
  type ExternalRequest,
  formatDateTime,
  type Household,
  type Item,
  isActiveTask,
  isNeedArrangementKey,
  isValidLocalDate,
  type Member,
  needStep,
  type OptionPlan,
  type PlanResult,
  type PreviewCommand,
  proposalSnapshot,
  type Released,
  type Requirement,
  type ShownFrom,
  type ShownTarget,
  type Source,
  type Task,
  type TodayCard,
  taskContent,
  toEpochMinutes,
  untimed,
  zonedToEpochMinutes,
} from '@maniau/core';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChoiceClock } from './choice-clock';
import {
  type ConfirmResult,
  type Heard,
  type HearResult,
  type HouseholdPreviewResult,
  type ItemWhen,
  type NoticeInput,
  operationId,
  type PhotoResult,
  type PhotoUpload,
  type Reading,
  type ReadResult,
  type SendResult,
  type ShownProposal,
} from './family';
import {
  daysBetween,
  formatDay,
  formatDayTime,
  formatLongDay,
  formatTime,
  hourOf,
  localDate,
  minutesBetween,
} from './format';
import type { UiLanguage } from './i18n';
import { type NotUploadable, toUploadable, type Uploadable } from './photo';
import {
  Button,
  Card,
  Header,
  ICON,
  Icon,
  Label,
  Main,
  MoreLink,
  Pair,
  Quote,
  Row,
  Text,
  Title,
} from './ui';

export type Route =
  | { name: 'today' }
  | { name: 'household' }
  | { name: 'decide'; key: string }
  /** 通用の「すること」の一つ（手配の key）。 */
  | { name: 'need'; key: string }
  /** 家族の言明で「すること」を足す。 */
  | { name: 'stateNeed' }
  /** モデルが読んだ「すること」の読み取りを、家族が直す（事項の ID）。 */
  | { name: 'needFix'; itemId: string }
  | { name: 'ask'; taskKey: string }
  | { name: 'week' }
  | { name: 'sources'; sourceId?: string; highlight?: string[] };

export interface Ctx {
  plan: PlanResult;
  household: Household;
  /** その大人の「きょう」の札（サーバーが作る）。 */
  today: { main: TodayCard[]; quiet: TodayCard[] };
  /** 後から届いたお知らせで変わったこと（二人に同じ物。無ければ出さない）。 */
  changes?: ChangeSummary;
  /** 今の事項。条件しだい・確かめていない物は、確かな予定と見分けて見せる。 */
  items: {
    item: Item;
    live: boolean;
    conditional: boolean;
    trusted: boolean;
    /** 条件しだいの時、一つの値で決まるなら、その条件。 */
    when?: ItemWhen;
    /** 家の人の当番だけ：うちの番か（サーバーのエンジンが決めた物）。 */
    turn?: 'ours' | 'others' | 'unsure';
    /** turn が、家族の言明（「うちの番です」「うちの番ではない」）による。 */
    turnStated?: true;
    /** 習い事・クラブの行事だけ：送り迎えの見立て（誰の送り迎えか、どの方が今回要るか。サーバーのエンジン）。 */
    escort?: {
      childId: string;
      legs: { leg: 'to' | 'from'; needed: boolean; stated?: true }[];
    };
    /** 「すること」だけ：確かめる時に見せる条件の式（答えに依らず、読み取りのまま）。 */
    condition?: ConditionView;
    /** 「すること」だけ：未定の値への答え（どの値に何と。別のお知らせの値なら、そのお知らせ）。 */
    answers?: { unknownId: string; label: string; value: string; from?: ShownFrom }[];
    /** 「すること」だけ：置き換え・取り消しの先（何を・いつ・どのお知らせの）。 */
    targets?: ShownTarget[];
    /**
     * 「すること」だけ：条件・答え・置き換えの先を、見分けられる形で見せられない（確かめ・直しはできない。外すことは
     * できる）。
     */
    unshown?: true;
  }[];
  sources: Map<string, Source>;
  readings: Reading[];
  me: Member;
  lang: UiLanguage;
  tz: string;
  now: string;
  t: TFunction;
  outbound: (lng: string) => TFunction;
  /** 命令を送る。断られた時（内容が変わった等）は、新しい見せる物で見せ直される。 */
  send: (command: Command) => Promise<SendResult>;
  /** お知らせの文を入れて読む（使える時だけ。デモで、読み取りの鍵があるサーバー）。 */
  read?: (input: NoticeInput) => Promise<ReadResult>;
  /** お知らせの写真・PDF を書き起こす（同じく、使える時だけ。何も記録しない）。 */
  transcribe?: (input: PhotoUpload) => Promise<PhotoResult>;
  /** 家族の一言を読む・その候補を記録する（同じく、使える時だけ）。 */
  hear?: (text: string, operationId: string) => Promise<HearResult>;
  confirm?: (proposalId: string, operationId: string) => Promise<ConfirmResult>;
  /** 決める画面の「選んだら」を読む（何も書かない。読めなければ無し）。 */
  preview?: (arrangementKey: string) => Promise<ChoicePreview[] | undefined>;
  /** 家と暮らしの情報の直しの「この変更で変わること」を読む（何も書かない）。直せない直しは理由を返す。 */
  previewHousehold?: (household: Household) => Promise<HouseholdPreviewResult | undefined>;
  /**
   * 「すること」の言明・やり方の選びの「この変更で変わること」を読む（何も書かない。家の情報の直しと同じ見る口）。
   * 書けない変更は理由を返す。
   */
  previewChange?: (command: PreviewCommand) => Promise<HouseholdPreviewResult | undefined>;
  go: (route: Route) => void;
}

export const succeeded = (result: SendResult) => result.status === 'ok' || result.status === 'noop';

// ── 名前と言葉 ──────────────────────────────

export const nameOf = (household: Household, id: string | undefined) =>
  household.members.find((m) => m.id === id)?.name ??
  household.places.find((p) => p.id === id)?.name ??
  '';

/**
 * 手配か依頼の子（成員）。手配・控えに子が無い時は、家の子が一人だけならその子（その子の分しか無い）。
 * ほかには推さない（無ければ undefined：文に名前を書かず、家族に書き足してもらう）。
 */
/**
 * 子の成員。ID の分かる時だけ（控えに子の無い古い依頼で、今の家の子を当てない：今の子が一人でも、頼んだ時の子
 * だという証拠にはならない）。
 */
const childOf = (household: Household, childId: string | undefined): Member | undefined =>
  childId === undefined
    ? undefined
    : household.members.find((m) => m.id === childId && m.kind === 'child');
const childLabel = (ctx: Ctx, childId: string | undefined, t: TFunction = ctx.t) =>
  childOf(ctx.household, childId)?.name ?? t('child.unknown');

function otherAdult(household: Household, me: string): Member | undefined {
  return household.members.find((m) => m.kind === 'adult' && m.active && m.id !== me);
}

/** 画面が見せた作業の担当と状態（古い札の操作で、もう一人の操作を黙って替えないために送る）。 */
const seenOf = (task: Task) => ({
  taskKey: task.key,
  assigneeId: task.assigneeId ?? null,
  commitment: task.commitment,
});

/**
 * 本人しかできない手順の担当（家族の情報の案・やり方の手順で決まっている。例：自分の有休の申請、やり方の
 * 受け持ちの担当）。
 */
function fixedAssignee(household: Household, task: Task): string | undefined {
  const step = task.step;
  if (!step) return undefined;
  // 作業の手配の種類で、取れる手かやり方かを決める（ID が二つの集まりで同じでも、別の型の手順を当てない）。
  const templates = isNeedArrangementKey(task.basis.arrangementKey)
    ? household.ways
    : household.careOptions;
  return templates.find((o) => o.id === step.templateId)?.steps.find((s) => s.id === step.stepId)
    ?.assigneeId;
}

/** 通用の「すること」の作業の、やり方の手順（今の家庭のデータ）。 */
function needStepOf(ctx: Ctx, task: Task) {
  const step = task.step;
  if (!step || !isNeedArrangementKey(task.basis.arrangementKey)) return undefined;
  return ctx.household.ways
    .find((w) => w.id === step.templateId)
    ?.steps.find((s) => s.id === step.stepId);
}

function templateOf(household: Household, option: OptionPlan) {
  return household.careOptions.find((o) => o.id === option.templateId);
}

/** 案の最初の手順に決まった担当（取れる手・家族のやり方の手順で決まっている時）。 */
function firstStepAssignee(household: Household, option: OptionPlan): string | undefined {
  return option.titleKey === 'option.way'
    ? household.ways.find((w) => w.id === option.templateId)?.steps[0]?.assigneeId
    : templateOf(household, option)?.steps[0]?.assigneeId;
}

/** 手配を決める画面（通用の「すること」は「すること」の画面。子の居場所の文の画面で決めさせない）。 */
export const decideRoute = (arrangement: Arrangement): Route =>
  arrangement.kind === 'need'
    ? { name: 'need', key: arrangement.key }
    : { name: 'decide', key: arrangement.key };

function optionParams(ctx: Ctx, option: OptionPlan): Record<string, string> {
  const template = templateOf(ctx.household, option);
  const firstTask = ctx.plan.tasks.find((t) => t.key === option.taskKeys[0]);
  if (option.titleKey === 'option.paidLeave') {
    return { name: nameOf(ctx.household, template?.steps[0]?.assigneeId ?? firstTask?.assigneeId) };
  }
  if (option.titleKey === 'option.askHelper') {
    return { name: nameOf(ctx.household, template?.providerId) };
  }
  // 家族のやり方は、家族が付けた名前で見せる。
  if (option.titleKey === 'option.way') {
    return { name: ctx.household.ways.find((w) => w.id === option.templateId)?.name ?? '' };
  }
  return {};
}

const optionTitle = (ctx: Ctx, option: OptionPlan) =>
  ctx.t(`${option.titleKey}.title`, optionParams(ctx, option));

function optionNote(ctx: Ctx, option: OptionPlan): string {
  const notes: string[] = [];
  if (option.cost.leaveMinutes > 0) {
    notes.push(ctx.t('cost.leave', { count: Math.round(option.cost.leaveMinutes / 480) || 1 }));
  }
  if (option.cost.helperRequests > 0) notes.push(ctx.t('cost.helper'));
  if (option.cost.yen > 0) notes.push(ctx.t('household.ways.yen', { yen: option.cost.yen }));
  const template = templateOf(ctx.household, option);
  if (template?.extraSteps.some((s) => s.titleKey.startsWith('task.bento'))) {
    notes.push(ctx.t('cost.bento'));
  }
  return notes.join(ctx.t('list.separator'));
}

export function taskTitle(ctx: Ctx, task: Task): string {
  const title = baseTitle(ctx, task);
  // 手配の手順は、どの日の分かを題に書く（引き受け・済んだの控えはその日を含む。同じ名前の手順が二つの
  // 日にあっても見分けられ、押す前に分かる）。通用の「すること」の手順は、何のための手順か（家族の言葉の
  // 「何を」）も添える（手順の名前だけでは、どの「すること」の分か分からない）。
  const date = task.titleParams.date;
  const what = isNeedArrangementKey(task.basis.arrangementKey)
    ? ctx.plan.requirements.find((r) => r.key === task.basis.requirementKey)?.what
    : undefined;
  if (date && what) return ctx.t('task.forNeed', { title, date: day(ctx, date), what });
  return date ? ctx.t('task.forDate', { title, date: day(ctx, date) }) : title;
}

function baseTitle(ctx: Ctx, task: Task): string {
  if (task.titleKey === 'task.helper.ask') {
    const option = ctx.plan.arrangements
      .flatMap((a) => a.options)
      .find((o) => o.key === task.basis.optionKey);
    const template = option && templateOf(ctx.household, option);
    return ctx.t('task.helper.ask', { name: nameOf(ctx.household, template?.providerId) });
  }
  if (task.titleKey === 'task.cancelRequest') {
    return ctx.t('task.cancelRequest', { to: nameOf(ctx.household, task.titleParams.to) });
  }
  return ctx.t(task.titleKey, task.titleParams);
}

export const day = (ctx: Ctx, value: string) => formatDay(value, ctx.lang, ctx.tz);
export const dayTime = (ctx: Ctx, value: string) => formatDayTime(value, ctx.lang, ctx.tz);
const time = (ctx: Ctx, value: string) => formatTime(value, ctx.lang, ctx.tz);
export const timeOnly = time;
/**
 * 締切の表示：お知らせや家族が時刻まで書いた締切なら日と時刻、日だけの物（仕組みがその日の朝に置く）は
 * 日だけ（書かれていない時刻を見せない）。
 */
const due = (ctx: Ctx, value: string, itemIds: readonly string[]) =>
  itemIds.some((id) => {
    const interpretation = ctx.items.find((l) => l.item.id === id)?.item.interpretation;
    return interpretation?.deadline !== undefined && interpretation.deadlineDayOnly !== true;
  })
    ? dayTime(ctx, value)
    : day(ctx, value);

/** 送り迎えの作業なら、送り（to）か迎え（from）か。 */
const escortLegOf = (task: Task): 'to' | 'from' | undefined =>
  task.titleKey === 'task.escortTo'
    ? 'to'
    : task.titleKey === 'task.escortFrom'
      ? 'from'
      : undefined;

/**
 * 送り迎えの作業の、行事に書かれた時刻（送りは始まり、迎えは終わり）。エンジンは、書かれた時刻の前後に
 * 同じ長さの往復で置くので、その真ん中。
 */
function escortAt(ctx: Ctx, task: Task): string | undefined {
  const { earliestStart: start, deadline: end } = task;
  if (!start || !end) return undefined;
  return formatDateTime((toEpochMinutes(start) + toEpochMinutes(end)) / 2, ctx.tz);
}

/**
 * 書かれた時刻の決まり（Task.timing。当番、送り迎え、日の書かれていないサイン）の文：書かれた時間・日。
 * 書かれていない終わり・時刻・日は作らず、そう書く。日をまたぐ時は、終わりの日も書く。送り迎えは、置いた
 * 目安の往復ではなく、行事に書かれた始まり・終わりを書く。
 */
function writtenWhen(ctx: Ctx, task: Task): string | undefined {
  const { timing, earliestStart: start, deadline: end } = task;
  if (timing === 'undated') {
    // 日を決められない迎え：行事の日を、迎えの日としてではなく、どの行事かを見分けるために添える。
    const eventDate = task.titleParams.eventDate;
    if (task.timeUnconfirmed && eventDate) {
      return ctx.t('card.escort.dateUnknown', { day: day(ctx, eventDate) });
    }
    return ctx.t(task.timeUnconfirmed ? 'card.timing.undatedUnconfirmed' : 'card.timing.undated');
  }
  if (!start) return undefined;
  const leg = escortLegOf(task);
  const at = leg && timing === 'fixed' ? escortAt(ctx, task) : undefined;
  if (leg && at) {
    return ctx.t(leg === 'to' ? 'card.escort.startsAt' : 'card.escort.endsAt', {
      day: day(ctx, at),
      at: time(ctx, at),
    });
  }
  if (timing === 'day') {
    // 読み取りの始まりを確かめられなかった物は、「書かれていない」と言わない（書き方を読めなかっただけ）。
    return ctx.t(task.timeUnconfirmed ? 'card.timing.dayUnconfirmed' : 'card.timing.day', {
      day: day(ctx, start),
    });
  }
  if (timing === 'fixedEndEstimated') {
    return ctx.t('card.timing.fixedEndEstimated', { day: day(ctx, start), from: time(ctx, start) });
  }
  if (timing !== 'fixed' || !end) return undefined;
  return day(ctx, end) === day(ctx, start)
    ? ctx.t('card.timing.fixed', {
        day: day(ctx, start),
        from: time(ctx, start),
        to: time(ctx, end),
      })
    : ctx.t('card.timing.fixedOvernight', {
        day: day(ctx, start),
        from: time(ctx, start),
        endDay: day(ctx, end),
        to: time(ctx, end),
      });
}

/**
 * 当番の書かれた時間・場所と対象（原文のまま。うちの番か分からない時は、確かめてと添える）。当番には、どれも
 * 「うちの番ではない」を出す（事項を外すと、作業も無くなる。うちの番と読み違えた物も直せる）。置いた作業には、
 * 行き帰りの時間が入っていないことを添える（空いた時間に置いただけで、場所への移動は確かめていない）。
 * 送り迎えは、往復の時間が目安で道のりを確かめていないこと、根拠（家の決まりか、今回の言明か）を書き、
 * 「今回は要らない」を出す。
 */
function WrittenTime({ ctx, task }: { ctx: Ctx; task: Task }) {
  const when = writtenWhen(ctx, task);
  const place = task.titleParams.place;
  const entry = ctx.items.find((l) => task.basis.itemIds.includes(l.item.id));
  const item = entry?.item;
  const leg = escortLegOf(task);
  const escort = leg ? entry?.escort?.legs.find((l) => l.leg === leg) : undefined;
  // どのお知らせの物か（同じ題・同じ時間の当番が二つあっても、札を見分けられる）。
  const title = item && ctx.sources.get(item.sourceId)?.title;
  // 当番は、対象の原文を見せ、どれも「うちの番ではない」で外せる（うちの番の読み違いも、札から直す）。
  const duty = task.titleKey === 'task.duty';
  const audience = duty ? item?.interpretation.audience : undefined;
  const fixed = task.timing === 'fixed' || task.timing === 'fixedEndEstimated';
  if (!when && !place && !audience && !duty) return null;
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
      {when && <span className="font-bold tabular-nums">{when}</span>}
      {place && (
        <span className="text-[15px] text-sub">{ctx.t('card.timing.place', { place })}</span>
      )}
      {fixed && task.start && !leg && (
        <span className="text-[15px] text-sub">{ctx.t('card.timing.noTravel')}</span>
      )}
      {leg && task.timing === 'fixed' && task.earliestStart && task.deadline && (
        <span className="text-[15px] text-sub">
          {ctx.t('card.escort.estimate', {
            from: time(ctx, task.earliestStart),
            to: time(ctx, task.deadline),
          })}
        </span>
      )}
      {escort && (
        <span className="text-[15px]">
          {escort.stated
            ? ctx.t('card.escort.stated')
            : ctx.t('card.escort.rule', { child: nameOf(ctx.household, entry?.escort?.childId) })}
        </span>
      )}
      {leg && escort?.needed && item && (
        <MoreLink
          onClick={() =>
            void ctx.send({
              type: 'stateEscort',
              itemId: item.id,
              leg,
              needed: false,
              seen: { throughSeq: ctx.plan.throughSeq },
            })
          }
        >
          {ctx.t('card.escort.notNeeded')}
        </MoreLink>
      )}
      {audience && (
        <span className="text-[15px]">
          {ctx.t(task.turnUnconfirmed ? 'card.timing.audience' : 'card.timing.audienceKnown', {
            audience,
          })}
        </span>
      )}
      {duty && item && (
        <MoreLink
          onClick={() =>
            void ctx.send({
              type: 'stateTurn',
              itemId: item.id,
              ours: false,
              seen: { throughSeq: ctx.plan.throughSeq },
            })
          }
        >
          {ctx.t('card.timing.notOurs')}
        </MoreLink>
      )}
      {/* 書かれた時間・場所・対象は、元の文で確かめられるようにする（読めない終わりも、原文には書いてある）。 */}
      {item && (
        <MoreLink
          onClick={() =>
            ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
          }
        >
          {title ? ctx.t('card.question.sourceTitled', { title }) : ctx.t('card.question.source')}
        </MoreLink>
      )}
    </div>
  );
}

// ── 外に出す文（頼む・取り消す） ──────────────────────────────

/**
 * 外へ出した（頼んだ・届けを出した）と記録する命令。子の居場所の手配は、画面で見せた頼む時間（手配の区間。
 * 頼む文と同じ）を付ける。
 */
export function sentCommand(ctx: Ctx, task: Task): Command {
  const arrangement = arrangementOf(ctx, task.basis.arrangementKey);
  return {
    type: 'recordSent',
    taskKey: task.key,
    requestId: requestId(),
    ...(arrangement?.kind === 'childCare' ||
    (arrangement?.kind === 'need' && arrangement.needShape === 'window')
      ? { window: { start: arrangement.start, end: arrangement.end } }
      : {}),
  };
}

function helperOf(ctx: Ctx, task: Task): Member | undefined {
  const id = task.external?.to;
  return ctx.household.members.find((m) => m.id === id);
}

/**
 * 人に頼む作業（文を作って LINE などで送る）。学童・会社のような所へ出す物は、済んだと記録するだけ。通用の「すること」の
 * 作業は、相手が窓（か締切まで）を受け持つ手順だけ、通用の文（「すること」の何を・日・時間・場所・だれの分。
 * askDraft）で頼む。前提を聞く手順（「鍵を預けてよいか聞く」など）は、手順の名前から頼む文を作れない（家族の
 * 側から見た言葉で、相手にしてほしい事とは限らない）ので、文を作らず、家族が書いて送ったと記録する。
 */
export const asksPerson = (ctx: Ctx, task: Task) =>
  helperOf(ctx, task) !== undefined &&
  (!isNeedArrangementKey(task.basis.arrangementKey) || needStepOf(ctx, task)?.cover === true);

function arrangementOf(ctx: Ctx, key: string | undefined): Arrangement | undefined {
  return ctx.plan.arrangements.find((a) => a.key === key);
}

/** 条件しだい（条件がまだ分からない）。答えが出た条件は、頼む文に「行う場合」と書かない。 */
function isConditional(arrangement: Arrangement | undefined): boolean {
  return arrangement?.conditional === true;
}

/** 外に出す文の言葉（相手の言葉。分からなければ日本語）。日付も同じ言葉で書く。 */
const outboundLanguage = (helper: Member): UiLanguage =>
  helper.outboundLanguage === 'en' ? 'en' : 'ja';

/**
 * 人に頼む時の返事の期限。ほかの取れる案のうち、決め時が最も早い物（断られた時に移る先）の前の晩。
 * 前の晩が過ぎていれば evening は無い（できるだけ早く。決め時ちょうどは、読んで動く間が無い）。
 * ほかに取れる案が無ければ、期限を作らない。頼む文と、決める画面の勧めで同じ物を使う。
 */
function replyBy(
  ctx: Ctx,
  arrangement: Arrangement,
  optionKey: string | undefined,
): { fallback: OptionPlan; deadline: string; evening?: string } | undefined {
  const [fallback] = arrangement.options
    .filter((o) => o.key !== optionKey && !o.expired && o.decisionDeadline !== undefined)
    .sort(
      (a, b) =>
        toEpochMinutes(a.decisionDeadline as string) - toEpochMinutes(b.decisionDeadline as string),
    );
  const deadline = fallback?.decisionDeadline;
  if (!fallback || deadline === undefined) return undefined;
  const evening = previousEvening(deadline);
  return evening >= localDate(ctx.now, ctx.tz)
    ? { fallback, deadline, evening }
    : { fallback, deadline };
}

export function askDraft(ctx: Ctx, task: Task): string {
  const helper = helperOf(ctx, task);
  const arrangement = arrangementOf(ctx, task.basis.arrangementKey);
  if (!helper || !arrangement) return '';
  const lng = outboundLanguage(helper);
  const t = ctx.outbound(lng);
  const address = helper.addressAs ?? helper.name;
  // 通用の「すること」：家族の言葉の「何を」と、日・時間（窓）か締切だけで書く（場面の言葉を足さない）。締切の
  // 時刻が書かれていれば時刻まで書く（日だけにすると、頼んだ相手がその日の終わりまでと受け取りかねない）。日だけの
  // 締切は日だけ（書かれていない時刻を書かない）。
  if (arrangement.kind === 'need') {
    const what =
      ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey)?.what ?? '';
    const interpretation = needItem(ctx, arrangement)?.interpretation;
    const dayOnly = interpretation?.deadlineDayOnly === true;
    const place = interpretation?.place;
    const forName = interpretation?.forMemberId
      ? nameOf(ctx.household, interpretation.forMemberId)
      : '';
    const parts = [
      arrangement.needShape === 'window'
        ? t('draft.askNeed', {
            address,
            what,
            date: formatLongDay(arrangement.start, lng, ctx.tz),
            from: formatTime(arrangement.start, lng, ctx.tz),
            to: formatTime(arrangement.end, lng, ctx.tz),
          })
        : t(dayOnly ? 'draft.askNeedBy' : 'draft.askNeedByTime', {
            address,
            what,
            date: formatLongDay(arrangement.end, lng, ctx.tz),
            time: formatTime(arrangement.end, lng, ctx.tz),
          }),
    ];
    // 書かれた場所と、だれの分か（家族が選んだ時だけ）。頼む相手が、何を受けるかを取り違えないように。
    if (place) parts.push(t('draft.needPlace', { place }));
    if (forName) parts.push(t('draft.needFor', { name: forName }));
    if (isConditional(arrangement)) parts.push(t('draft.conditionalNeed'));
    const reply = replyBy(ctx, arrangement, task.basis.optionKey);
    if (reply) {
      parts.push(
        reply.evening
          ? t('draft.replyBy', { date: formatLongDay(reply.evening, lng, ctx.tz) })
          : t('draft.replySoon'),
      );
    }
    return parts.join('\n');
  }
  const parts = [
    t('draft.ask', {
      address: helper.addressAs ?? helper.name,
      date: formatLongDay(arrangement.start, lng, ctx.tz),
      from: formatTime(arrangement.start, lng, ctx.tz),
      to: formatTime(arrangement.end, lng, ctx.tz),
      child: childLabel(ctx, arrangement.childId, t),
    }),
  ];
  if (isConditional(arrangement)) parts.push(t('draft.conditional'));
  const reply = replyBy(ctx, arrangement, task.basis.optionKey);
  if (reply) {
    parts.push(
      reply.evening
        ? t('draft.replyBy', { date: formatLongDay(reply.evening, lng, ctx.tz) })
        : t('draft.replySoon'),
    );
  }
  return parts.join('\n');
}

/**
 * 取り消しの文。日付は頼んだ時の控え（request.window）で書く。今の手配の日は、置き換えで替わって
 * いるかもしれず、相手が覚えているのは頼まれた日だから。控えが無ければ日付を書かない（画面で、
 * 日付を確かめるよう添える）。
 */
export function cancelDraft(ctx: Ctx, request: ExternalRequest): string {
  const helper = ctx.household.members.find((m) => m.id === request.to);
  if (isNeedArrangementKey(request.basis.arrangementKey))
    return needCancelDraft(ctx, request, helper);
  const asked = request.window?.start;
  if (helper) {
    const lng = outboundLanguage(helper);
    const t = ctx.outbound(lng);
    const address = helper.addressAs ?? helper.name;
    return asked
      ? t('draft.cancelHelper', { address, date: formatLongDay(asked, lng, ctx.tz) })
      : t('draft.cancelHelperUndated', { address });
  }
  const place = nameOf(ctx.household, request.to);
  // だれの分かは、依頼の控えの子で書く（今の成員から推さない）。分からなければ名前を書かず、札で書き足してもらう。
  const child = childOf(ctx.household, request.childId)?.name;
  const date = asked ? formatLongDay(asked, ctx.lang, ctx.tz) : undefined;
  if (child === undefined)
    return date
      ? ctx.t('draft.cancelPlaceNoChild', { place, date })
      : ctx.t('draft.cancelPlaceUndatedNoChild', { place });
  return date
    ? ctx.t('draft.cancelPlace', { place, child, date })
    : ctx.t('draft.cancelPlaceUndated', { place, child });
}

/**
 * 通用の「すること」の取り消しの文。どのお願いかを、送った時の控えで書く。人へは頼んだ時間か締切と何を、所へは
 * 頼んだ時間か締切だけ（何をは家族の言葉で、子の名前を含みうる。所への文に子の名前を書かない）。今の事項からは
 * 推さない：控えに中身が無ければ、頼んだ時間だけ、それも無ければ日付の無い文にし、札で確かめてもらう
 * （CancelCard）。文だけでは同じ相手の別のお願いと見分けられない時も、札で書き足してもらう（cancelTwin）。
 */
function needCancelDraft(ctx: Ctx, request: ExternalRequest, helper: Member | undefined): string {
  const lng = helper ? outboundLanguage(helper) : ctx.lang;
  const t = helper ? ctx.outbound(lng) : ctx.t;
  const asked = request.askedNeed;
  const window = request.window;
  const when = window
    ? t('draft.whenWindow', {
        date: formatLongDay(window.start, lng, ctx.tz),
        from: formatTime(window.start, lng, ctx.tz),
        to: formatTime(window.end, lng, ctx.tz),
      })
    : asked?.deadline
      ? asked.deadlineDayOnly
        ? t('draft.whenBy', { date: formatLongDay(asked.deadline, lng, ctx.tz) })
        : t('draft.whenByTime', {
            date: formatLongDay(asked.deadline, lng, ctx.tz),
            time: formatTime(asked.deadline, lng, ctx.tz),
          })
      : undefined;
  if (helper) {
    const address = helper.addressAs ?? helper.name;
    if (asked && when) return t('draft.cancelHelperNeed', { address, what: asked.what, when });
    return when
      ? t('draft.cancelHelperNeedWhen', { address, when })
      : t('draft.cancelHelperUndated', { address });
  }
  return when ? t('draft.cancelPlaceNeed', { when }) : t('draft.cancelPlaceNeedUndated');
}

/**
 * 取り消しの文だけでは足りない時に、札に添える言葉（推して埋めず、家族に確かめて書き足してもらう）：頼んだ時の
 * 中身か日が控えに無い、所への子の居場所の取り消しで、だれの分か分からない、文が同じ相手の別の依頼と同じになる。
 */
export function cancelNotes(ctx: Ctx, request: ExternalRequest): string[] {
  const need = isNeedArrangementKey(request.basis.arrangementKey);
  const notes: string[] = [];
  if (need && !request.askedNeed) notes.push('card.cancel.checkContent');
  else if (!request.window && !request.askedNeed?.deadline) notes.push('card.cancel.checkDate');
  const toPlace = !ctx.household.members.some((m) => m.id === request.to);
  if (!need && toPlace && !childOf(ctx.household, request.childId)) {
    notes.push('card.cancel.checkChild');
  }
  if (notes.length === 0 && cancelTwin(ctx, request)) notes.push('card.cancel.checkWhich');
  return notes;
}

/**
 * 取り消しの文が、同じ相手への別の依頼の取り消しの文と同じになる（文だけでは、相手にどのお願いか分からない）。
 * 推して書き足さず、札で家族に書き足してもらう。相手が受けた依頼は、状態を問わず数える（相手はどれも覚えている）。
 */
export function cancelTwin(ctx: Ctx, request: ExternalRequest): boolean {
  const draft = cancelDraft(ctx, request);
  return ctx.plan.requests.some(
    (r) =>
      r.requestId !== request.requestId && r.to === request.to && cancelDraft(ctx, r) === draft,
  );
}

// ── きょう ──────────────────────────────

export function TodayScreen({ ctx }: { ctx: Ctx }) {
  const { main, quiet } = ctx.today;
  // 初めは三つまで見せ、残りは押せば全部出す（隠したままにしない）。
  const [all, setAll] = useState(false);
  const shown = all ? main : main.slice(0, 3);
  const evening = hourOf(ctx.now, ctx.tz) >= 17;
  return (
    <>
      <Header
        eyebrow={formatLongDay(ctx.now, ctx.lang, ctx.tz)}
        title={ctx.t(evening ? 'today.titleEvening' : 'today.title')}
      />
      <Main>
        {ctx.hear && ctx.confirm && <SayCard ctx={ctx} hear={ctx.hear} confirm={ctx.confirm} />}
        {/* 家族が言ったことを、欄で足す（保存の前に、変わることを見る口が要る）。 */}
        {ctx.previewChange && (
          <MoreLink onClick={() => ctx.go({ name: 'stateNeed' })}>
            {ctx.t('today.addNeed')}
          </MoreLink>
        )}
        {ctx.changes && <ChangeCard ctx={ctx} change={ctx.changes} />}
        {shown.length === 0 && !ctx.changes && (
          <Card tone="accent">
            <Title>{ctx.t('today.nothing')}</Title>
            <Text quiet>{ctx.t('today.nothingBody')}</Text>
          </Card>
        )}
        {shown.map((card) => (
          <CardView key={cardKey(card)} ctx={ctx} card={card} />
        ))}
        {main.length > shown.length && (
          <MoreLink onClick={() => setAll(true)}>
            {ctx.t('today.more', { count: main.length - shown.length })}
          </MoreLink>
        )}
        <NeedList ctx={ctx} />
        {quiet.length > 0 && (
          <Card>
            <Label tone="sub">{ctx.t('today.quiet')}</Label>
            <div className="flex flex-col">
              {quiet.map((card, index) => (
                <QuietRow
                  key={cardKey(card)}
                  ctx={ctx}
                  card={card}
                  last={index === quiet.length - 1}
                />
              ))}
            </div>
          </Card>
        )}
      </Main>
    </>
  );
}

/**
 * 後から届いたお知らせで変わったこと。要らなくなった物と日が変わった物を、それで要る取り消し（誰が・
 * 済んだか）と一緒に見せる。二人に同じ物を見せ、自分の分の他に、相手の分も分かるようにする。自分の
 * 取り消しは、下の「もう要らないこと」の札で伝える。
 */
function ChangeCard({ ctx, change }: { ctx: Ctx; change: ChangeSummary }) {
  const source = ctx.sources.get(change.sourceId);
  const who = (id: string) =>
    id === ctx.me.id ? ctx.t('card.change.you') : nameOf(ctx.household, id);
  const undo = (item: ChangedRequirement) =>
    item.undo.map((u) => (
      <li key={u.request.requestId} className="flex justify-between gap-2 pl-3 text-sm">
        <span>
          {ctx.t('card.change.undo', {
            to: nameOf(ctx.household, u.request.to),
            who: who(u.assigneeId),
          })}
        </span>
        <span className={u.done ? 'text-sub' : 'font-bold text-warn'}>
          {ctx.t(u.done ? 'card.change.done' : 'card.change.notYet')}
        </span>
      </li>
    ));
  const gone = (r: Requirement) =>
    r.kind === 'childCare' && r.date
      ? ctx.t('card.change.gone.childCare', { date: day(ctx, r.date), what: r.what })
      : ctx.t('card.change.gone.other', { what: r.what });
  const moved = (item: ChangedRequirement): string[] => {
    const { before, after } = item;
    // 変わった方を見せる（持ち物は、使う日と用意の締切の二つを持つ）。両方が変わったら両方を見せる。ただし
    // 締切が使う日の同じ日に付いて動いただけ（書かれていない締切の見積もり：使う日の朝）なら、日だけを見せる。
    const dateChanged = (before.date ?? '') !== (after?.date ?? '');
    const byChanged =
      before.by !== undefined &&
      after?.by !== undefined &&
      toEpochMinutes(before.by) !== toEpochMinutes(after.by);
    const follows = (r: Requirement | undefined) =>
      r?.date !== undefined && r.by !== undefined && r.by.slice(0, 10) === r.date;
    const lines: string[] = [];
    if (dateChanged || !byChanged) {
      lines.push(
        ctx.t('card.change.moved.date', {
          what: before.what,
          before: before.date ? day(ctx, before.date) : '',
          after: after?.date ? day(ctx, after.date) : '',
        }),
      );
    }
    if (
      before.by &&
      after?.by &&
      byChanged &&
      !(dateChanged && follows(before) && follows(after))
    ) {
      lines.push(
        ctx.t('card.change.moved.by', {
          what: before.what,
          before: due(ctx, before.by, before.basis.itemIds),
          after: due(ctx, after.by, after.basis.itemIds),
        }),
      );
    }
    if (item.ready === undefined) return lines;
    const ready = ctx.t(item.ready ? 'card.change.ready' : 'card.change.notReady');
    return lines.map((line, i) => (i === lines.length - 1 ? `${line}${ready}` : line));
  };
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.change.label')}</Label>
      <Title>{source?.title ?? ctx.t('card.change.untitled')}</Title>
      <Text quiet>{ctx.t('card.change.from', { date: day(ctx, change.receivedAt) })}</Text>
      <ul className="flex flex-col gap-2">
        {change.gone.map((item) => (
          <li key={item.before.key} className="flex flex-col gap-1">
            <span>{gone(item.before)}</span>
            {item.undo.length > 0 && <ul className="flex flex-col gap-1">{undo(item)}</ul>}
          </li>
        ))}
        {change.moved.map((item) => (
          <li key={item.before.key} className="flex flex-col gap-1">
            {moved(item).map((line) => (
              <span key={line}>{line}</span>
            ))}
            {item.undo.length > 0 && <ul className="flex flex-col gap-1">{undo(item)}</ul>}
          </li>
        ))}
      </ul>
      <MoreLink onClick={() => ctx.go({ name: 'sources', sourceId: change.sourceId })}>
        {ctx.t('card.change.source')}
      </MoreLink>
    </Card>
  );
}

function cardKey(card: TodayCard): string {
  switch (card.kind) {
    case 'released':
      return `${card.kind}:${card.released.taskKey}`;
    case 'cancel':
    case 'proposal':
    case 'todo':
    case 'unowned':
      return `${card.kind}:${card.task.key}`;
    case 'backup':
    case 'decide':
    case 'need':
    case 'stuck':
      return `${card.kind}:${card.arrangement.key}`;
    case 'question':
      return `${card.kind}:${card.question.key}`;
    case 'check':
    case 'waiting':
      return `${card.kind}:${card.request.requestId}`;
    case 'bring':
    case 'needCheck':
      return `${card.kind}:${card.requirement.key}`;
  }
}

function CardView({ ctx, card }: { ctx: Ctx; card: TodayCard }) {
  switch (card.kind) {
    case 'released':
      return <ReleasedCard ctx={ctx} released={card.released} />;
    case 'cancel':
      return <CancelCard ctx={ctx} task={card.task} request={card.request} />;
    case 'backup':
      return <BackupCard ctx={ctx} arrangement={card.arrangement} option={card.option} />;
    case 'decide':
      return <DecideCard ctx={ctx} card={card} />;
    case 'proposal':
      return <ProposalCard ctx={ctx} task={card.task} />;
    case 'unowned':
      return <UnownedCard ctx={ctx} task={card.task} arrangement={card.arrangement} />;
    case 'question':
      return card.question.family ? (
        <FamilyQuestionCard ctx={ctx} card={card} />
      ) : (
        <QuestionCard ctx={ctx} card={card} />
      );
    case 'check':
      return <CheckCard ctx={ctx} request={card.request} />;
    case 'stuck':
      return <StuckCard ctx={ctx} card={card} />;
    case 'need':
      return <NeedCard ctx={ctx} card={card} />;
    case 'needCheck':
      return <NeedCheckCard ctx={ctx} card={card} />;
    default:
      return null;
  }
}

/**
 * 引き受けた作業が、もう要らなくなった（後のお知らせの取り消し、条件が外れた等）。本人に、引き受けた時の用件と
 * 置いた時間を見せ（今の作業ではなく約束した物）、「分かりました」で引き受けを取り下げる。控えの無い古い
 * 引き受けは、用件が分からないと書く。
 */
export function releasedTitle(ctx: Ctx, released: Released): string {
  const { content } = released;
  const title = !content
    ? ctx.t('card.released.unknown')
    : content.titleKey === 'task.helper.ask'
      ? // 頼む相手は、もう無い案の物かもしれないので、名前を推さない。
        ctx.t('card.released.ask')
      : content.titleKey === 'task.cancelRequest'
        ? ctx.t('task.cancelRequest', { to: nameOf(ctx.household, content.titleParams.to) })
        : ctx.t(content.titleKey, content.titleParams);
  const date = content?.titleParams.date;
  return date ? ctx.t('task.forDate', { title, date: day(ctx, date) }) : title;
}

function ReleasedCard({ ctx, released }: { ctx: Ctx; released: Released }) {
  const { start, end } = released;
  return (
    <Card>
      <Label tone="warn">
        {ctx.t(
          released.reason === 'unconfirmed' ? 'card.released.checkLabel' : 'card.released.label',
        )}
      </Label>
      <Title>{releasedTitle(ctx, released)}</Title>
      {start && (
        <Text>
          {ctx.t('card.released.when', {
            when: end
              ? ctx.t('card.proposal.when', {
                  day: day(ctx, start),
                  from: time(ctx, start),
                  to: day(ctx, end) === day(ctx, start) ? time(ctx, end) : dayTime(ctx, end),
                })
              : dayTime(ctx, start),
          })}
        </Text>
      )}
      <Text quiet>
        {ctx.t(
          released.reason === 'inactive'
            ? 'card.released.inactive'
            : released.reason === 'unconfirmed'
              ? 'card.released.check'
              : 'card.released.body',
        )}
      </Text>
      <Button
        onClick={() =>
          void ctx.send({
            type: 'acknowledgeReleased',
            taskKey: released.taskKey,
            seen: { throughSeq: ctx.plan.throughSeq },
          })
        }
      >
        {ctx.t('card.released.ok')}
      </Button>
    </Card>
  );
}

/** 送った後に根拠が分からなくなった・替わった依頼。取り消しとも続けるとも決めず、頼んだ本人に確かめてもらう。 */
function CheckCard({ ctx, request }: { ctx: Ctx; request: ExternalRequest }) {
  const arrangement = arrangementOf(ctx, request.basis.arrangementKey);
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.check.label')}</Label>
      <Title>{ctx.t('card.check.title', { to: nameOf(ctx.household, request.to) })}</Title>
      <Text quiet>{ctx.t('card.check.body')}</Text>
      {arrangement && (
        <Button onClick={() => ctx.go(decideRoute(arrangement))}>
          {ctx.t('card.check.action')}
        </Button>
      )}
    </Card>
  );
}

function DecideCard({ ctx, card }: { ctx: Ctx; card: Extract<TodayCard, { kind: 'decide' }> }) {
  const { arrangement, requirement, recommended } = card;
  const turnedDown = arrangement.reasons.some((r) => r.code === 'turnedDown');
  const date = requirement?.date ?? arrangement.start;
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.decide.label')}</Label>
      <Title>
        {ctx.t('card.decide.title', { date: day(ctx, date), what: requirement?.what ?? '' })}
      </Title>
      {turnedDown && <Text>{ctx.t('card.decide.turnedDown')}</Text>}
      <ConditionLine
        ctx={ctx}
        basis={{
          itemIds: requirement?.basis.itemIds ?? [],
          requirementKey: arrangement.requirementKey,
          arrangementKey: arrangement.key,
        }}
      />
      {recommended?.decisionDeadline && (
        <Text>
          {ctx.t('card.decide.body', {
            child: childLabel(ctx, arrangement.childId),
            deadline: dayTime(ctx, recommended.decisionDeadline),
            option: optionTitle(ctx, recommended),
          })}
        </Text>
      )}
      <Button onClick={() => ctx.go({ name: 'decide', key: arrangement.key })}>
        {ctx.t('card.decide.action')}
      </Button>
    </Card>
  );
}

function QuestionCard({ ctx, card }: { ctx: Ctx; card: Extract<TodayCard, { kind: 'question' }> }) {
  const { question, requirement } = card;
  // どのお知らせの物か（元の文へ戻れる。同じ品物を同じ日に求めるお知らせが二つあっても、札を見分けられる）。
  const item =
    requirement && ctx.items.find((l) => requirement.basis.itemIds.includes(l.item.id))?.item;
  const title = item && ctx.sources.get(item.sourceId)?.title;
  // 見せた品物を付ける（直された後の古い札で、別の品物に答えない）。
  const answer = (value: string) =>
    void ctx.send({
      type: 'answer',
      unknownId: question.unknownId,
      value,
      ...(requirement ? { seen: { what: requirement.what, throughSeq: ctx.plan.throughSeq } } : {}),
    });
  return (
    <Card>
      <Label tone="accent">{ctx.t('card.question.label')}</Label>
      <Title>{ctx.t('card.question.atHome', { what: requirement?.what ?? '' })}</Title>
      {/* 条件しだいの持ち物は、確かに要る物として聞かない（その条件を書く。§5.5）。 */}
      {requirement && (
        <ConditionLine
          ctx={ctx}
          basis={{ itemIds: requirement.basis.itemIds, requirementKey: requirement.key }}
        />
      )}
      <Text quiet>
        {ctx.t('card.question.body', {
          by: requirement?.by ? due(ctx, requirement.by, requirement.basis.itemIds) : '',
        })}
      </Text>
      {item && (
        <MoreLink
          onClick={() =>
            ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
          }
        >
          {title ? ctx.t('card.question.sourceTitled', { title }) : ctx.t('card.question.source')}
        </MoreLink>
      )}
      <Row>
        <Button kind="secondary" onClick={() => answer('yes')}>
          {ctx.t('answer.yes')}
        </Button>
        <Button kind="secondary" onClick={() => answer('no')}>
          {ctx.t('answer.no')}
        </Button>
      </Row>
    </Card>
  );
}

/**
 * 家族が決める値の問い（参加するか等）。お知らせの言葉の名前と、値ごとに要る物（期限つき）を並べ、値を
 * 選んでもらう。見せた計画の通し番号を付ける（問いの中身やもう一人の答えが替わった後の古い札では答えない）。
 * yes・no の値は「はい・いいえ」、ほかの値はお知らせの言葉のまま。
 */
function FamilyQuestionCard({
  ctx,
  card,
}: {
  ctx: Ctx;
  card: Extract<TodayCard, { kind: 'question' }>;
}) {
  const { question } = card;
  const family = question.family;
  if (!family) return null;
  const affected = ctx.plan.requirements.filter((r) => question.affects.includes(r.key));
  const itemIds = affected.flatMap((r) => r.basis.itemIds);
  const item = ctx.items.find((l) => itemIds.includes(l.item.id))?.item;
  const title = item && ctx.sources.get(item.sourceId)?.title;
  const valueLabel = (value: string) =>
    value === 'yes' || value === 'no' ? ctx.t(`card.question.family.${value}`) : value;
  const needs = (keys: readonly string[]) =>
    new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(
      affected
        .filter((r) => keys.includes(r.key))
        .map((r) =>
          r.by
            ? ctx.t('card.question.family.needBy', {
                what: r.what,
                by: due(ctx, r.by, r.basis.itemIds),
              })
            : r.what,
        ),
    );
  // 値ごとの行：確かに要る物と、その値でもほかの条件しだいの物を分けて書く。何も無ければ、この答えで要る
  // 作業が無いとだけ言う（同じお知らせのほかの作業は、問いに関わらず出ている）。
  const consequence = (choice: (typeof family.choices)[number]) => {
    const value = valueLabel(choice.value);
    const sure = choice.requirementKeys.filter((k) => !choice.conditionalKeys.includes(k));
    const maybe = choice.conditionalKeys;
    if (sure.length > 0 && maybe.length > 0) {
      return ctx.t('card.question.family.ifBoth', {
        value,
        needs: needs(sure),
        maybe: needs(maybe),
      });
    }
    if (sure.length > 0) return ctx.t('card.question.family.if', { value, needs: needs(sure) });
    if (maybe.length > 0) {
      return ctx.t('card.question.family.ifConditional', { value, maybe: needs(maybe) });
    }
    return ctx.t('card.question.family.ifNothing', { value });
  };
  // 決める期限の書き方（時刻を見せるか）は、その期限を作った要件の物だけで決める（ほかの要件に書かれた
  // 時刻を借りて、日だけの締切に時刻を足さない）。
  const until = question.until;
  const untilItems = affected
    .filter((r) => until && r.by && toEpochMinutes(r.by) === toEpochMinutes(until))
    .flatMap((r) => r.basis.itemIds);
  // 見せた問い（key・until・affects）も付ける（期限が過ぎて消えた・変わった問いの古い札で答えない）。
  const answer = (value: string) =>
    void ctx.send({
      type: 'answer',
      unknownId: question.unknownId,
      value,
      seen: {
        throughSeq: ctx.plan.throughSeq,
        question: {
          key: question.key,
          ...(question.until ? { until: question.until } : {}),
          affects: question.affects,
        },
      },
    });
  return (
    <Card>
      <Label tone="accent">{ctx.t('card.question.family.label')}</Label>
      <Title>{family.label}</Title>
      {family.previous && (
        <Text>
          {ctx.t('card.question.family.previous', { value: valueLabel(family.previous) })}
        </Text>
      )}
      {family.choices.map((choice) => (
        <Text key={choice.value}>{consequence(choice)}</Text>
      ))}
      {until && (
        <Text quiet>{ctx.t('card.question.family.by', { by: due(ctx, until, untilItems) })}</Text>
      )}
      <Text quiet>{ctx.t('card.question.family.hidden')}</Text>
      {item && (
        <MoreLink
          onClick={() =>
            ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
          }
        >
          {title ? ctx.t('card.question.sourceTitled', { title }) : ctx.t('card.question.source')}
        </MoreLink>
      )}
      <Row>
        {family.choices.map((choice) => (
          <Button key={choice.value} kind="secondary" onClick={() => answer(choice.value)}>
            {valueLabel(choice.value)}
          </Button>
        ))}
      </Row>
    </Card>
  );
}

/**
 * 登録した手立てでは間に合う方法が見つからなかった（01-model §8「このままでは無理」）。探した範囲で
 * 見つからなかっただけと書き、ほかの手を家族で考えてもらう。買い物は、ほかの手で用意できたら閉じられる。
 */
export function StuckCard({
  ctx,
  card,
}: {
  ctx: Ctx;
  card: Extract<TodayCard, { kind: 'stuck' }>;
}) {
  const { arrangement, requirement } = card;
  const date = requirement?.by ?? requirement?.date ?? arrangement.end;
  const purchase = arrangement.kind === 'purchase';
  const unknownId = arrangement.atHomeUnknownId;
  // どの店で買えるか分からない品物（間に合わないのではなく、買う時を決められない）。
  const noStore =
    purchase &&
    arrangement.reasons.some((r) => r.code === 'inputMissing' && r.refs.includes('storeKind'));
  return (
    <Card>
      <Label tone="warn">{ctx.t(noStore ? 'card.stuck.noStoreLabel' : 'card.stuck.label')}</Label>
      <Title>
        {purchase
          ? ctx.t('card.stuck.purchaseTitle', { what: requirement?.what ?? '' })
          : ctx.t('card.decide.title', {
              date: day(ctx, requirement?.date ?? arrangement.start),
              what: requirement?.what ?? '',
            })}
      </Title>
      <ConditionLine
        ctx={ctx}
        basis={{
          itemIds: requirement?.basis.itemIds ?? [],
          requirementKey: arrangement.requirementKey,
          arrangementKey: arrangement.key,
        }}
      />
      <Text>
        {purchase
          ? ctx.t(noStore ? 'card.stuck.noStore' : 'card.stuck.purchase', {
              date: due(ctx, date, requirement?.basis.itemIds ?? []),
            })
          : ctx.t('card.stuck.childCare', { child: childLabel(ctx, arrangement.childId) })}
      </Text>
      {purchase && unknownId && requirement && (
        <Row>
          <Button
            kind="secondary"
            onClick={() =>
              void ctx.send({
                type: 'answer',
                unknownId,
                value: 'yes',
                seen: { what: requirement.what, throughSeq: ctx.plan.throughSeq },
              })
            }
          >
            {ctx.t('card.stuck.ready')}
          </Button>
        </Row>
      )}
    </Card>
  );
}

// ── 通用の「すること」 ──────────────────────────────

/** 「すること」の今の事項（要件の根拠の事項。置き換えをたどった今の物）。 */
export function needItem(ctx: Ctx, arrangement: Arrangement): Item | undefined {
  const requirement = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey);
  return ctx.items.find((l) => requirement?.basis.itemIds.includes(l.item.id))?.item;
}

/**
 * 「すること」の時：窓は日と始まり–終わり、締切は締切の日時（日だけの締切は日だけ。書かれていない時刻を見せない）。
 */
export function needWhen(ctx: Ctx, arrangement: Arrangement, item: Item | undefined): string {
  if (arrangement.needShape === 'window') {
    return ctx.t('need.when.window', {
      day: day(ctx, arrangement.start),
      from: time(ctx, arrangement.start),
      to: time(ctx, arrangement.end),
    });
  }
  const dayOnly = item?.interpretation.deadlineDayOnly === true;
  return ctx.t('need.when.by', {
    by: dayOnly ? day(ctx, arrangement.end) : dayTime(ctx, arrangement.end),
  });
}

/** まだ受け持ちを確かめられていない時間（計算が出した、覆ったと言えない時間）。 */
export function needGaps(ctx: Ctx, arrangement: Arrangement): string[] {
  const refs = arrangement.reasons.find((r) => r.code === 'notCovered')?.refs ?? [];
  return refs.map((ref) => {
    const [start, end] = ref.split('/');
    if (!start || !end) return ref;
    return `${time(ctx, start)}–${day(ctx, end) === day(ctx, start) ? time(ctx, end) : dayTime(ctx, end)}`;
  });
}

/**
 * 今ある「すること」のうち、上の札に出ていない物（返事待ち・進めている・受け持ちがそろった物）。いつでも開いて、
 * 見て、やり方や本命を替えられるようにする（札が出ない間に、戻る道を無くさない）。
 */
function NeedList({ ctx }: { ctx: Ctx }) {
  const shown = new Set(
    ctx.today.main.flatMap((c) => (c.kind === 'need' ? [c.arrangement.key] : [])),
  );
  const now = toEpochMinutes(ctx.now);
  const needs = ctx.plan.arrangements.filter(
    (a) => a.kind === 'need' && a.live && !shown.has(a.key) && toEpochMinutes(a.end) > now,
  );
  if (needs.length === 0) return null;
  return (
    <Card>
      <Label tone="sub">{ctx.t('today.needs')}</Label>
      {needs.map((arrangement) => {
        const what =
          ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey)?.what ?? '';
        return (
          <MoreLink
            key={arrangement.key}
            onClick={() => ctx.go({ name: 'need', key: arrangement.key })}
          >
            {ctx.t('today.needItem', {
              what,
              when: needWhen(ctx, arrangement, needItem(ctx, arrangement)),
            })}
          </MoreLink>
        );
      })}
    </Card>
  );
}

/** 通用の「すること」で、家族が決めることが残っている（大人の全員に出す）。 */
function NeedCard({ ctx, card }: { ctx: Ctx; card: Extract<TodayCard, { kind: 'need' }> }) {
  const { arrangement, requirement } = card;
  const step = needStep(arrangement);
  const gaps = step === 'gaps' ? needGaps(ctx, arrangement) : [];
  return (
    <Card>
      <Label tone="warn">
        {ctx.t(
          step === 'stuck'
            ? 'card.stuck.label'
            : step === 'gaps'
              ? 'card.need.gapsLabel'
              : 'card.decide.label',
        )}
      </Label>
      <Title>{requirement?.what ?? ''}</Title>
      <Text>{needWhen(ctx, arrangement, needItem(ctx, arrangement))}</Text>
      <ConditionLine
        ctx={ctx}
        basis={{
          itemIds: requirement?.basis.itemIds ?? [],
          requirementKey: arrangement.requirementKey,
          arrangementKey: arrangement.key,
        }}
      />
      {arrangement.reasons.some((r) => r.code === 'turnedDown') && (
        <Text>{ctx.t('card.decide.turnedDown')}</Text>
      )}
      {ctx.plan.requests.some(
        (r) => r.live && r.basis.arrangementKey === arrangement.key && r.state === 'awaitingReply',
      ) && <Text quiet>{ctx.t('card.need.waiting')}</Text>}
      {step === 'gaps' ? (
        <Text>
          {ctx.t('card.need.gaps', {
            gaps: new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(gaps),
          })}
        </Text>
      ) : (
        step !== 'settled' && <Text>{ctx.t(`card.need.${step}`)}</Text>
      )}
      <Button onClick={() => ctx.go({ name: 'need', key: arrangement.key })}>
        {ctx.t('card.need.action')}
      </Button>
    </Card>
  );
}

/**
 * モデルが読んだ「すること」の読み取り（何を・いつ）。書かれていない欄は、書かれていないと書く（作らない）。
 */
export function readNeedWhen(ctx: Ctx, interpretation: Item['interpretation']): string {
  const i = interpretation;
  if (i.shape === 'window') {
    if (!i.date) return ctx.t('card.needCheck.noDate');
    return ctx.t(
      i.startTime && i.endTime
        ? 'card.needCheck.window'
        : i.startTime
          ? 'card.needCheck.windowNoEnd'
          : 'card.needCheck.windowNoTime',
      { day: day(ctx, i.date), from: i.startTime ?? '', to: i.endTime ?? '' },
    );
  }
  if (i.shape === 'by') {
    if (!i.deadline) return ctx.t('card.needCheck.noDeadline');
    return ctx.t('card.needCheck.by', {
      by: i.deadlineDayOnly === true ? day(ctx, i.deadline) : dayTime(ctx, i.deadline),
    });
  }
  return ctx.t('card.needCheck.noShape');
}

/**
 * 読み取りの日時が終わる時（窓の終わり・締切。日だけの締切と、形の足りない物は書かれた日の終わり）。過ぎたことを
 * 札に添えるだけに使う（確かめていない日時なので、札を隠さない）。
 */
function readNeedOver(ctx: Ctx, i: Item['interpretation']): number | undefined {
  if (i.shape === 'window' && i.date && i.endTime) {
    return zonedToEpochMinutes(i.date, i.endTime, ctx.tz);
  }
  if (i.shape === 'by' && i.deadline) {
    return i.deadlineDayOnly === true
      ? zonedToEpochMinutes(i.deadline.slice(0, 10), '23:59', ctx.tz)
      : toEpochMinutes(i.deadline);
  }
  const date = i.date ?? i.deadline?.slice(0, 10);
  return date && isValidLocalDate(date) ? zonedToEpochMinutes(date, '23:59', ctx.tz) : undefined;
}

/** 確かめられる（「合っている」を押せる）形のそろった読み取りか。足りなければ、直してもらう。 */
export function readNeedComplete(interpretation: Item['interpretation']): boolean {
  const i = interpretation;
  if (i.shape === 'window')
    return !!i.date && !!i.startTime && !!i.endTime && i.startTime < i.endTime;
  return i.shape === 'by' && !!i.deadline;
}

/** 条件の値の言葉（はい・いいえ、実在する日付は日。ほかはお知らせの言葉のまま）。 */
const conditionValue = (ctx: Ctx, value: string) =>
  value === 'yes' || value === 'no'
    ? ctx.t(`card.question.family.${value}`)
    : isValidLocalDate(value)
      ? day(ctx, value)
      : value;

/**
 * 条件の式を、連結（かつ・または）と否定のまま文にする（短く言い換えない）。入れ子の連結は括弧でくくる。
 */
export function conditionExpr(ctx: Ctx, view: ConditionView, nested = false): string {
  if (view.kind === 'eq') {
    const value = conditionValue(ctx, view.value);
    return view.from
      ? ctx.t('condition.termFrom', { label: view.label, value, from: fromText(ctx, view.from) })
      : ctx.t('condition.term', { label: view.label, value });
  }
  if (view.kind === 'not') {
    return ctx.t('condition.notTerm', { term: conditionExpr(ctx, view.child, true) });
  }
  const joined = view.children
    .map((child) => conditionExpr(ctx, child, true))
    .join(ctx.t(view.kind === 'and' ? 'condition.and' : 'condition.or'));
  return nested ? ctx.t('condition.group', { expr: joined }) : joined;
}

/** 別のお知らせの手がかり（届いた日と、あれば題）。 */
function fromText(ctx: Ctx, from: ShownFrom): string {
  const at = day(ctx, from.day);
  return from.title === undefined
    ? ctx.t('card.needCheck.fromDay', { day: at })
    : ctx.t('card.needCheck.fromTitled', { day: at, title: from.title });
}

/** 置き換え・取り消しの先の事項（何を・いつ・別のお知らせなら、どれの）。見つからなければ、そう書く。 */
function targetText(ctx: Ctx, target: ShownTarget): string {
  if (target.what === undefined) return ctx.t('card.needCheck.unknownItem');
  const named = target.from
    ? ctx.t('card.needCheck.targetFrom', { what: target.what, from: fromText(ctx, target.from) })
    : ctx.t('card.needCheck.targetWhat', { what: target.what });
  const w = target.when;
  const parts = [
    w?.date &&
      ctx.t(w.startTime || w.endTime ? 'card.needCheck.targetTime' : 'card.needCheck.targetDay', {
        day: day(ctx, w.date),
        from: w.startTime ?? '',
        to: w.endTime ?? '',
      }),
    w?.deadline &&
      ctx.t('card.needCheck.targetBy', {
        by: w.deadlineDayOnly === true ? day(ctx, w.deadline) : dayTime(ctx, w.deadline),
      }),
  ].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length === 0
    ? named
    : ctx.t('card.needCheck.targetWhen', {
        target: named,
        when: parts.join(ctx.t('card.needCheck.targetJoin')),
      });
}

/**
 * 家族が確かめる読み取りの条件、未定の値への答え（どの値に何と）、置き換え・取り消しの先（何を・いつ）。別のお知らせ
 * の物には、そのお知らせを添える。見せられない・見分けられない物があれば、そう書く（確かめ・直しはできない。
 * サーバーも断る）。確かめる札と直す画面が同じ物を見せる。
 */
export function ReadingShown({ ctx, live }: { ctx: Ctx; live: Ctx['items'][number] }) {
  const { item } = live;
  return (
    <>
      {item.conditionNodeId === undefined ? (
        <Text quiet>{ctx.t('card.needCheck.noCondition')}</Text>
      ) : (
        live.condition && (
          <Text quiet>
            {ctx.t('card.needCheck.conditionExpr', { expr: conditionExpr(ctx, live.condition) })}
          </Text>
        )
      )}
      {(live.answers ?? []).map((answer) => {
        const params = { label: answer.label, value: conditionValue(ctx, answer.value) };
        return (
          <Text key={answer.unknownId}>
            {answer.from
              ? ctx.t('card.needCheck.answersFrom', { ...params, from: fromText(ctx, answer.from) })
              : ctx.t('card.needCheck.answers', params)}
          </Text>
        );
      })}
      {(live.targets ?? []).map((target) => (
        <Text key={`${target.type}:${target.itemId}`}>
          {ctx.t(target.type === 'replace' ? 'card.needCheck.replaces' : 'card.needCheck.cancels', {
            target: targetText(ctx, target),
          })}
        </Text>
      ))}
      {live.unshown && <Text>{ctx.t('card.needCheck.unshown')}</Text>}
    </>
  );
}

/**
 * 読み取りを確かめる・直す時の元の文。初めはお知らせの全文を見せ、読み取りが指した文を太字にする（指す文はモデルが
 * 選ぶので、指さなかった文に日時や条件を変える所〔「登校前にお願いします」〕があっても見落とさない）。長ければ、
 * 指した文と前後の一文にたためる。
 */
export function NoticeText({
  source,
  cited,
  t,
}: {
  source: Source | undefined;
  cited: readonly string[];
  t: TFunction;
}) {
  const [brief, setBrief] = useState(false);
  const sentences = source?.sentences ?? [];
  if (sentences.length === 0) return null;
  const marked = new Set(cited);
  const near = new Set(
    sentences.flatMap((sentence, index) =>
      marked.has(sentence.id) ? [index - 1, index, index + 1] : [],
    ),
  );
  const shown = sentences.filter((_, index) => !brief || near.has(index));
  const gap = source?.language === 'ja' ? '' : ' ';
  return (
    <>
      <Quote>
        {shown.map((sentence, index) => (
          <span key={sentence.id} className={marked.has(sentence.id) ? 'font-bold' : 'text-sub'}>
            {index > 0 ? gap : ''}
            {sentence.text}
          </span>
        ))}
      </Quote>
      {brief ? (
        <MoreLink onClick={() => setBrief(false)}>
          {t('card.needCheck.wholeNotice', { count: sentences.length - shown.length })}
        </MoreLink>
      ) : (
        near.size > 0 &&
        sentences.some((_, index) => !near.has(index)) && (
          <MoreLink onClick={() => setBrief(true)}>{t('card.needCheck.brief')}</MoreLink>
        )
      )}
    </>
  );
}

/**
 * モデルが読んだ「すること」を、家族に確かめてもらう札。確かめるまで計画に入れない（手配も作業も無い）。元の文と、
 * 読み取り（何を・いつ・条件・ほかの事項への作用）を見せ、合っている・直す・読み取りが違う（外す）を選んでもらう。
 * どれも、見せた時の番号を付ける（後で読み直された中身を、古い札から決めない）。
 */
function NeedCheckCard({
  ctx,
  card,
}: {
  ctx: Ctx;
  card: Extract<TodayCard, { kind: 'needCheck' }>;
}) {
  const { requirement } = card;
  const itemId = requirement.basis.itemIds[0] ?? '';
  const live = ctx.items.find((l) => l.item.id === itemId);
  const [failed, setFailed] = useState<string | undefined>();
  if (!live) return null;
  const { item } = live;
  const source = ctx.sources.get(item.sourceId);
  const seen = { throughSeq: ctx.plan.throughSeq };
  const confirmable = live.unshown !== true;
  // 元の文と食い違う・推定の読み取りか、確かめてほしい文（時刻の読み落としかもしれない等）を指す読み取り。
  const reading = ctx.readings.find((r) => r.sourceId === item.sourceId);
  const flagged =
    !live.trusted ||
    reading?.checkAll === true ||
    item.sentenceIds.some((id) => reading?.check?.includes(id) === true);
  const over = readNeedOver(ctx, item.interpretation);
  const past = over !== undefined && over <= toEpochMinutes(ctx.now);
  const send = async (command: Command) => {
    const result = await ctx.send(command);
    setFailed(succeeded(result) ? undefined : ('reason' in result && result.reason) || 'other');
  };
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.needCheck.label')}</Label>
      <Title>{requirement.what}</Title>
      <Text>{ctx.t('card.needCheck.read', { when: readNeedWhen(ctx, item.interpretation) })}</Text>
      <ReadingShown ctx={ctx} live={live} />
      {!requirement.live && <Text>{ctx.t('card.needCheck.notLive')}</Text>}
      {past && <Text>{ctx.t('card.needCheck.past')}</Text>}
      <NoticeText source={source} cited={item.sentenceIds} t={ctx.t} />
      {flagged && <Text>{ctx.t('card.needCheck.flagged')}</Text>}
      <Text quiet>{ctx.t('card.needCheck.body')}</Text>
      {failed !== undefined && (
        <Text>
          {ctx.t(`card.needCheck.failed.${failed}`, {
            defaultValue: ctx.t('card.needCheck.failed.other'),
          })}
        </Text>
      )}
      {confirmable && (
        <Row>
          {readNeedComplete(item.interpretation) && (
            <Button onClick={() => void send({ type: 'confirmItem', itemId, seen })}>
              {ctx.t('card.needCheck.ok')}
            </Button>
          )}
          <Button kind="secondary" onClick={() => ctx.go({ name: 'needFix', itemId })}>
            {ctx.t('card.needCheck.fix')}
          </Button>
        </Row>
      )}
      <MoreLink onClick={() => void send({ type: 'dismissItem', itemId, reason: 'misread', seen })}>
        {ctx.t('card.needCheck.misread')}
      </MoreLink>
      <MoreLink onClick={() => void send({ type: 'dismissItem', itemId, reason: 'notOurs', seen })}>
        {ctx.t('card.needCheck.notOurs')}
      </MoreLink>
      <Text quiet>{ctx.t('card.needCheck.misreadNote')}</Text>
    </Card>
  );
}

/**
 * 済んだと記録する命令。この札で見せている用件を付ける（直されて別の物になった後の古い札で、別の物を
 * 済みにしない。違えば、サーバーが断って見せ直す）。
 */
const doneCommand = (task: Task): Command => ({
  type: 'commitment',
  taskKey: task.key,
  action: 'done',
  seen: taskContent(task),
});

/**
 * した事実を記録する操作：人に頼む作業は頼む文の画面へ（送ったと記録するのは、その画面で）、所へ出す物
 * （学童の申込書・会社への届け）は「送った」（見せた頼む時間を付ける）、ほかは「済んだ」（見せた用件を付ける）。
 */
function finishOf(ctx: Ctx, task: Task): { label: string; ask: boolean; run: () => void } {
  const ask = asksPerson(ctx, task);
  const external = task.external !== undefined;
  return {
    label: ctx.t(ask ? 'quiet.send' : 'quiet.done'),
    ask,
    run: () =>
      ask
        ? ctx.go({ name: 'ask', taskKey: task.key })
        : external
          ? void ctx.send(sentCommand(ctx, task))
          : void ctx.send(doneCommand(task)),
  };
}

function ProposalCard({ ctx, task }: { ctx: Ctx; task: Task }) {
  // 引き受けには、この札で見せている提案の控えを付ける。今の提案と違えば、サーバーが断って見せ直す。
  const shown = proposalSnapshot(task);
  const accept = () => {
    if (shown) void ctx.send({ type: 'accept', taskKey: task.key, shown });
  };
  const decline = () => void ctx.send({ type: 'commitment', taskKey: task.key, action: 'decline' });
  // 案の無い作業（提出物）は、時刻に置けなくても（締切の日の朝を過ぎた等）、済んだ事実を記録できる
  // ようにする（時刻の無い物を、時刻のある提案として引き受けさせない）。
  const standalone =
    task.basis.optionKey === undefined && task.external === undefined && task.cancels === undefined;
  // 書かれた時間に決まった作業（当番）が置けない時は、ずらさずに、その時間がふさがっていると書く。
  const fixedTime = task.timing === 'fixed' || task.timing === 'fixedEndEstimated';
  // 一緒に置く中で、ほかに進める手の作業と重ならない時刻を見つけられなかった手の作業（時刻を置いていない）。
  // ふだんの予定に空きが無いのとは違うので、そう書かず、決める画面で見直せるようにする。
  const arrangement = arrangementOf(ctx, task.basis.arrangementKey);
  const optionKey = task.basis.optionKey;
  const conflicted =
    !shown &&
    optionKey !== undefined &&
    (arrangement?.reasons.some((r) => r.code === 'timeConflict' && r.refs.includes(optionKey)) ??
      false);
  // どれかの手順を、ふだんの予定に置ける区間が無い手（平日の昼の窓口等）。手の単位の印なので、この作業そのものに
  // 時間が無いとは書かない（前の手順は置けることがある）。ほかの人に頼んでも置けないので、そう書かない。
  const noSlot =
    !shown && arrangement?.options.some((o) => o.key === optionKey && o.noSlot === true) === true;
  // 自分の作業で、置けていない・時刻が来た物は、引き受けを経ずに、した事実（済んだ・送った）を記録できる
  // （先に済ませてから開くこともある。過ぎた時刻を引き受けさせない）。
  const due =
    !shown || (task.start !== undefined && toEpochMinutes(task.start) <= toEpochMinutes(ctx.now));
  // 引き受けた後に変わった物（時刻が過ぎて置き直した、日が直された等）も、今の用件そのものをもう済ませて
  // いれば記録できる。記録するのは今の札の用件で、変わる前の用件を済ませた事ではない。
  // 時刻なしで引き受ける作業（書かれた時刻の無い当番、日の無いサイン）は、引き受けと一緒に、もう済んだ
  // ことも記録できる。
  const fact =
    task.assigneeId === ctx.me.id &&
    task.cancels === undefined &&
    (due || task.reconfirm === true || untimed(task))
      ? finishOf(ctx, task)
      : undefined;
  // 置ける時間が無い時は、その場でもう一人に頼めるようにする（断ってから探し直させない）。本人しか
  // できない手順は頼めない。
  const other =
    fixedAssignee(ctx.household, task) === undefined
      ? otherAdult(ctx.household, ctx.me.id)
      : undefined;
  const askOther = () => {
    if (other) {
      void ctx.send({
        type: 'proposeAssignment',
        taskKey: task.key,
        assigneeId: other.id,
        seen: seenOf(task),
      });
    }
  };
  const store = task.atPlaceId
    ? ctx.household.places.find((p) => p.id === task.atPlaceId)
    : undefined;
  const late = task.detour
    ? minutesBetween(task.detour.plannedArrival, task.detour.delayedArrival)
    : 0;
  return (
    <Card>
      <Label tone="accent">{ctx.t('card.proposal.label')}</Label>
      <Title>{taskTitle(ctx, task)}</Title>
      <ConditionLine ctx={ctx} basis={task.basis} />
      {/* 書かれた時刻の決まった作業は、置けていなくても書かれた時間を見せる（置いた時刻と同じ）。 */}
      {task.timing !== undefined && <WrittenTime ctx={ctx} task={task} />}
      {task.timing === undefined && task.start && task.end && (
        <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
          <span className="font-bold tabular-nums">
            {ctx.t('card.proposal.when', {
              day: day(ctx, task.start),
              from: time(ctx, task.start),
              to: time(ctx, task.end),
            })}
          </span>
          {/* 歩く時間は、目安の出どころがある時だけ（0 は「移動を足していない」で、駅から 0 分ではない）。 */}
          {store && (
            <span className="text-[15px] text-sub">
              {task.travelSource !== 'none' && task.travelBeforeMin > 0
                ? ctx.t('card.proposal.where', { place: store.name, walk: task.travelBeforeMin })
                : ctx.t('card.proposal.at', { place: store.name })}
            </span>
          )}
          {!task.detour && task.travelSource !== 'none' && task.travelAfterMin > 0 && (
            <span className="text-[15px] text-sub">
              {ctx.t('card.proposal.back', { min: task.travelAfterMin })}
            </span>
          )}
          {task.detour && (
            <span className="text-[15px]">
              {ctx.t('card.proposal.home', { time: time(ctx, task.detour.delayedArrival), late })}
            </span>
          )}
        </div>
      )}
      {/* 外の相手に出す作業は、相手と、何を待つか（返事・承認・受け付け）を、引き受ける前に見せる。 */}
      {task.external && (
        <Text quiet>
          {ctx.t(`card.proposal.external.${task.external.kind}`, {
            to: nameOf(ctx.household, task.external.to),
          })}
        </Text>
      )}
      {/* 受け持ち：窓の間ずっと、その人の時間を使う（ほかの作業を置かない）。 */}
      {task.cover && <Text quiet>{ctx.t('card.proposal.cover')}</Text>}
      {task.reconfirm && <Text quiet>{ctx.t('card.proposal.changed')}</Text>}
      {task.reconfirm && fact && (
        <Text quiet>
          {fact.ask
            ? ctx.t('card.proposal.sentAlready', { label: fact.label })
            : ctx.t('card.proposal.doneAlready', {
                what: taskTitle(ctx, task),
                label: fact.label,
              })}
        </Text>
      )}
      {!shown && (
        <Text>
          {ctx.t(
            task.handoff
              ? 'card.proposal.handoff'
              : conflicted
                ? 'card.proposal.conflicted'
                : noSlot
                  ? 'card.proposal.noSlot'
                  : fixedTime
                    ? toEpochMinutes(task.earliestStart ?? ctx.now) > toEpochMinutes(ctx.now)
                      ? 'card.proposal.fixedBusy'
                      : 'card.proposal.fixedPast'
                    : standalone
                      ? 'card.proposal.unplacedDue'
                      : 'card.proposal.unplaced',
          )}
        </Text>
      )}
      {conflicted && arrangement && (
        <MoreLink onClick={() => ctx.go(decideRoute(arrangement))}>
          {ctx.t('card.proposal.review')}
        </MoreLink>
      )}
      <Row>
        {shown && !due && <Button onClick={accept}>{ctx.t('card.proposal.accept')}</Button>}
        {fact && (
          <Button kind={shown && !due ? 'secondary' : 'primary'} onClick={fact.run}>
            {fact.label}
          </Button>
        )}
        {!shown && other && (
          <Button onClick={askOther}>{ctx.t('card.proposal.ask', { name: other.name })}</Button>
        )}
        <Button kind="secondary" onClick={decline}>
          {ctx.t('card.proposal.decline')}
        </Button>
      </Row>
    </Card>
  );
}

/**
 * 担当のいない作業（断った・できなくなった・担当が付いていない）。大人の全員に出し、誰かが持つか、
 * もう一人に頼むか、その案をやめるまで残す（02-foundation の不変 7「誰かが持つ」）。
 */
function UnownedCard({
  ctx,
  task,
  arrangement,
}: {
  ctx: Ctx;
  task: Task;
  arrangement: Arrangement | undefined;
}) {
  const other = otherAdult(ctx.household, ctx.me.id);
  const option = arrangement?.options.find((o) => o.key === task.basis.optionKey);
  const why =
    task.commitment === 'declined'
      ? 'declined'
      : task.commitment === 'withdrawn'
        ? 'withdrawn'
        : undefined;
  // 二人が同じ札を見るので、見せた担当と状態を付ける（もう一人が先に持っていたら、断って見せ直す）。
  const propose = (assigneeId: string) =>
    void ctx.send({ type: 'proposeAssignment', taskKey: task.key, assigneeId, seen: seenOf(task) });
  const ofOption = (basis: { arrangementKey?: string; optionKey?: string }) =>
    basis.arrangementKey === arrangement?.key && basis.optionKey === option?.key;
  // 本人しかできない手順は、その人だけが持てる（他の人には、案をやめるかだけを出す）。断った本人には
  // 頼み直さない。断ったのが自分なら、まずもう一人に頼む。
  const fixed = fixedAssignee(ctx.household, task);
  const canSelf = fixed === undefined || fixed === ctx.me.id;
  const askable = fixed === undefined && other !== undefined && other.id !== task.assigneeId;
  const mine = task.assigneeId === ctx.me.id;
  const self = canSelf && (
    <Button kind={mine ? 'secondary' : 'primary'} onClick={() => propose(ctx.me.id)}>
      {ctx.t('card.unowned.self')}
    </Button>
  );
  const ask = askable && (
    <Button kind={mine ? 'primary' : 'secondary'} onClick={() => propose(other.id)}>
      {ctx.t('card.unowned.ask', { name: other.name })}
    </Button>
  );
  return (
    <Card tone="accent">
      <Label tone="warn">{ctx.t('card.unowned.label')}</Label>
      <Title>{taskTitle(ctx, task)}</Title>
      <ConditionLine ctx={ctx} basis={task.basis} />
      {why && task.assigneeId && (
        <Text>
          {ctx.t(`card.unowned.${why}`, { name: nameOf(ctx.household, task.assigneeId) })}
        </Text>
      )}
      {fixed !== undefined && fixed !== ctx.me.id && (
        <Text>{ctx.t('card.unowned.fixed', { name: nameOf(ctx.household, fixed) })}</Text>
      )}
      {option?.decisionDeadline && (
        <Text>
          {ctx.t('card.unowned.deadline', { deadline: dayTime(ctx, option.decisionDeadline) })}
        </Text>
      )}
      {/* 案の無い作業（提出物）は、外の締切の日を出す（朝の時刻は目安なので、日だけ）。書かれた時刻の決まり
          のある作業（当番）は、締切ではなく、書かれた時間・場所を出す。 */}
      {task.timing !== undefined && <WrittenTime ctx={ctx} task={task} />}
      {task.timing === undefined && !option && task.deadline && (
        <Text>
          {ctx.t('card.unowned.by', { date: due(ctx, task.deadline, task.basis.itemIds) })}
        </Text>
      )}
      <Row>
        {mine ? ask : self}
        {mine ? self : ask}
      </Row>
      {/* やめられるのは、家族が選んだ案（本命・予備）だけ。勧めただけの案には出さない。 */}
      {arrangement &&
        option &&
        (arrangement.chosenOptionKey === option.key ||
          arrangement.backupOptionKeys.includes(option.key)) && (
          <MoreLink
            onClick={() =>
              void ctx.send({
                type: 'dropOption',
                arrangementKey: arrangement.key,
                optionKey: option.key,
                seen: {
                  tasks: ctx.plan.tasks.filter((t) => t.live && ofOption(t.basis)).map(seenOf),
                  requests: ctx.plan.requests
                    .filter((r) => r.live && ofOption(r.basis))
                    .map((r) => ({ requestId: r.requestId, state: r.state })),
                },
              })
            }
          >
            {ctx.t(
              arrangement.backupOptionKeys.includes(option.key)
                ? 'card.unowned.dropBackup'
                : 'card.unowned.dropPrimary',
            )}
          </MoreLink>
        )}
    </Card>
  );
}

function BackupCard(props: { ctx: Ctx; arrangement: Arrangement; option: OptionPlan }) {
  const { ctx, arrangement, option } = props;
  const other = otherAdult(ctx.household, ctx.me.id);
  // 予備として押さえ、作業を担当に提案する。この札は作業ごとの時刻・場所を見せていないので、
  // 引き受けは、担当の人が中身を見せる提案の札で、作業ごとに行う（自分でやる時も同じ）。
  const choose = (assignee: string) =>
    void ctx.send({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'backup',
      assigneeId: assignee,
    });
  return (
    <Card tone="accent">
      <Label tone="warn">{ctx.t('card.backup.label')}</Label>
      <Title>{ctx.t('card.backup.title', { option: optionTitle(ctx, option) })}</Title>
      {option.decisionDeadline && (
        <Text>
          {ctx.t('card.backup.body', { deadline: dayTime(ctx, option.decisionDeadline) })}
        </Text>
      )}
      {other && (
        <Button onClick={() => choose(other.id)}>
          {ctx.t('card.backup.ask', { name: other.name })}
        </Button>
      )}
      <Button kind="secondary" onClick={() => choose(ctx.me.id)}>
        {ctx.t('card.backup.self')}
      </Button>
      <Text quiet>{ctx.t('card.backup.note')}</Text>
      {/* 返事を待つ間も、全部の手と「選んだら」を見て、選び直せる（選ぶのは向きで、後から替えられる）。 */}
      <MoreLink onClick={() => ctx.go(decideRoute(arrangement))}>
        {ctx.t('card.backup.all')}
      </MoreLink>
    </Card>
  );
}

export function CancelCard({
  ctx,
  task,
  request,
}: {
  ctx: Ctx;
  task: Task;
  request: ExternalRequest;
}) {
  const [open, setOpen] = useState(false);
  const draft = cancelDraft(ctx, request);
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.cancel.label')}</Label>
      <Title>{taskTitle(ctx, task)}</Title>
      <Text quiet>{ctx.t('card.cancel.body')}</Text>
      {open ? (
        <>
          <Quote>{draft}</Quote>
          {cancelNotes(ctx, request).map((note) => (
            <Text quiet key={note}>
              {ctx.t(note)}
            </Text>
          ))}
          <DraftActions ctx={ctx} draft={draft} />
        </>
      ) : (
        <MoreLink onClick={() => setOpen(true)}>{ctx.t('card.cancel.showDraft')}</MoreLink>
      )}
      <Button
        onClick={() =>
          void ctx.send({ type: 'recordCancellationSent', requestId: request.requestId })
        }
      >
        {ctx.t('card.cancel.done')}
      </Button>
    </Card>
  );
}

/**
 * 通用の「すること」の依頼の、記録した時の中身（頼んだ手順・何を・頼んだ時間か締切・場所・だれの分）。今の値では
 * 埋めない（控えに中身が無ければ、確かめられないと書く）。相手が読んだ文は、家族が直せるので確かめていない。
 */
export function askedLines(ctx: Ctx, request: ExternalRequest): string[] {
  const asked = request.askedNeed;
  if (!asked) return [ctx.t('quiet.recordedUnknown')];
  const when =
    requestWhen(ctx, request) ??
    (asked.deadline
      ? ctx.t('need.when.by', {
          by: asked.deadlineDayOnly ? day(ctx, asked.deadline) : dayTime(ctx, asked.deadline),
        })
      : undefined);
  const what = when ? ctx.t('quiet.recordedWhen', { what: asked.what, when }) : asked.what;
  const lines = [
    asked.step
      ? ctx.t('quiet.recordedStep', { step: asked.step.name, what })
      : ctx.t('quiet.recorded', { what }),
  ];
  if (asked.place) lines.push(ctx.t('quiet.recordedPlace', { place: asked.place }));
  if (asked.forMemberId) {
    lines.push(ctx.t('quiet.recordedFor', { name: nameOf(ctx.household, asked.forMemberId) }));
  }
  return lines;
}

function QuietRow({ ctx, card, last }: { ctx: Ctx; card: TodayCard; last: boolean }) {
  const border = last ? '' : 'border-b border-line';
  if (card.kind === 'waiting') {
    const { request } = card;
    const reply = (value: 'yes' | 'no') =>
      void ctx.send({ type: 'recordReply', requestId: request.requestId, reply: value });
    // 「送った」を押し間違えた時だけ、押した本人が、返事の前に無かった事にできる（§5.6）。
    const mistaken =
      request.sentBy === ctx.me.id && request.state === 'awaitingReply'
        ? () => void ctx.send({ type: 'correctSentRecord', requestId: request.requestId })
        : undefined;
    return (
      <div className={`flex flex-col gap-2 py-2.5 ${border}`}>
        <span className="flex items-center gap-2">
          <span className="text-accent">
            <Icon path={ICON.message} size={20} />
          </span>
          {ctx.t('quiet.waiting', {
            to: nameOf(ctx.household, request.to),
            sent: day(ctx, request.sentAt),
          })}
        </span>
        {/* 通用の「すること」の「はい」は、控えの時間を覆う証拠になる。何に「はい」を記録するかを、記録した時の
            控えで見せる（相手が読んだ文は、家族が直せるので確かめていない）。 */}
        {isNeedArrangementKey(request.basis.arrangementKey) &&
          askedLines(ctx, request).map((line) => (
            <span key={line} className="text-sm text-sub">
              {line}
            </span>
          ))}
        <Row>
          <Button kind="secondary" className="min-h-11 text-base" onClick={() => reply('yes')}>
            {ctx.t('quiet.replyYes')}
          </Button>
          <Button kind="secondary" className="min-h-11 text-base" onClick={() => reply('no')}>
            {ctx.t('quiet.replyNo')}
          </Button>
        </Row>
        {mistaken && <MoreLink onClick={mistaken}>{ctx.t('quiet.notSent')}</MoreLink>}
      </div>
    );
  }
  if (card.kind === 'bring') {
    const { requirement } = card;
    const unknownId = requirement.atHomeUnknownId;
    const condition = conditionOf(ctx, requirement.basis);
    // どのお知らせの物か（同じ品物を同じ日に求めるお知らせが二つあっても、答え直す物を見分けられる）。
    const item = ctx.items.find((l) => requirement.basis.itemIds.includes(l.item.id))?.item;
    const title = item && ctx.sources.get(item.sourceId)?.title;
    // 用意の締切の後に、無いと答えた物（もう買う手配は無い。どうするかは家族が決める）。
    const missing = !card.bought && requirement.atHome === 'no';
    // 答えられる間は答え直せる：家にあると答えた物は「やっぱり無かった」（締切の前なら、買う手配か「このまま
    // では無理」が出る）、無いと答えた物は「用意できた」。
    const reanswer =
      card.reanswer && unknownId
        ? () =>
            void ctx.send({
              type: 'answer',
              unknownId,
              value: missing ? 'yes' : 'no',
              seen: { what: requirement.what, throughSeq: ctx.plan.throughSeq },
            })
        : undefined;
    return (
      <div className={`flex flex-col gap-1 py-2.5 ${border}`}>
        <span className="flex items-center gap-2">
          {!missing && (
            <span className="text-accent">
              <Icon path={ICON.check} size={20} />
            </span>
          )}
          {ctx.t('quiet.bring', {
            what: requirement.what,
            day: requirement.date ? day(ctx, requirement.date) : '',
          })}
        </span>
        <span className={`text-sm ${missing ? 'font-bold text-warn' : 'text-sub'}`}>
          {ctx.t(
            card.bought
              ? 'quiet.bringBought'
              : missing
                ? 'quiet.bringMissingLate'
                : 'quiet.bringAtHome',
          )}
        </span>
        {condition && (
          <span className="text-sm text-sub">{condition.when ?? ctx.t('say.conditional')}</span>
        )}
        {item && (
          <MoreLink
            onClick={() =>
              ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
            }
          >
            {title ? ctx.t('card.question.sourceTitled', { title }) : ctx.t('card.question.source')}
          </MoreLink>
        )}
        {reanswer && (
          <MoreLink onClick={reanswer}>
            {ctx.t(missing ? 'quiet.bringReady' : 'quiet.bringMissing')}
          </MoreLink>
        )}
      </div>
    );
  }
  if (card.kind === 'todo') {
    const { task } = card;
    const condition = conditionOf(ctx, task.basis);
    // 所へ出す物（学童の申込書・会社への届け）は、出した時に「送った」と記録し、相手の返事を待つ。
    const finish = finishOf(ctx, task);
    return (
      <div className={`flex items-center gap-3 py-2.5 ${border}`}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{taskTitle(ctx, task)}</span>
          {task.timing !== undefined ? (
            <span className="text-sm text-sub tabular-nums">{writtenWhen(ctx, task)}</span>
          ) : (
            task.start && (
              <span className="text-sm text-sub tabular-nums">{dayTime(ctx, task.start)}</span>
            )
          )}
          {condition && (
            <span className="text-sm text-sub">{condition.when ?? ctx.t('say.conditional')}</span>
          )}
        </span>
        <button
          type="button"
          onClick={finish.run}
          className="min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-3 text-[15px] font-bold"
        >
          {finish.label}
        </button>
      </div>
    );
  }
  return null;
}

// ── 決める ──────────────────────────────

/**
 * 決める画面の「選んだら」（サーバーが書き込まずに同じ計算をした結果）を読む。計画が変わるたびと、reread で
 * 読み直す。今の計画の分を読み終えるまで（loading）と、読めなかった時（failed）は、選ぶ操作を止める（見せて
 * いない後始末のまま選ばせない）。読む手立ての無い画面（off）では、前のとおり選べる。
 */
export function useChoicePreviews(
  preview: Ctx['preview'],
  arrangementKey: string,
  throughSeq: number,
): {
  reading: 'off' | 'loading' | 'failed' | 'ready';
  previews?: ReadonlyMap<string, ChoicePreview>;
  reread: () => void;
} {
  const [read, setRead] = useState<{
    key: string;
    previews?: ReadonlyMap<string, ChoicePreview>;
  }>();
  // 読み直しの合図（選ぶ前に中身が変わっていて断られた時と、読めずにもう一度読む時）。
  const [again, setAgain] = useState(0);
  const readKey = `${arrangementKey}|${throughSeq}|${again}`;
  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    void preview(arrangementKey).then((list) => {
      if (cancelled) return;
      setRead({
        key: readKey,
        ...(list ? { previews: new Map(list.map((p) => [p.optionKey, p])) } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [preview, arrangementKey, readKey]);
  const reread = useCallback(() => setAgain((n) => n + 1), []);
  const fresh = read?.key === readKey;
  const previews = fresh ? read?.previews : undefined;
  const reading = !preview ? 'off' : !fresh ? 'loading' : previews ? 'ready' : 'failed';
  return { reading, ...(previews ? { previews } : {}), reread };
}

export function DecideScreen({ ctx, arrangementKey }: { ctx: Ctx; arrangementKey: string }) {
  const arrangement = arrangementOf(ctx, arrangementKey);
  // 通用の「すること」は、この画面（子の居場所の文）で決めさせない（「すること」の画面で決める）。
  if (!arrangement || arrangement.kind === 'need') return <Missing ctx={ctx} />;
  const requirement = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey);
  const date = requirement?.date ?? arrangement.start;
  const working = ctx.household.members
    .filter((m) => m.kind === 'adult' && m.active)
    .map((m) => ctx.t('decide.person', { name: m.name }));
  // 選んだ手の作業が、ほかに進める作業と重ならずに置けていない（時刻を置いていない）。
  const conflicted = arrangement.reasons.find((r) => r.code === 'timeConflict')?.refs ?? [];

  // 元の文へ：根拠の事項の出典（事項の ID から推し量らない。ID は中身を持たない）。
  const basisItems = ctx.items.filter(({ item }) => requirement?.basis.itemIds.includes(item.id));
  const source = basisItems[0]?.item.sourceId;
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('decide.eyebrow', { date: day(ctx, date), what: requirement?.what ?? '' })}
        title={ctx.t('decide.title', { child: childLabel(ctx, arrangement.childId) })}
      />
      <Main>
        {/* 条件しだいの手配は、決める画面でもそう書く（確かな予定として選ばせない）。 */}
        <ConditionLine
          ctx={ctx}
          basis={{
            itemIds: requirement?.basis.itemIds ?? [],
            requirementKey: arrangement.requirementKey,
            arrangementKey: arrangement.key,
          }}
        />
        {conflicted.length > 0 && (
          <Card tone="warn">
            <Text>{ctx.t('decide.conflicted', { options: optionList(ctx, conflicted) })}</Text>
          </Card>
        )}
        <Text quiet>
          {ctx.t('decide.context', {
            names: new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(working),
          })}
        </Text>
        {source && (
          <MoreLink
            onClick={() =>
              ctx.go({
                name: 'sources',
                sourceId: source,
                highlight: basisItems
                  .filter(({ item }) => item.sourceId === source)
                  .flatMap(({ item }) => item.sentenceIds),
              })
            }
          >
            {ctx.t('decide.source')}
          </MoreLink>
        )}
        <OptionChooser ctx={ctx} arrangement={arrangement} />
      </Main>
    </>
  );
}

/**
 * 案を選ぶ所（決め時の時計・案の札と「選んだら」）。子の居場所の決める画面と、通用の「すること」の画面で同じ物。
 *
 * 本命に選び、作業を担当に提案する。担当は「選んだら」と同じ人（決まった担当があればその人、無ければ自分、自分の
 * 時間にもう置けなければ置ける大人。サーバーが決めて見せた人）。「選んだら」が無ければ、決まった担当か自分。
 * ここは作業ごとの時刻・場所を見せていないので、ここでは引き受けない（提案の札で中身を見て引き受ける。人に頼む
 * 作業は、下書きを送れば済みになる）。
 */
export function OptionChooser({ ctx, arrangement }: { ctx: Ctx; arrangement: Arrangement }) {
  const { reading, previews, reread } = useChoicePreviews(
    ctx.preview,
    arrangement.key,
    ctx.plan.throughSeq,
  );
  const options = [...arrangement.options].sort(
    (a, b) =>
      Number(a.expired) - Number(b.expired) ||
      (a.decisionDeadline ?? '9').localeCompare(b.decisionDeadline ?? '9'),
  );
  const choose = async (option: OptionPlan) => {
    const tasks = option.taskKeys
      .map((k) => ctx.plan.tasks.find((t) => t.key === k))
      .filter((t): t is Task => t !== undefined && !t.extra);
    const first = tasks[0];
    const fixed = firstStepAssignee(ctx.household, option);
    // 「選んだら」を見せていれば、見せた物の要約を添える（変わっていれば、サーバーが断る。読み直して見せる）。
    const seen = previews?.get(option.key);
    if (reading !== 'off' && !seen?.seen) return;
    const assignee = seen?.assigneeId ?? fixed ?? ctx.me.id;
    const result = await ctx.send({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: assignee,
      ...(seen?.seen ? { seen: seen.seen } : {}),
    });
    if (result.status === 'conflict') reread();
    if (!succeeded(result)) return;
    if (first && asksPerson(ctx, first) && assignee === ctx.me.id) {
      ctx.go({ name: 'ask', taskKey: first.key });
    } else ctx.go({ name: 'today' });
  };
  // 締切までに済ませる「すること」は、締切までの時計（窓の「すること」と子の居場所は、要る時の始まりまで）。
  const until =
    arrangement.kind === 'need' && arrangement.needShape === 'by'
      ? arrangement.end
      : arrangement.start;
  return (
    <>
      <ChoiceClock
        t={ctx.t}
        lang={ctx.lang}
        tz={ctx.tz}
        now={ctx.now}
        until={until}
        options={options.map((o) => ({
          key: o.key,
          title: optionTitle(ctx, o),
          ...(o.decisionDeadline ? { deadline: o.decisionDeadline } : {}),
          expired: o.expired,
        }))}
      />
      {reading === 'failed' && (
        <Card tone="warn">
          <Text>{ctx.t('decide.previewFailed')}</Text>
          <Button onClick={reread}>{ctx.t('decide.previewRetry')}</Button>
        </Card>
      )}
      {options.map((option) => {
        const shown = previews?.get(option.key);
        // 「選んだら」を読める画面で、この手の分がまだ無い（読んでいる・読めなかった・出せなかった）。
        const waiting =
          reading === 'off' || shown ? undefined : reading === 'ready' ? 'missing' : reading;
        return (
          <OptionRow
            key={option.key}
            ctx={ctx}
            option={option}
            arrangement={arrangement}
            {...(shown ? { preview: shown } : {})}
            {...(waiting ? { waiting } : {})}
            onChoose={() => void choose(option)}
          />
        );
      })}
      <Text quiet>{ctx.t('decide.reversible')}</Text>
    </>
  );
}

function previousEvening(deadline: string): string {
  const date = deadline.slice(0, 10);
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/** 手の名前を並べた一句（ほかの日の手なら日を添える）。 */
export function optionList(ctx: Ctx, optionKeys: readonly string[]): string {
  const names = optionKeys.flatMap((key) => {
    const arrangement = ctx.plan.arrangements.find((a) => a.options.some((o) => o.key === key));
    const option = arrangement?.options.find((o) => o.key === key);
    if (!arrangement || !option) return [];
    const date = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey)?.date;
    return [
      ctx.t('decide.quoted', {
        title: date
          ? ctx.t('decide.onDay', { title: optionTitle(ctx, option), day: day(ctx, date) })
          : optionTitle(ctx, option),
      }),
    ];
  });
  return new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(names);
}

/** 案の札の印（勧める・進めている・予備）。 */
function Badge({ children, accent }: { children: string; accent?: boolean }) {
  return (
    <span
      className={`rounded-full px-2 text-[13px] font-bold ${accent ? 'bg-accent text-white' : 'bg-accent-soft text-accent-dark'}`}
    >
      {children}
    </span>
  );
}

/**
 * 選んだら何が起きるか（サーバーが同じ計算で出した物）を、短い文にする。最初の一手（誰が、いつまでに
 * 始めるか）、ほかの作業の数、返事を待つこと、取り消しを伝える依頼、時刻の動くほかの作業。今進めている
 * 案には出さない（決める画面では選び直さない）。
 */
export function previewLines(ctx: Ctx, preview: ChoicePreview): string[] {
  if (preview.current) return [];
  const lines: string[] = [];
  const arrangement = arrangementOf(ctx, preview.arrangementKey);
  const option = arrangement?.options.find((o) => o.key === preview.optionKey);
  // 重ならずに置けない（時刻を置かずに残す）手と、検証器が見つけた新しい違反（選ぶと起きる物）を先に書く。
  if (preview.conflicts.length > 0) {
    lines.push(ctx.t('decide.then.conflict', { options: optionList(ctx, preview.conflicts) }));
  }
  const issues = preview.issues ?? [];
  if (issues.includes('task_overlap')) lines.push(ctx.t('decide.then.overlap'));
  const others = issues.filter((code) => code !== 'task_overlap').length;
  if (others > 0) lines.push(ctx.t('decide.then.issues', { count: others }));
  // 自分の時間にもう置けないので、置ける大人に提案する（案に決まった担当がある時は、案の名前で分かる）。
  const fixed = option && firstStepAssignee(ctx.household, option);
  if (preview.assigneeId !== undefined && preview.assigneeId !== ctx.me.id && !fixed) {
    lines.push(
      ctx.t('decide.then.handOver', {
        name: ctx.t('decide.person', { name: nameOf(ctx.household, preview.assigneeId) }),
      }),
    );
  }
  const first = preview.steps[0];
  if (first) {
    const task = ctx.plan.tasks.find((t) => t.key === first.taskKey);
    const what = task ? baseTitle(ctx, task) : ctx.t(first.titleKey, first.titleParams);
    const who =
      first.assigneeId === ctx.me.id
        ? ctx.t('decide.then.you')
        : ctx.t('decide.person', { name: nameOf(ctx.household, first.assigneeId) });
    lines.push(
      first.start
        ? ctx.t('decide.then.first', { who, what, when: dayTime(ctx, first.start) })
        : ctx.t('decide.then.firstUntimed', { who, what }),
    );
    if (preview.steps.length > 1) {
      lines.push(ctx.t('decide.then.more', { count: preview.steps.length - 1 }));
    }
    if (first.external) lines.push(ctx.t('decide.then.waitReply'));
  }
  // 決め時は、大人の誰かが間に合う最後。自分の分が先に過ぎる時は、後まで間に合う人を添える。
  if (preview.later) {
    lines.push(
      ctx.t('decide.then.later', {
        name: ctx.t('decide.person', { name: nameOf(ctx.household, preview.later.memberId) }),
        when: dayTime(ctx, preview.later.start),
      }),
    );
  }
  for (const request of preview.cancels) {
    lines.push(ctx.t('decide.then.cancel', { to: nameOf(ctx.household, request.to) }));
  }
  // 選ぶと、だれかが引き受けていた作業が要らなくなる（その人に知らせる）。今の計画に見つからないだけの物は、
  // 要らなくなったとは言わず、まだ要るか確かめてもらう（札・知らせと同じ）。
  for (const released of preview.released ?? []) {
    const what = releasedTitle(ctx, released);
    const check = released.reason === 'unconfirmed';
    lines.push(
      released.assigneeId === ctx.me.id
        ? ctx.t(check ? 'decide.then.releasedCheckYou' : 'decide.then.releasedYou', { what })
        : ctx.t(check ? 'decide.then.releasedCheck' : 'decide.then.released', {
            name: ctx.t('decide.person', { name: nameOf(ctx.household, released.assigneeId) }),
            what,
          }),
    );
  }
  if (preview.moved.length > 0) {
    lines.push(ctx.t('decide.then.moved', { count: preview.moved.length }));
  }
  return lines;
}

function Consequences({ ctx, preview }: { ctx: Ctx; preview: ChoicePreview }) {
  const lines = previewLines(ctx, preview);
  if (lines.length === 0) return null;
  const warn = (preview.issues ?? []).length > 0 || preview.conflicts.length > 0;
  return (
    <span
      className={`mt-1 flex flex-col gap-0.5 rounded-xl px-3 py-2 text-sm ${warn ? 'bg-warn-soft text-warn' : 'bg-paper'}`}
    >
      <span className="font-bold text-sub">{ctx.t('decide.then.label')}</span>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

function OptionRow({
  ctx,
  option,
  arrangement,
  preview,
  waiting,
  onChoose,
}: {
  ctx: Ctx;
  option: OptionPlan;
  arrangement: Arrangement;
  preview?: ChoicePreview;
  /** 「選んだら」がまだ無い（読んでいる・読めなかった・この手の分を出せなかった）。その間は選べない。 */
  waiting?: 'loading' | 'failed' | 'missing';
  onChoose: () => void;
}) {
  const left = option.decisionDeadline
    ? daysBetween(ctx.now, option.decisionDeadline, ctx.tz)
    : undefined;
  const urgent = left !== undefined && left <= 5 && !option.expired;
  const current = arrangement.chosenOptionKey === option.key;
  const backup = arrangement.backupOptionKeys.includes(option.key);
  // 勧めるのは、まだ何も進めていない時だけ（エンジンが決まりで選ぶ。理由も決まりから）。
  const recommended = arrangement.recommendedOptionKey === option.key;
  // 人に頼む手には、いつまでに返事が要るかを添える（頼む文と同じ：断られた時に移る手の決め時の前の晩）。
  // 勧めとは別の、その手の事実として書く。
  const reply =
    option.titleKey === 'option.askHelper' && !option.expired
      ? replyBy(ctx, arrangement, option.key)
      : undefined;
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={option.expired || current || waiting !== undefined}
      className={`flex w-full items-center gap-2.5 rounded-[18px] border bg-white px-4 py-3.5 text-left disabled:opacity-55 ${recommended ? 'border-accent-line' : 'border-line'}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-round text-xl leading-snug font-bold">
            {optionTitle(ctx, option)}
          </span>
          {recommended && <Badge accent>{ctx.t('decide.recommended')}</Badge>}
          {current && <Badge>{ctx.t('decide.current')}</Badge>}
          {backup && <Badge>{ctx.t('decide.backup')}</Badge>}
        </span>
        {recommended && arrangement.recommendedReason && (
          <span className="text-sm text-accent-dark">
            {ctx.t(`decide.because.${arrangement.recommendedReason}`)}
          </span>
        )}
        {option.expired ? (
          <span className="text-[15px] font-bold text-sub">{ctx.t('decide.expired')}</span>
        ) : option.decisionDeadline ? (
          <span
            className={`flex flex-wrap items-center gap-1.5 text-[15px] font-bold ${urgent ? 'text-warn' : ''}`}
          >
            <Icon path={ICON.clock} size={18} />
            {ctx.t('decide.by', { deadline: dayTime(ctx, option.decisionDeadline) })}
            {urgent && left !== undefined && (
              <span className="rounded-full bg-warn-soft px-2 text-[13px]">
                {ctx.t('decide.daysLeft', { count: left })}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[15px] text-sub">
            {ctx.t(option.noSlot ? 'decide.noSlot' : 'decide.unknownDeadline')}
          </span>
        )}
        <span className="text-sm text-sub">{optionNote(ctx, option)}</span>
        {reply && (
          <span className="text-sm">
            {reply.evening
              ? ctx.t('decide.replyBy', {
                  night: day(ctx, reply.evening),
                  fallback: optionTitle(ctx, reply.fallback),
                })
              : ctx.t('decide.replySoon', {
                  deadline: dayTime(ctx, reply.deadline),
                  fallback: optionTitle(ctx, reply.fallback),
                })}
          </span>
        )}
        {preview && !option.expired && <Consequences ctx={ctx} preview={preview} />}
        {waiting && !option.expired && !current && (
          <span className="mt-1 rounded-xl bg-paper px-3 py-2 text-sm text-sub">
            {ctx.t(`decide.waiting.${waiting}`)}
          </span>
        )}
      </span>
      <span className="text-sub">
        <Icon path={ICON.chevron} size={22} />
      </span>
    </button>
  );
}

// ── 頼む（外に出す文） ──────────────────────────────

/** 外に出す文を、端末の共有（LINE など）かコピーで渡す。送るのは家族。 */
function DraftActions({ ctx, draft }: { ctx: Ctx; draft: string }) {
  // 何が起きたかは、その時の文と一緒に持つ（言葉の切り替え等で文が替わったら、前の結果を見せない。
  // 遅れて終わった前の書き込みも、今の文の結果にしない）。
  const [done, setDone] = useState<{ draft: string; result: 'copied' | 'paste' | 'failed' }>();
  const result = done?.draft === draft ? done.result : undefined;
  const write = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };
  const share = async () => {
    const text = draft;
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (error) {
        // 中断された時（家族がやめた、または送れる先が無い。規格では見分けられない）は、そのまま（隣の
        // コピーは使える）。ほかの理由で共有が使えなかった時は、コピーに切り替える。
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    setDone({ draft: text, result: (await write(text)) ? 'paste' : 'failed' });
  };
  const copy = async () => {
    const text = draft;
    setDone({ draft: text, result: (await write(text)) ? 'copied' : 'failed' });
  };
  return (
    <>
      <Row>
        <Button onClick={share}>{ctx.t('ask.share')}</Button>
        <Button kind="secondary" onClick={copy}>
          {ctx.t(result === 'copied' || result === 'paste' ? 'ask.copied' : 'ask.copy')}
        </Button>
      </Row>
      {result === 'paste' && <Text>{ctx.t('ask.pasteToSend')}</Text>}
      {result === 'failed' && <Text>{ctx.t('ask.copyFailed')}</Text>}
    </>
  );
}

export function AskScreen({ ctx, taskKey }: { ctx: Ctx; taskKey: string }) {
  const task = ctx.plan.tasks.find((t) => t.key === taskKey);
  if (!task) return <Missing ctx={ctx} />;
  const helper = helperOf(ctx, task);
  const draft = askDraft(ctx, task);
  // 送ったと記録する。控え（相手・根拠・条件・時間）は、サーバーが今の計画から作る。見せた文の頼む時間を
  // 付ける（見せた後に日が直されていたら、サーバーが断る）。
  const sent = async () => {
    const result = await ctx.send(sentCommand(ctx, task));
    if (succeeded(result)) ctx.go({ name: 'today' });
  };
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={taskTitle(ctx, task)}
        title={ctx.t('ask.title')}
      />
      <Main>
        <Text quiet>{ctx.t('ask.body', { name: helper?.name ?? '' })}</Text>
        <Card>
          <span className="flex items-center gap-1.5 text-sm font-bold text-sub">
            <Icon path={ICON.message} size={18} />
            {ctx.t('ask.draft')}
          </span>
          <p className="whitespace-pre-line text-base leading-relaxed">{draft}</p>
          <Text quiet>{ctx.t('ask.editable')}</Text>
        </Card>
        <DraftActions ctx={ctx} draft={draft} />
        <Button kind="secondary" onClick={() => void sent()}>
          {ctx.t('ask.sent')}
        </Button>
        <Card tone="plain" className="bg-paper">
          <Label tone="accent">{ctx.t('ask.nextLabel')}</Label>
          <Text>{ctx.t('ask.next1')}</Text>
          <Text>{ctx.t('ask.next2')}</Text>
        </Card>
      </Main>
    </>
  );
}

function requestId(): string {
  try {
    return `r-${crypto.randomUUID()}`;
  } catch {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// ── よてい ──────────────────────────────

export function WeekScreen({ ctx }: { ctx: Ctx }) {
  const today = localDate(ctx.now, ctx.tz);
  // きょうから七日と、その後の七日（暦の週にしない。日曜の夜に、終わる週の空の日を並べない）。
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(today, i));
  const later = Array.from({ length: 7 }, (_, i) => addDaysIso(today, i + 7));
  // 決め時を出す手：お勧め・予備と、返事を待つ間は、選んでいない手のうち次に消える物（断られた時の次の手）。
  const deadlineKeys = new Set<string>();
  for (const arrangement of ctx.plan.arrangements) {
    if (!arrangement.live) continue;
    if (arrangement.recommendedOptionKey) deadlineKeys.add(arrangement.recommendedOptionKey);
    for (const key of arrangement.backupOptionKeys) deadlineKeys.add(key);
    if (arrangement.status !== 'dependsOnReply') continue;
    const next = arrangement.options
      .filter(
        (o) =>
          !o.expired &&
          o.decisionDeadline !== undefined &&
          o.key !== arrangement.chosenOptionKey &&
          !arrangement.backupOptionKeys.includes(o.key),
      )
      .sort(
        (a, b) =>
          toEpochMinutes(a.decisionDeadline ?? '') - toEpochMinutes(b.decisionDeadline ?? ''),
      )[0];
    if (next) deadlineKeys.add(next.key);
  }
  const linesFor = (date: string) => {
    const lines: string[] = [];
    for (const { item, live, conditional, trusted, when: condition } of ctx.items) {
      if (!live || item.interpretation.date !== date) continue;
      if (item.kind === 'event' || item.kind === 'dayChange' || item.kind === 'test') {
        const what = item.interpretation.what ?? item.written;
        const when = whenText(ctx, condition) ?? ctx.t('say.conditional');
        // 確かでない予定を、決まった予定と同じ形で見せない。確かめていない上に条件しだいなら、両方を書く。
        lines.push(
          !trusted
            ? conditional
              ? ctx.t('week.unconfirmedConditional', { what, when })
              : ctx.t('week.unconfirmed', { what })
            : conditional
              ? ctx.t('week.conditional', { what, when })
              : what,
        );
      }
    }
    for (const task of ctx.plan.tasks) {
      if (!task.live || task.commitment !== 'accepted') continue;
      // 日だけの当番は、時刻なしで、その日に出す。
      if (task.timing !== 'day' || !task.earliestStart) continue;
      if (localDate(task.earliestStart, ctx.tz) !== date) continue;
      lines.push(
        ctx.t('week.taskDay', {
          name: nameOf(ctx.household, task.assigneeId),
          what: taskTitle(ctx, task),
        }),
      );
    }
    for (const task of ctx.plan.tasks) {
      if (!task.live || !task.start || localDate(task.start, ctx.tz) !== date) continue;
      if (task.commitment !== 'accepted' && task.commitment !== 'done') continue;
      // 引き受けた後に中身が変わった作業は、確かめ直すまで、決まった予定として見せない。
      lines.push(
        ctx.t(task.reconfirm ? 'week.taskReconfirm' : 'week.task', {
          name: nameOf(ctx.household, task.assigneeId),
          what: taskTitle(ctx, task),
          time: time(ctx, task.start),
        }),
      );
    }
    for (const arrangement of ctx.plan.arrangements) {
      if (!arrangement.live) continue;
      for (const option of arrangement.options) {
        if (option.expired || !option.decisionDeadline) continue;
        if (localDate(option.decisionDeadline, ctx.tz) !== date) continue;
        if (!deadlineKeys.has(option.key)) continue;
        lines.push(ctx.t('week.deadline', { option: optionTitle(ctx, option) }));
      }
    }
    return lines;
  };
  return (
    <>
      <Header
        eyebrow={`${day(ctx, days[0] ?? today)} – ${day(ctx, days[6] ?? today)}`}
        title={ctx.t('week.title')}
      />
      <Main>
        <Card className="gap-0 px-1.5 py-2">
          {days.map((date) => {
            const lines = linesFor(date);
            const isToday = date === today;
            return (
              <div
                key={date}
                className={`flex gap-3 rounded-[14px] px-2.5 py-2 ${isToday ? 'bg-accent-soft' : ''}`}
              >
                <span className="flex w-12 flex-none flex-col items-center leading-tight">
                  <span className="font-round text-xl font-bold tabular-nums">
                    {Number(date.slice(8))}
                  </span>
                  <span className="text-[13px] text-sub">
                    {day(ctx, date)
                      .replace(/^.*（|）$/g, '')
                      .replace(/^\w+ .*$/, (s) => s.split(' ')[0] ?? s)}
                  </span>
                  {isToday && (
                    <span className="text-xs font-bold text-accent">{ctx.t('week.today')}</span>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  {lines.length === 0 ? (
                    <span className="text-[15px] text-sub">{ctx.t('week.none')}</span>
                  ) : (
                    lines.map((line) => (
                      <span key={line} className="text-base leading-normal">
                        {line}
                      </span>
                    ))
                  )}
                </span>
              </div>
            );
          })}
        </Card>
        <Card className="gap-0.5">
          <Label tone="sub">{ctx.t('week.later')}</Label>
          {later
            .map((date) => ({ date, lines: linesFor(date) }))
            .filter((d) => d.lines.length > 0)
            .map((d, index, all) => (
              <Pair
                key={d.date}
                left={day(ctx, d.date)}
                right={d.lines.join(ctx.t('list.separator'))}
                last={index === all.length - 1}
              />
            ))}
        </Card>
      </Main>
    </>
  );
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── 取り込んだお知らせ ──────────────────────────────

export function SourcesScreen(props: { ctx: Ctx; sourceId?: string; highlight?: string[] }) {
  const { ctx } = props;
  const sources = [...ctx.sources.values()].sort((a, b) =>
    b.receivedAt.localeCompare(a.receivedAt),
  );
  const shown = props.sourceId ? sources.filter((s) => s.id === props.sourceId) : sources;
  const highlight = new Set(props.highlight ?? []);
  const input = ctx.read ? (
    <NoticeInputCard ctx={ctx} read={ctx.read} />
  ) : (
    <Card tone="accent">
      <Label tone="accent">{ctx.t('sources.snapLabel')}</Label>
      <Text>{ctx.t('sources.snapBody')}</Text>
    </Card>
  );
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('sources.eyebrow')}
        title={ctx.t('sources.title')}
      />
      <Main>
        {/* 一つのお知らせを開いた時（読み終えた直後など）は、読み取りの結果を先に見せる。 */}
        {!props.sourceId && input}
        {/* お知らせごと消した出典は、見せる物に来ない（原文を出さない）。 */}
        {props.sourceId && shown.length === 0 && (
          <Card>
            <Text quiet>{ctx.t('sources.gone')}</Text>
          </Card>
        )}
        {shown.map((source) => {
          const reading = ctx.readings.find((r) => r.sourceId === source.id);
          const check = new Set(reading?.check ?? []);
          const statusOf = sentenceStatus(ctx, source.id);
          return (
            <Card key={source.id}>
              <Label tone="sub">
                {ctx.t('sources.received', { at: dayTime(ctx, source.receivedAt) })}
              </Label>
              <Title>{source.title ?? ctx.t('sources.untitled')}</Title>
              {source.medium === 'photo' && <Text quiet>{ctx.t('sources.fromPhoto')}</Text>}
              {reading?.checkAll ? (
                <Text>{ctx.t('sources.checkAll')}</Text>
              ) : (
                check.size > 0 && <Text>{ctx.t('sources.check', { count: check.size })}</Text>
              )}
              <div className="flex flex-col gap-1">
                {source.sentences.map((sentence) => {
                  const read = statusOf(sentence.id);
                  const status = check.has(sentence.id) ? 'check' : read?.status;
                  // 読んだ日付も並べ、原文と見比べられるようにする。
                  const dates = read?.dates.map((d) => day(ctx, d)) ?? [];
                  return (
                    <p
                      key={sentence.id}
                      className={`rounded-lg px-1.5 text-base leading-relaxed ${highlight.has(sentence.id) ? 'bg-bag font-bold' : ''} ${status === 'check' ? 'border-l-4 border-warn' : ''}`}
                    >
                      {sentence.text}
                      {status && (
                        <span
                          className={`ml-1.5 whitespace-nowrap text-xs font-bold ${STATUS_TONE[status]}`}
                        >
                          {dates.length > 0
                            ? ctx.t('sources.statusOn', {
                                status: ctx.t(`sources.status.${status}`),
                                dates: new Intl.ListFormat(ctx.lang).format(dates),
                              })
                            : ctx.t(`sources.status.${status}`)}
                        </span>
                      )}
                      {/* ほかの家の番の事項ごとに直せるようにする（同じ文のほかの事項を計画に入れていても。
                          「うちの番ではない」の押し違いも、ここから戻す）。 */}
                      {read?.others.map(({ itemId, audience }) => (
                        <button
                          key={itemId}
                          type="button"
                          onClick={() =>
                            void ctx.send({
                              type: 'stateTurn',
                              itemId,
                              ours: true,
                              seen: { throughSeq: ctx.plan.throughSeq },
                            })
                          }
                          className="ml-1.5 min-h-11 text-xs font-bold text-accent underline"
                        >
                          {ctx.t('sources.ours', { audience })}
                        </button>
                      ))}
                      {/* 「今回は要らない」と言った送り迎えも、ここから言い直せる（押し違い・予定の変更）。 */}
                      {read?.escortsOff.map(({ itemId, leg }) => (
                        <button
                          key={`${itemId}:${leg}`}
                          type="button"
                          onClick={() =>
                            void ctx.send({
                              type: 'stateEscort',
                              itemId,
                              leg,
                              needed: true,
                              seen: { throughSeq: ctx.plan.throughSeq },
                            })
                          }
                          className="ml-1.5 min-h-11 text-xs font-bold text-accent underline"
                        >
                          {ctx.t(leg === 'to' ? 'sources.escortOn.to' : 'sources.escortOn.from')}
                        </button>
                      ))}
                    </p>
                  );
                })}
              </div>
              {props.sourceId && (
                <Button kind="secondary" onClick={() => ctx.go({ name: 'today' })}>
                  {ctx.t('sources.toToday')}
                </Button>
              )}
              {reading && (
                <Text quiet>
                  {reading.origin === 'live'
                    ? ctx.t('sources.live', { model: reading.model })
                    : reading.origin === 'recorded'
                      ? ctx.t('sources.recorded', { model: reading.model })
                      : ctx.t('sources.handWritten')}
                </Text>
              )}
            </Card>
          );
        })}
        {props.sourceId && input}
      </Main>
    </>
  );
}

/** 文の印の色：確かめる（警告）、計画に入れた・よていに出す（印）、読んだだけ（控えめ）。 */
const STATUS_TONE = {
  check: 'text-warn',
  plan: 'text-accent',
  week: 'text-accent',
  readOnly: 'text-sub',
  notOurs: 'text-sub',
  statedNotOurs: 'text-sub',
  oursUnconfirmed: 'text-warn',
} as const;

/** よていに出す事項の種類（日付があれば）。 */
const WEEK_KINDS = new Set(['event', 'dayChange', 'test']);

/**
 * 原文の文ごとに、そこから読んだ事項を何にしたか：作業・手配のある要件にした（計画に入れた）、よていに
 * 出す、読んだだけ（まだ計画にも知らせにもしていない）。事項の無い文は無し。読み取れた全てを計画にできる
 * とは限らないので、「何もしない」と「まだできない」を家族が見分けられるようにする。
 */
function sentenceStatus(ctx: Ctx, sourceId: string) {
  // 計画に入れた：家族の目に入る次の一歩がある（今の案の作業、選べる・返事しだい・先に聞く手配、問い、
  // 「このままでは間に合いません」の札）。札の出ない判断できない手配だけなら、次の一歩は無いので「読んだだけ」。
  const stuck = new Set(
    ctx.today.main.flatMap((c) => (c.kind === 'stuck' ? [c.arrangement.key] : [])),
  );
  const stepped = new Set(
    ctx.plan.arrangements
      .filter(
        (a) =>
          a.live &&
          (a.status === 'decidable' ||
            a.status === 'dependsOnReply' ||
            a.status === 'askFirst' ||
            stuck.has(a.key)),
      )
      .map((a) => a.key),
  );
  const asked = new Set(ctx.plan.questions.flatMap((q) => q.affects));
  const acted = new Set(
    ctx.plan.requirements
      .filter(
        (r) =>
          r.live &&
          (ctx.plan.tasks.some(
            (t) => t.live && t.basis.requirementKey === r.key && isActiveTask(ctx.plan, t),
          ) ||
            ctx.plan.arrangements.some(
              (a) => a.requirementKey === r.key && (stepped.has(a.key) || asked.has(a.key)),
            )),
      )
      .flatMap((r) => r.basis.itemIds),
  );
  const items = ctx.items.filter((e) => e.live && e.item.sourceId === sourceId);
  return (
    sentenceId: string,
  ):
    | {
        status: 'plan' | 'week' | 'notOurs' | 'statedNotOurs' | 'oursUnconfirmed' | 'readOnly';
        dates: string[];
        others: { itemId: string; audience: string }[];
        /** 今回は要らないと言った送り迎えの方（言い直せるようにする）。 */
        escortsOff: { itemId: string; leg: 'to' | 'from' }[];
      }
    | undefined => {
    const here = items.filter((e) => e.item.sentenceIds.includes(sentenceId));
    if (here.length === 0) return undefined;
    const dates = [
      ...new Set(
        here.flatMap(({ item }) => [
          item.interpretation.date,
          item.interpretation.deadline?.slice(0, 10),
        ]),
      ),
    ]
      .filter((d): d is string => d !== undefined)
      .sort();
    // うちの番かは、サーバーのエンジンが決めた物（同じお知らせのほかの行と、家族の言明を見た結果）を使う。
    const othersHere = here.filter((e) => e.turn === 'others');
    const others = othersHere.map((e) => ({
      itemId: e.item.id,
      audience: e.item.interpretation.audience ?? '',
    }));
    const escortsOff = here.flatMap((e) =>
      (e.escort?.legs ?? [])
        .filter((l) => l.stated && !l.needed)
        .map((l) => ({ itemId: e.item.id, leg: l.leg })),
    );
    const status = here.some((e) => acted.has(e.item.id))
      ? 'plan'
      : here.some((e) => WEEK_KINDS.has(e.item.kind) && e.item.interpretation.date)
        ? 'week'
        : // 家の人の当番でも、ほかの家の番の物は作業にしない。そう読んだ（家族がそう言った）と見せ、うちの
          // 番なら直せるようにする（読んだ決まりは推し量りで、家族の言明にも押し違いがあるので）。
          othersHere.some((e) => !e.turnStated)
          ? 'notOurs'
          : othersHere.length > 0
            ? 'statedNotOurs'
            : // 「うちの番です」と言っても、読み取りが推定のままの物は作業にしない（推定の日を確かな物に
              // しない）。そう見せる。
              here.some((e) => e.turn === 'ours' && e.turnStated && !e.trusted)
              ? 'oursUnconfirmed'
              : 'readOnly';
    return { status, dates, others, escortsOff };
  };
}

/** お知らせの出どころ（読み取りが、誰からの物かを知るため）。 */
const SENDERS = ['school', 'nursery', 'afterSchoolCare', 'club', 'workplace', 'family', 'other'];

/**
 * お知らせの文を入れる。貼るか、キーボードのマイクで話す（携帯の音声入力をそのまま使う）。読めたら
 * 「きょう」に戻り、決めることと期限が出る。読む間は押せない。
 */
/** 作業・頼み事が要る日（子の居場所の日、物の要る日）。 */
function needDay(ctx: Ctx, basis: Task['basis']): string | undefined {
  const arrangement = ctx.plan.arrangements.find((a) => a.key === basis.arrangementKey);
  if (arrangement) return day(ctx, arrangement.start);
  const requirement = ctx.plan.requirements.find((r) => r.key === basis.requirementKey);
  const date = requirement?.date ?? requirement?.by;
  return date ? day(ctx, date) : undefined;
}

/**
 * 作業の要る日。書かれた時刻の決まった作業（当番）は、書かれた時間も添える（同じ日の二回を見分ける）。
 */
function taskDay(ctx: Ctx, task: Task): string | undefined {
  // 日の無い作業（日を決められない迎えを含む）に、要件の日を作業の日として添えない。
  if (task.timing === 'undated') return undefined;
  const start = task.earliestStart;
  if (task.timing === 'fixed' && start && task.deadline) return writtenWhen(ctx, task);
  if (task.timing === 'fixedEndEstimated' && start) {
    return ctx.t('card.timing.from', { day: day(ctx, start), from: time(ctx, start) });
  }
  return needDay(ctx, task.basis);
}

/** 日付があれば日付つきの文言（{{date}}）を使う（文をつないで作らない）。 */
const dated = (ctx: Ctx, key: string, params: Record<string, string>, date?: string) =>
  date ? ctx.t(`${key}_dated`, { ...params, date }) : ctx.t(key, params);

/**
 * 頼んだ時間（送ったと記録した時の計画の控え。家族が実際に送った文は、家族が直せるので確かめて
 * いない）。同じ人への同じ日の頼み事を、時間で見分けられるようにする。日を
 * またぐ時は、終わりにも日を付ける。
 */
function requestWhen(ctx: Ctx, request: { window?: { start: string; end: string } }) {
  const window = request.window;
  if (!window) return undefined;
  return ctx.t('card.proposal.when', {
    day: day(ctx, window.start),
    from: time(ctx, window.start),
    to:
      day(ctx, window.end) === day(ctx, window.start)
        ? time(ctx, window.end)
        : dayTime(ctx, window.end),
  });
}

/** 頼み事の中身（何のために頼んだか：頼み事の根拠の事項）と日時。事項が無ければ、中身が分からないと示す。 */
function requestBase(ctx: Ctx, request: ExternalRequest): string {
  const item = request.basis.itemIds
    .map((id) => ctx.items.find((l) => l.item.id === id)?.item)
    .find((found) => found !== undefined);
  const what = item ? (item.interpretation.what ?? item.written) : ctx.t('say.unknownRequest');
  return dated(ctx, 'say.requestFor', { what }, requestWhen(ctx, request));
}

/**
 * どの頼み事かを、家族が見て分かるように書く。同じ相手に、同じ中身・同じ日時で頼んだ物がほかにも
 * あれば、頼み事を出した手順（頼み事が覚えている作業）の名前を添える。今のほかの作業からは推さない。
 */
function requestFor(ctx: Ctx, request: ExternalRequest): string {
  const base = requestBase(ctx, request);
  const twin = ctx.plan.requests.some(
    (r) => r.requestId !== request.requestId && r.to === request.to && requestBase(ctx, r) === base,
  );
  if (!twin) return base;
  const task = ctx.plan.tasks.find((t) => t.key === request.taskKey);
  // 頼んだ日は base（送った時の控え）が持つので、題には今の手配の日を重ねない。
  const step = task ? baseTitle(ctx, task) : ctx.t('say.unknownRequest');
  return ctx.t('say.requestStep', { step, what: base });
}

/**
 * 未定の値の値（実在する日付は日で、ほかは答えの言葉で。訳が無ければ、お知らせの言葉のまま）。値は
 * モデルの書いた文字なので、日付に見えても実在しない日（2/30 等）は、別の日に直さず、そのまま書く。
 */
const valueText = (ctx: Ctx, value: string) =>
  isValidLocalDate(value) ? day(ctx, value) : ctx.t(`answer.${value}`, { defaultValue: value });

/**
 * 条件しだいの事項の条件（「学習発表会の実施日が12/5（土）なら」）。一つの値で決まらない時は、
 * 「条件しだい」とだけ書く（長い式を短く言い換えない）。
 */
function whenText(ctx: Ctx, when: ItemWhen | undefined): string | undefined {
  if (!when) return undefined;
  return ctx.t(when.not ? 'condition.unless' : 'condition.if', {
    label: when.label,
    value: valueText(ctx, when.value),
  });
}

/**
 * 作業・手配が条件しだいなら、その条件（一つの値で決まる時は「学習発表会の実施日が12/5（土）なら」、
 * 決まらなければ when は無し）。条件しだいでなければ無し。要件か手配のどちらかで見る（提出物は要件だけ）。
 */
function conditionOf(
  ctx: Ctx,
  basis: { itemIds: readonly string[]; requirementKey?: string; arrangementKey?: string },
): { when: string | undefined } | undefined {
  const requirement = ctx.plan.requirements.find((r) => r.key === basis.requirementKey);
  const arrangement = ctx.plan.arrangements.find((a) => a.key === basis.arrangementKey);
  if (requirement?.conditional !== true && arrangement?.conditional !== true) return undefined;
  const condition = basis.itemIds
    .map((id) => ctx.items.find((l) => l.item.id === id)?.when)
    .find((found) => found !== undefined);
  return { when: whenText(ctx, condition) };
}

/** 条件しだいの札の一行（確かな作業として見せない）。 */
export function ConditionLine({
  ctx,
  basis,
}: {
  ctx: Ctx;
  basis: Parameters<typeof conditionOf>[1];
}) {
  const condition = conditionOf(ctx, basis);
  if (!condition) return null;
  return (
    <Text quiet>
      {condition.when
        ? ctx.t('card.decide.conditionalWhen', { when: condition.when })
        : ctx.t('card.decide.conditional')}
    </Text>
  );
}

/** 一言の候補の説明（計画から作る。モデルの文は使わない）。 */
function proposalLabel(ctx: Ctx, proposal: ShownProposal): string {
  const { command } = proposal;
  switch (command.type) {
    case 'commitment':
    case 'recordSent': {
      const task = ctx.plan.tasks.find((t) => t.key === command.taskKey);
      // 要る日は dated が添えるので、題には日を重ねない。
      const what = task ? baseTitle(ctx, task) : '';
      const action = command.type === 'recordSent' ? 'sent' : command.action;
      return dated(ctx, `say.do.${action}`, { what }, task && taskDay(ctx, task));
    }
    case 'recordReply':
    case 'recordCancellationSent': {
      const request = ctx.plan.requests.find((r) => r.requestId === command.requestId);
      const name = nameOf(ctx.household, request?.to);
      const key =
        command.type === 'recordCancellationSent'
          ? 'say.do.cancelSent'
          : command.reply === 'yes'
            ? 'say.do.replyYes'
            : 'say.do.replyNo';
      // 頼んだ日時は、送ったと記録した時の控え（今の手配の日ではない）。
      return dated(ctx, key, { name }, request && requestFor(ctx, request));
    }
    case 'answer': {
      // 持ち物の「家にあるか」の値なら、問いの札と同じ言葉で（画面の言葉で、品物と要る日を添えて。同じ
      // 品物が別の日にも要る時に、どちらに答えるかを見分ける）。
      const requirement = ctx.plan.requirements.find(
        (r) => r.atHomeUnknownId === command.unknownId,
      );
      const label = requirement
        ? ctx.t('card.question.atHome', { what: requirement.what })
        : (proposal.label ?? '');
      return dated(
        ctx,
        'say.do.answer',
        { label, value: valueText(ctx, command.value) },
        requirement?.by ? due(ctx, requirement.by, requirement.basis.itemIds) : undefined,
      );
    }
    default:
      return '';
  }
}

/** 問いの答え：一言が指した事項・作業・頼み事を、今の計画の状態で並べる。 */
function SayAnswer({
  ctx,
  refs,
}: {
  ctx: Ctx;
  refs: Extract<Heard, { kind: 'question' }>['refs'];
}) {
  // 今も当てはまる事項だけ（条件の決まった・取り消された事項を、予定として見せない）。
  const items = refs.itemIds.flatMap((id) => ctx.items.filter((l) => l.item.id === id && l.live));
  const tasks = refs.taskKeys.flatMap((key) => ctx.plan.tasks.filter((t) => t.key === key));
  const requests = refs.requestIds.flatMap((id) =>
    ctx.plan.requests.filter((r) => r.requestId === id),
  );
  if (items.length + tasks.length + requests.length === 0) {
    return <Text>{ctx.t('say.nothingFound')}</Text>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Text quiet>{ctx.t('say.answer')}</Text>
      <ul className="flex flex-col gap-2">
        {items.map(({ item, conditional, trusted, when: condition }) => {
          const when = item.interpretation.date ?? item.interpretation.deadline;
          return (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
              <span>
                {dated(
                  ctx,
                  'say.item',
                  { what: item.interpretation.what ?? item.written },
                  when ? day(ctx, when) : undefined,
                )}
              </span>
              {conditional && (
                <span className="text-sub text-sm">
                  {whenText(ctx, condition) ?? ctx.t('say.conditional')}
                </span>
              )}
              {/* 推定・食い違いは、家族が確かめるまで確かな事実として見せない。 */}
              {!trusted && (
                <span className="text-sub text-sm">
                  {ctx.t(item.evidence === 'inferred' ? 'say.inferred' : 'say.unconfirmed')}
                </span>
              )}
              <MoreLink onClick={() => ctx.go({ name: 'sources', sourceId: item.sourceId })}>
                {ctx.t('say.source')}
              </MoreLink>
            </li>
          );
        })}
        {tasks.map((task) => (
          <li key={task.key}>
            {dated(
              ctx,
              'say.task',
              {
                // 要る日は dated が添えるので、題には日を重ねない。
                what: baseTitle(ctx, task),
                who: task.assigneeId
                  ? nameOf(ctx.household, task.assigneeId)
                  : ctx.t('say.unassigned'),
                state: ctx.t(`say.taskState.${task.commitment}`),
              },
              taskDay(ctx, task),
            )}
          </li>
        ))}
        {requests.map((request) => (
          <li key={request.requestId} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {dated(
                ctx,
                'say.request',
                {
                  name: nameOf(ctx.household, request.to),
                  state: ctx.t(`say.requestState.${request.state}`),
                },
                requestFor(ctx, request),
              )}
            </span>
            {/* 返事の状態と、まだ要るかは別のこと。要らなくなった頼み事は、取り消しを伝える。 */}
            {!request.live && request.state !== 'cancelled' && (
              <span className="text-sub text-sm">{ctx.t('say.noLongerNeeded')}</span>
            )}
            {request.live && request.needsCheck && (
              <span className="text-sub text-sm">{ctx.t('say.needsCheck')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 一言の答え（候補・聞き返し・問いの答え・受け付けられない時）。押すまで何も記録しない。 */
export function SayReply({
  ctx,
  reply,
  busy,
  onRecord,
  onClear,
}: {
  ctx: Ctx;
  reply: Heard;
  busy: boolean;
  onRecord: (proposal: ShownProposal) => void;
  onClear: () => void;
}) {
  // 選べるのは、画面で見分けられる候補だけ（同じ文の候補は、押してもどれが記録されるか分からない）。
  const labeled =
    reply.kind === 'clarify'
      ? reply.proposals.map((proposal) => ({ proposal, label: proposalLabel(ctx, proposal) }))
      : [];
  // 一つだけの候補でも、同じ文になる別の対象があれば、どれが記録されるか分からないので記録させない（札から
  // 記録してもらう）。同じ品物を同じ日に求める「家にあるか」と、同じ題・同じ日（当番は同じ時間）の別の作業。
  // 返すのは、記録させない訳を書く文言のキー。
  const sameAsOther = (proposal: ShownProposal): string | undefined => {
    const { command } = proposal;
    const label = proposalLabel(ctx, proposal);
    if (command.type === 'commitment' || command.type === 'recordSent') {
      const twin = ctx.plan.tasks.some(
        (t) =>
          t.live &&
          t.key !== command.taskKey &&
          proposalLabel(ctx, { ...proposal, command: { ...command, taskKey: t.key } }) === label,
      );
      return twin ? 'say.sameTask' : undefined;
    }
    if (command.type !== 'answer') return undefined;
    const twin = ctx.plan.requirements.some(
      (r) =>
        r.live &&
        r.atHomeUnknownId !== undefined &&
        r.atHomeUnknownId !== command.unknownId &&
        proposalLabel(ctx, {
          ...proposal,
          command: { ...command, unknownId: r.atHomeUnknownId },
        }) === label,
    );
    return twin ? 'say.sameTarget' : undefined;
  };
  const choices = labeled.filter(
    (c) => labeled.filter((o) => o.label === c.label).length === 1 && !sameAsOther(c.proposal),
  );
  return (
    <>
      {reply.kind === 'change' &&
        reply.proposals.map((proposal) => {
          const blocked = sameAsOther(proposal);
          return (
            <div key={proposal.id} className="flex flex-col gap-2">
              <Text quiet>{ctx.t(blocked ?? 'say.confirm')}</Text>
              <Title>{proposalLabel(ctx, proposal)}</Title>
              <Row>
                {!blocked && (
                  <Button onClick={() => onRecord(proposal)} disabled={busy}>
                    {ctx.t('say.record')}
                  </Button>
                )}
                <Button kind="secondary" onClick={onClear} disabled={busy}>
                  {ctx.t('say.cancel')}
                </Button>
              </Row>
            </div>
          );
        })}
      {reply.kind === 'clarify' && (
        <div className="flex flex-col gap-2">
          {reply.reason === 'otherAdultsTask' && <Text>{ctx.t('say.otherAdult')}</Text>}
          {(reply.reason === 'unowned' || reply.unowned) && <Text>{ctx.t('say.unowned')}</Text>}
          {choices.length > 0 && (
            <>
              <Text quiet>{ctx.t('say.which')}</Text>
              {choices.map(({ proposal, label }) => (
                <Button
                  key={proposal.id}
                  kind="secondary"
                  onClick={() => onRecord(proposal)}
                  disabled={busy}
                >
                  {label}
                </Button>
              ))}
              <Button kind="secondary" onClick={onClear} disabled={busy}>
                {ctx.t('say.none')}
              </Button>
            </>
          )}
          {labeled.length > choices.length && (
            <Text>
              {ctx.t(
                labeled.map((c) => sameAsOther(c.proposal)).find((key) => key !== undefined) ??
                  'say.lookAlike',
              )}
            </Text>
          )}
          {labeled.length === 0 && reply.reason === 'ambiguous' && (
            <Text>{ctx.t('say.whichUnknown')}</Text>
          )}
        </div>
      )}
      {reply.kind === 'question' && <SayAnswer ctx={ctx} refs={reply.refs} />}
      {reply.kind === 'unsupported' && <Text>{ctx.t(`say.unsupported.${reply.reason}`)}</Text>}
    </>
  );
}

type SayState =
  | 'idle'
  | 'hearing'
  | 'recording'
  | 'recorded'
  | Exclude<HearResult['status'], 'ok'>
  | Exclude<ConfirmResult['status'], 'ok'>;

/**
 * ひとこと：家族が話した・打った一言を読み、どの作業・頼み事・値のことかを候補にして見せる。押すまで
 * 何も記録しない。候補の説明と答えの一覧は、計画から作る（モデルの書いた文は見せない）。
 */
export function SayCard({
  ctx,
  hear,
  confirm,
}: {
  ctx: Ctx;
  hear: NonNullable<Ctx['hear']>;
  confirm: NonNullable<Ctx['confirm']>;
}) {
  const [text, setText] = useState('');
  // 答えは、読んだ時の計画の版と一緒に持つ。計画が先へ進んだら（記録・答え・時計など）、古い答えを
  // 今の計画と並べて見せない（閉じて、もう一度伝えてもらう）。
  const [heard, setHeard] = useState<{ reply: Heard; throughSeq: number }>();
  const [state, setState] = useState<SayState>('idle');
  const seq = ctx.plan.throughSeq;
  const reply = heard && heard.throughSeq === seq ? heard.reply : undefined;
  const outdated = heard !== undefined && seq > heard.throughSeq;
  // 同じ文の送り直しは同じ操作 ID で（読み直さない）。
  const operation = useRef<string | undefined>(undefined);
  const busy = state === 'hearing' || state === 'recording';
  const submit = async () => {
    setState('hearing');
    setHeard(undefined);
    operation.current ??= operationId();
    const result = await hear(text, operation.current);
    if (result.status === 'ok') {
      operation.current = undefined;
      setHeard({ reply: result.reply, throughSeq: result.throughSeq });
      setState('idle');
      return;
    }
    // 前提が変わった時は、新しい操作で読み直す（同じ操作では、古い答えを返さないので先へ進めない）。
    if (result.status === 'stale') operation.current = undefined;
    setState(result.status);
  };
  const record = async (proposal: ShownProposal) => {
    setState('recording');
    const result = await confirm(proposal.id, operationId());
    if (result.status === 'uncertain') {
      // 記録したか分からない。送り直し（同じ ID）と手放しは画面の上の表示だけで行い、それまでほかの
      // 書き込みも止まる。古い答えから別の操作として押させないよう、答えを閉じる（この欄には何も残さ
      // ない。画面の上の表示で片付いた後に、古い「分からない」が残らないように）。
      setHeard(undefined);
      setState('idle');
      return;
    }
    if (result.status === 'ok') {
      setText('');
      setHeard(undefined);
      setState('recorded');
      return;
    }
    if (result.status === 'changed' || result.status === 'gone') setHeard(undefined);
    setState(result.status);
  };
  const clear = () => {
    setHeard(undefined);
    setState('idle');
  };
  return (
    <Card>
      <Label tone="accent">{ctx.t('say.label')}</Label>
      {/* きょうの札を下へ押しやらないよう、欄と送る押し口を横に並べる。 */}
      <div className="flex items-stretch gap-2">
        <textarea
          value={text}
          readOnly={busy}
          onChange={(e) => {
            operation.current = undefined;
            setText(e.target.value);
          }}
          rows={2}
          maxLength={500}
          aria-label={ctx.t('say.label')}
          placeholder={ctx.t('say.placeholder')}
          className="min-w-0 flex-1 resize-none rounded-lg border border-line bg-card p-3 text-base leading-relaxed"
        />
        <div className="flex w-24">
          <Button onClick={() => void submit()} disabled={busy || text.trim().length === 0}>
            {ctx.t(state === 'hearing' ? 'say.hearing' : 'say.submit')}
          </Button>
        </div>
      </div>
      <Text quiet>{ctx.t('say.privacy')}</Text>
      {state !== 'idle' && state !== 'hearing' && state !== 'recording' && (
        <Text>{ctx.t(`say.${state}`)}</Text>
      )}
      {outdated && <Text>{ctx.t('say.outdated')}</Text>}
      {reply && (
        <SayReply
          ctx={ctx}
          reply={reply}
          busy={busy}
          onRecord={(proposal) => void record(proposal)}
          onClear={clear}
        />
      )}
    </Card>
  );
}

/** 一度に読めるお知らせの文の長さ（サーバーの上限と同じ）。 */
const MAX_NOTICE_CHARS = 4000;

function NoticeInputCard({
  ctx,
  read,
}: {
  ctx: Ctx;
  read: (input: NoticeInput) => Promise<ReadResult>;
}) {
  const [text, setText] = useState('');
  const [sender, setSender] = useState('school');
  const [state, setState] = useState<'idle' | 'reading' | ReadResult['status']>('idle');
  // 写真・PDF から書き起こした時：見比べる写真（端末の中の一時の URL だけ。どこにも残さない）と、文の欄の
  // 文がその写真から来たか。この二つと文は、書き起こせた時だけ一緒に替える（失敗・送り直しの間は、前の
  // 物をそのまま残す。違う写真と文を並べない）。書き起こせた文は、家族が直してから、写真の印を付けて読む。
  const [photo, setPhoto] = useState<{ url: string; name: string; pdf: boolean }>();
  const [fromPhoto, setFromPhoto] = useState(false);
  const [photoState, setPhotoState] = useState<
    | 'idle'
    | 'preparing'
    | 'transcribing'
    | 'empty'
    | NotUploadable
    | Exclude<PhotoResult['status'], 'ok'>
  >('idle');
  const photoUrl = useRef<string | undefined>(undefined);
  // 選んだ順の番号と、画面が出ているか（後から終わった前の選択や、閉じた後の結果を使わない）。
  const pickNumber = useRef(0);
  const mounted = useRef(true);
  // 返事が届かなかった・混んでいた時に、同じ操作 ID で送り直す物（書き起こし済みなら、もう一度は読まない）。
  const attempt = useRef<{ file: File; upload: Uploadable; operationId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
      photoUrl.current = undefined;
    };
  }, []);
  // 同じ文の送り直し（返事が届かなかった時など）は、同じ操作 ID で送る（二度読まない・二度足さない）。
  // 文か出どころを変えたら、新しい操作。
  const operation = useRef<string | undefined>(undefined);
  const change = (next: () => void) => {
    operation.current = undefined;
    next();
  };
  const clearPhoto = () => {
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = undefined;
    setPhoto(undefined);
    setFromPhoto(false);
  };
  const send = async (current: { file: File; upload: Uploadable; operationId: string }) => {
    if (!ctx.transcribe) return;
    const mine = pickNumber.current;
    setPhotoState('transcribing');
    const result = await ctx.transcribe({ ...current.upload, operationId: current.operationId });
    if (!mounted.current || pickNumber.current !== mine) return;
    if (result.status !== 'ok') {
      setPhotoState(result.status);
      return;
    }
    attempt.current = undefined;
    if (result.text.trim().length === 0) {
      setPhotoState('empty');
      return;
    }
    // 見比べる原本（写真は並べて見せ、PDF は開ける）。端末の中の一時の URL だけで、どこにも送らない。
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = URL.createObjectURL(current.file);
    setPhoto({
      url: photoUrl.current,
      name: current.file.name,
      pdf: current.file.type === 'application/pdf',
    });
    change(() => setText(result.text));
    setFromPhoto(true);
    setPhotoState('idle');
  };
  const pick = async (file: File | undefined) => {
    if (!file || !ctx.transcribe) return;
    const mine = ++pickNumber.current;
    attempt.current = undefined;
    // 縮める間から押せなくする（後から選んだ物と、前に選んだ物が入れ替わらないように）。
    setPhotoState('preparing');
    const upload = await toUploadable(file);
    if (!mounted.current || pickNumber.current !== mine) return;
    if (typeof upload === 'string') {
      setPhotoState(upload);
      return;
    }
    attempt.current = { file, upload, operationId: operationId() };
    await send(attempt.current);
  };
  const busy = state === 'reading' || photoState === 'preparing' || photoState === 'transcribing';
  // 書き起こした文は、長くても切らずに入れ、長すぎることを示す（読む前に家族が要らない所を消す）。
  const tooLong = text.length > MAX_NOTICE_CHARS;
  const count = (n: number) => new Intl.NumberFormat(ctx.lang).format(n);
  const submit = async () => {
    setState('reading');
    operation.current ??= operationId();
    const result = await read({
      text,
      sender,
      medium: fromPhoto ? 'photo' : 'text',
      operationId: operation.current,
    });
    if (result.status === 'ok') {
      operation.current = undefined;
      setText('');
      clearPhoto();
      setPhotoState('idle');
      setState('idle');
      // 読んだお知らせの文ごとに、何にしたか（計画・よてい・読んだだけ・要確認）を先に見せる。
      // 「読んだだけ」の事項は、きょうの札にならないので、ここで見ないと気づけない。
      ctx.go({ name: 'sources', sourceId: result.sourceId });
      return;
    }
    setState(result.status);
  };
  return (
    <Card tone="accent">
      <Label tone="accent">{ctx.t('input.label')}</Label>
      <Text>{ctx.t('input.help')}</Text>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-sub">{ctx.t('input.sender')}</span>
        <select
          value={sender}
          disabled={busy}
          onChange={(e) => change(() => setSender(e.target.value))}
          className="rounded-lg border border-line bg-card px-2 py-2 text-base"
        >
          {SENDERS.map((s) => (
            <option key={s} value={s}>
              {ctx.t(`input.senders.${s}`)}
            </option>
          ))}
        </select>
      </label>
      {ctx.transcribe && (
        <div className="flex flex-col gap-1">
          <label
            className={`flex min-h-[54px] cursor-pointer items-center justify-center gap-2 rounded-2xl border-[1.5px] border-btn-line bg-white px-3.5 font-round text-lg font-bold text-ink active:bg-paper ${busy ? 'pointer-events-none opacity-50' : ''}`}
          >
            <input
              type="file"
              accept="image/*,application/pdf"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // 同じ写真を選び直せるように、選んだ物を外す。
                e.target.value = '';
                void pick(file);
              }}
            />
            {ctx.t(busy && photoState !== 'idle' ? 'input.transcribing' : 'input.photo')}
          </label>
          <Text quiet>{ctx.t('input.photoPrivacy')}</Text>
        </div>
      )}
      {photo && (
        <div className="flex flex-col gap-2">
          {photo.pdf ? (
            <a
              href={photo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center self-start font-bold text-accent underline"
            >
              {ctx.t('input.pdfOpen', { name: photo.name })}
            </a>
          ) : (
            <img
              src={photo.url}
              alt={ctx.t('input.photoAlt')}
              className="max-h-[60vh] w-full rounded-lg border border-line object-contain"
            />
          )}
          {fromPhoto && <Text>{ctx.t(photo.pdf ? 'input.pdfNote' : 'input.photoNote')}</Text>}
        </div>
      )}
      {photoState !== 'idle' && photoState !== 'preparing' && photoState !== 'transcribing' && (
        <Text>{ctx.t(`input.photoStatus.${photoState}`)}</Text>
      )}
      {(photoState === 'uncertain' || photoState === 'busy' || photoState === 'failed') &&
        attempt.current && (
          <Button
            kind="secondary"
            onClick={() => {
              const current = attempt.current;
              if (current) void send(current);
            }}
          >
            {ctx.t('input.photoRetry')}
          </Button>
        )}
      <textarea
        value={text}
        readOnly={busy}
        onChange={(e) => {
          const next = e.target.value;
          change(() => setText(next));
          // 文を消し切ったら、写真の書き起こしとしては扱わない（新しく貼る・話す）。
          if (next.length === 0) clearPhoto();
        }}
        rows={6}
        maxLength={MAX_NOTICE_CHARS}
        aria-label={ctx.t('input.label')}
        placeholder={ctx.t('input.placeholder')}
        className="w-full rounded-lg border border-line bg-card p-3 text-base leading-relaxed"
      />
      <Text quiet>{ctx.t('input.clock', { now: dayTime(ctx, ctx.now) })}</Text>
      <Text quiet>{ctx.t('input.privacy')}</Text>
      {(state === 'limit' ||
        state === 'busy' ||
        state === 'uncertain' ||
        state === 'stale' ||
        state === 'failed') && <Text>{ctx.t(`input.${state}`)}</Text>}
      {tooLong && (
        <Text>
          {ctx.t('input.tooLong', { count: count(text.length), max: count(MAX_NOTICE_CHARS) })}
        </Text>
      )}
      <Button onClick={() => void submit()} disabled={busy || tooLong || text.trim().length === 0}>
        {ctx.t(state === 'reading' ? 'input.reading' : 'input.submit')}
      </Button>
    </Card>
  );
}

export function Missing({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        title={ctx.t('missing.title')}
      />
      <Main>
        <Text>{ctx.t('missing.body')}</Text>
      </Main>
    </>
  );
}
