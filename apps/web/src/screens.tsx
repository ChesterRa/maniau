// 画面：きょう・決める・頼む・よてい・お知らせ。計画と「きょう」の札はサーバーが作り、ここは見せ方と、
// 命令を送ることだけ（02-foundation §7.1・§7.2）。
import {
  type Arrangement,
  type ChangedRequirement,
  type ChangeSummary,
  type Command,
  type ExternalRequest,
  type Household,
  type Item,
  isActiveTask,
  isValidLocalDate,
  type Member,
  type OptionPlan,
  type PlanResult,
  proposalSnapshot,
  type Requirement,
  type Source,
  type Task,
  type TodayCard,
  toEpochMinutes,
} from '@maniau/core';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import {
  type ConfirmResult,
  type Heard,
  type HearResult,
  type ItemWhen,
  type NoticeInput,
  operationId,
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
  | { name: 'decide'; key: string }
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
  /** 家族の一言を読む・その候補を記録する（同じく、使える時だけ）。 */
  hear?: (text: string, operationId: string) => Promise<HearResult>;
  confirm?: (proposalId: string, operationId: string) => Promise<ConfirmResult>;
  go: (route: Route) => void;
}

const succeeded = (result: SendResult) => result.status === 'ok' || result.status === 'noop';

// ── 名前と言葉 ──────────────────────────────

const nameOf = (household: Household, id: string | undefined) =>
  household.members.find((m) => m.id === id)?.name ??
  household.places.find((p) => p.id === id)?.name ??
  '';

const childName = (household: Household) =>
  household.members.find((m) => m.kind === 'child' && m.active)?.name ?? '';

function otherAdult(household: Household, me: string): Member | undefined {
  return household.members.find((m) => m.kind === 'adult' && m.active && m.id !== me);
}

/** 画面が見せた作業の担当と状態（古い札の操作で、もう一人の操作を黙って替えないために送る）。 */
const seenOf = (task: Task) => ({
  taskKey: task.key,
  assigneeId: task.assigneeId ?? null,
  commitment: task.commitment,
});

/** 本人しかできない手順の担当（家族の情報の案の手順で決まっている。例：自分の有休の申請）。 */
function fixedAssignee(household: Household, task: Task): string | undefined {
  const step = task.step;
  if (!step) return undefined;
  return household.careOptions
    .find((o) => o.id === step.templateId)
    ?.steps.find((s) => s.id === step.stepId)?.assigneeId;
}

function templateOf(household: Household, option: OptionPlan) {
  return household.careOptions.find((o) => o.id === option.templateId);
}

function optionParams(ctx: Ctx, option: OptionPlan): Record<string, string> {
  const template = templateOf(ctx.household, option);
  const firstTask = ctx.plan.tasks.find((t) => t.key === option.taskKeys[0]);
  if (option.titleKey === 'option.paidLeave') {
    return { name: nameOf(ctx.household, template?.steps[0]?.assigneeId ?? firstTask?.assigneeId) };
  }
  if (option.titleKey === 'option.askHelper') {
    return { name: nameOf(ctx.household, template?.providerId) };
  }
  return {};
}

const optionTitle = (ctx: Ctx, option: OptionPlan) =>
  ctx.t(`${option.titleKey}.title`, optionParams(ctx, option));

function optionNote(ctx: Ctx, option: OptionPlan): string {
  const notes: string[] = [];
  if (option.cost.leaveMinutes > 0) {
    notes.push(ctx.t('cost.leave', { days: Math.round(option.cost.leaveMinutes / 480) || 1 }));
  }
  if (option.cost.helperRequests > 0) notes.push(ctx.t('cost.helper'));
  const template = templateOf(ctx.household, option);
  if (template?.extraSteps.some((s) => s.titleKey.startsWith('task.bento'))) {
    notes.push(ctx.t('cost.bento'));
  }
  return notes.join(ctx.t('list.separator'));
}

export function taskTitle(ctx: Ctx, task: Task): string {
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

const day = (ctx: Ctx, value: string) => formatDay(value, ctx.lang, ctx.tz);
const dayTime = (ctx: Ctx, value: string) => formatDayTime(value, ctx.lang, ctx.tz);
const time = (ctx: Ctx, value: string) => formatTime(value, ctx.lang, ctx.tz);

// ── 外に出す文（頼む・取り消す） ──────────────────────────────

function helperOf(ctx: Ctx, task: Task): Member | undefined {
  const id = task.external?.to;
  return ctx.household.members.find((m) => m.id === id);
}

/** 人に頼む作業（文を作って LINE などで送る）。学童・会社のような所へ出す物は、済んだと記録するだけ。 */
const asksPerson = (ctx: Ctx, task: Task) => helperOf(ctx, task) !== undefined;

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
  const parts = [
    t('draft.ask', {
      address: helper.addressAs ?? helper.name,
      date: formatLongDay(arrangement.start, lng, ctx.tz),
      from: formatTime(arrangement.start, lng, ctx.tz),
      to: formatTime(arrangement.end, lng, ctx.tz),
      child: childName(ctx.household),
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
  const asked = request.window?.start;
  if (helper) {
    const lng = outboundLanguage(helper);
    const t = ctx.outbound(lng);
    const address = helper.addressAs ?? helper.name;
    return asked
      ? t('draft.cancelHelper', { address, date: formatLongDay(asked, lng, ctx.tz) })
      : t('draft.cancelHelperUndated', { address });
  }
  const child = childName(ctx.household);
  const place = nameOf(ctx.household, request.to);
  return asked
    ? ctx.t('draft.cancelPlace', { place, child, date: formatLongDay(asked, ctx.lang, ctx.tz) })
    : ctx.t('draft.cancelPlaceUndated', { place, child });
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
  const moved = (item: ChangedRequirement) => {
    const { before, after } = item;
    const text =
      after?.by && before.by
        ? ctx.t('card.change.moved.by', {
            what: before.what,
            before: dayTime(ctx, before.by),
            after: dayTime(ctx, after.by),
          })
        : ctx.t('card.change.moved.date', {
            what: before.what,
            before: before.date ? day(ctx, before.date) : '',
            after: after?.date ? day(ctx, after.date) : '',
          });
    if (item.ready === undefined) return text;
    return `${text}${ctx.t(item.ready ? 'card.change.ready' : 'card.change.notReady')}`;
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
            <span>{moved(item)}</span>
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
    case 'cancel':
    case 'proposal':
    case 'todo':
    case 'unowned':
      return `${card.kind}:${card.task.key}`;
    case 'backup':
    case 'decide':
      return `${card.kind}:${card.arrangement.key}`;
    case 'question':
      return `${card.kind}:${card.question.key}`;
    case 'check':
    case 'waiting':
      return `${card.kind}:${card.request.requestId}`;
  }
}

function CardView({ ctx, card }: { ctx: Ctx; card: TodayCard }) {
  switch (card.kind) {
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
      return <QuestionCard ctx={ctx} card={card} />;
    case 'check':
      return <CheckCard ctx={ctx} request={card.request} />;
    default:
      return null;
  }
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
        <Button onClick={() => ctx.go({ name: 'decide', key: arrangement.key })}>
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
            child: childName(ctx.household),
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
  const answer = (value: string) =>
    void ctx.send({ type: 'answer', unknownId: question.unknownId, value });
  return (
    <Card>
      <Label tone="accent">{ctx.t('card.question.label')}</Label>
      <Title>{ctx.t('card.question.atHome', { what: requirement?.what ?? '' })}</Title>
      <Text quiet>
        {ctx.t('card.question.body', { by: requirement?.by ? day(ctx, requirement.by) : '' })}
      </Text>
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
  const done = () => void ctx.send({ type: 'commitment', taskKey: task.key, action: 'done' });
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
      {task.start && task.end && (
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
      {task.reconfirm && <Text quiet>{ctx.t('card.proposal.changed')}</Text>}
      {!shown && (
        <Text>
          {ctx.t(
            task.handoff
              ? 'card.proposal.handoff'
              : standalone
                ? 'card.proposal.unplacedDue'
                : 'card.proposal.unplaced',
          )}
        </Text>
      )}
      <Row>
        {shown && <Button onClick={accept}>{ctx.t('card.proposal.accept')}</Button>}
        {!shown && standalone && <Button onClick={done}>{ctx.t('card.proposal.done')}</Button>}
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
      {/* 案の無い作業（提出物）は、外の締切の日を出す（朝の時刻は目安なので、日だけ）。 */}
      {!option && task.deadline && (
        <Text>{ctx.t('card.unowned.by', { date: day(ctx, task.deadline) })}</Text>
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
    </Card>
  );
}

function CancelCard({ ctx, task, request }: { ctx: Ctx; task: Task; request: ExternalRequest }) {
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
          {!request.window && <Text quiet>{ctx.t('card.cancel.checkDate')}</Text>}
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
  if (card.kind === 'todo') {
    const { task } = card;
    const condition = conditionOf(ctx, task.basis);
    const external = task.external !== undefined;
    const ask = asksPerson(ctx, task);
    // 所へ出す物（学童の申込書・会社への届け）は、出した時に「送った」と記録し、相手の返事を待つ。
    const finish = () =>
      ask
        ? ctx.go({ name: 'ask', taskKey: task.key })
        : external
          ? void ctx.send({ type: 'recordSent', taskKey: task.key, requestId: requestId() })
          : void ctx.send({ type: 'commitment', taskKey: task.key, action: 'done' });
    return (
      <div className={`flex items-center gap-3 py-2.5 ${border}`}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{taskTitle(ctx, task)}</span>
          {task.start && (
            <span className="text-sm text-sub tabular-nums">{dayTime(ctx, task.start)}</span>
          )}
          {condition && (
            <span className="text-sm text-sub">{condition.when ?? ctx.t('say.conditional')}</span>
          )}
        </span>
        <button
          type="button"
          onClick={finish}
          className="min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-3 text-[15px] font-bold"
        >
          {ctx.t(ask ? 'quiet.send' : 'quiet.done')}
        </button>
      </div>
    );
  }
  return null;
}

// ── 決める ──────────────────────────────

export function DecideScreen({ ctx, arrangementKey }: { ctx: Ctx; arrangementKey: string }) {
  const arrangement = arrangementOf(ctx, arrangementKey);
  if (!arrangement) return <Missing ctx={ctx} />;
  const requirement = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey);
  const date = requirement?.date ?? arrangement.start;
  const working = ctx.household.members
    .filter((m) => m.kind === 'adult' && m.active)
    .map((m) => ctx.t('decide.person', { name: m.name }));
  const options = [...arrangement.options].sort(
    (a, b) =>
      Number(a.expired) - Number(b.expired) ||
      (a.decisionDeadline ?? '9').localeCompare(b.decisionDeadline ?? '9'),
  );
  const helperOption = options.find((o) => o.titleKey === 'option.askHelper' && !o.expired);
  // 迷った時の勧め：まず人に聞く。返事の期限は、頼む文と同じ（断られた時に移る案の前の晩）。
  const reply = helperOption && replyBy(ctx, arrangement, helperOption.key);

  // 本命に選び、作業を担当に提案する。担当が決まっている案（例：健太さんが休む）はその人に、
  // ほかは自分に。この画面は作業ごとの時刻・場所を見せていないので、ここでは引き受けない
  // （提案の札で中身を見て引き受ける。人に頼む作業は、下書きを送れば済みになる）。
  const choose = async (option: OptionPlan) => {
    const tasks = option.taskKeys
      .map((k) => ctx.plan.tasks.find((t) => t.key === k))
      .filter((t): t is Task => t !== undefined && !t.extra);
    const first = tasks[0];
    const fixed = templateOf(ctx.household, option)?.steps[0]?.assigneeId;
    const assignee = fixed ?? ctx.me.id;
    const result = await ctx.send({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: assignee,
    });
    if (!succeeded(result)) return;
    if (first && asksPerson(ctx, first) && assignee === ctx.me.id) {
      ctx.go({ name: 'ask', taskKey: first.key });
    } else ctx.go({ name: 'today' });
  };

  // 元の文へ：根拠の事項の出典（事項の ID から推し量らない。ID は中身を持たない）。
  const basisItems = ctx.items.filter(({ item }) => requirement?.basis.itemIds.includes(item.id));
  const source = basisItems[0]?.item.sourceId;
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('decide.eyebrow', { date: day(ctx, date), what: requirement?.what ?? '' })}
        title={ctx.t('decide.title', { child: childName(ctx.household) })}
      />
      <Main>
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
        {options.map((option) => (
          <OptionRow
            key={option.key}
            ctx={ctx}
            option={option}
            onChoose={() => void choose(option)}
          />
        ))}
        {helperOption && reply && (
          <Card tone="accent">
            <Label tone="accent">{ctx.t('decide.tipLabel')}</Label>
            <Text>
              {reply.evening
                ? ctx.t('decide.tip', {
                    helper: optionParams(ctx, helperOption).name ?? '',
                    night: day(ctx, reply.evening),
                    fallback: optionTitle(ctx, reply.fallback),
                  })
                : ctx.t('decide.tipSoon', {
                    helper: optionParams(ctx, helperOption).name ?? '',
                    deadline: dayTime(ctx, reply.deadline),
                    fallback: optionTitle(ctx, reply.fallback),
                  })}
            </Text>
            <Button onClick={() => void choose(helperOption)}>
              {optionTitle(ctx, helperOption)}
            </Button>
          </Card>
        )}
      </Main>
    </>
  );
}

function previousEvening(deadline: string): string {
  const date = deadline.slice(0, 10);
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function OptionRow({
  ctx,
  option,
  onChoose,
}: {
  ctx: Ctx;
  option: OptionPlan;
  onChoose: () => void;
}) {
  const left = option.decisionDeadline
    ? daysBetween(ctx.now, option.decisionDeadline, ctx.tz)
    : undefined;
  const urgent = left !== undefined && left <= 5 && !option.expired;
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={option.expired}
      className="flex w-full items-center gap-2.5 rounded-[18px] border border-line bg-white px-4 py-3.5 text-left disabled:opacity-55"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-round text-xl leading-snug font-bold">
          {optionTitle(ctx, option)}
        </span>
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
          <span className="text-[15px] text-sub">{ctx.t('decide.unknownDeadline')}</span>
        )}
        <span className="text-sm text-sub">{optionNote(ctx, option)}</span>
      </span>
      <span className="text-sub">
        <Icon path={ICON.chevron} size={22} />
      </span>
    </button>
  );
}

// ── 頼む（外に出す文） ──────────────────────────────

export function AskScreen({ ctx, taskKey }: { ctx: Ctx; taskKey: string }) {
  const task = ctx.plan.tasks.find((t) => t.key === taskKey);
  const [copied, setCopied] = useState(false);
  if (!task) return <Missing ctx={ctx} />;
  const helper = helperOf(ctx, task);
  const draft = askDraft(ctx, task);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ text: draft });
      else await navigator.clipboard.writeText(draft);
    } catch {
      // 共有をやめても、画面はそのまま。
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  // 送ったと記録する。控え（相手・根拠・条件・時間）は、サーバーが今の計画から作る。
  const sent = async () => {
    const result = await ctx.send({
      type: 'recordSent',
      taskKey: task.key,
      requestId: requestId(),
    });
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
        <Row>
          <Button onClick={share}>{ctx.t('ask.share')}</Button>
          <Button kind="secondary" onClick={copy}>
            {ctx.t(copied ? 'ask.copied' : 'ask.copy')}
          </Button>
        </Row>
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
  const start = mondayOf(today);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
  const nextWeek = Array.from({ length: 7 }, (_, i) => addDaysIso(start, i + 7));
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
        if (
          option.key !== arrangement.recommendedOptionKey &&
          !arrangement.backupOptionKeys.includes(option.key)
        )
          continue;
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
          <Label tone="sub">{ctx.t('week.next')}</Label>
          {nextWeek
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

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7;
  return addDaysIso(date, -weekday);
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
} as const;

/** よていに出す事項の種類（日付があれば）。 */
const WEEK_KINDS = new Set(['event', 'dayChange', 'test']);

/**
 * 原文の文ごとに、そこから読んだ事項を何にしたか：作業・手配のある要件にした（計画に入れた）、よていに
 * 出す、読んだだけ（まだ計画にも知らせにもしていない）。事項の無い文は無し。読み取れた全てを計画にできる
 * とは限らないので、「何もしない」と「まだできない」を家族が見分けられるようにする。
 */
function sentenceStatus(ctx: Ctx, sourceId: string) {
  // 計画に入れた：家族の目に入る次の一歩がある（今の案の作業、選べる・返事しだい・先に聞く手配、問い）。
  // まだ判断できない・このままでは無理の手配だけなら、次の一歩は無いので「読んだだけ」。
  const stepped = new Set(
    ctx.plan.arrangements
      .filter(
        (a) =>
          a.live &&
          (a.status === 'decidable' || a.status === 'dependsOnReply' || a.status === 'askFirst'),
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
  ): { status: 'plan' | 'week' | 'readOnly'; dates: string[] } | undefined => {
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
    const status = here.some((e) => acted.has(e.item.id))
      ? 'plan'
      : here.some((e) => WEEK_KINDS.has(e.item.kind) && e.item.interpretation.date)
        ? 'week'
        : 'readOnly';
    return { status, dates };
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
  const step = task ? taskTitle(ctx, task) : ctx.t('say.unknownRequest');
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
function ConditionLine({ ctx, basis }: { ctx: Ctx; basis: Parameters<typeof conditionOf>[1] }) {
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
      const what = task ? taskTitle(ctx, task) : '';
      const action = command.type === 'recordSent' ? 'sent' : command.action;
      return dated(ctx, `say.do.${action}`, { what }, task && needDay(ctx, task.basis));
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
    case 'answer':
      return ctx.t('say.do.answer', {
        label: proposal.label ?? '',
        value: valueText(ctx, command.value),
      });
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
                what: taskTitle(ctx, task),
                who: task.assigneeId
                  ? nameOf(ctx.household, task.assigneeId)
                  : ctx.t('say.unassigned'),
                state: ctx.t(`say.taskState.${task.commitment}`),
              },
              needDay(ctx, task.basis),
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
  const choices = labeled.filter((c) => labeled.filter((o) => o.label === c.label).length === 1);
  return (
    <>
      {reply.kind === 'change' &&
        reply.proposals.map((proposal) => (
          <div key={proposal.id} className="flex flex-col gap-2">
            <Text quiet>{ctx.t('say.confirm')}</Text>
            <Title>{proposalLabel(ctx, proposal)}</Title>
            <Row>
              <Button onClick={() => onRecord(proposal)} disabled={busy}>
                {ctx.t('say.record')}
              </Button>
              <Button kind="secondary" onClick={onClear} disabled={busy}>
                {ctx.t('say.cancel')}
              </Button>
            </Row>
          </div>
        ))}
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
          {labeled.length > choices.length && <Text>{ctx.t('say.lookAlike')}</Text>}
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
  // 同じ文の送り直し（返事が届かなかった時など）は、同じ操作 ID で送る（二度読まない・二度足さない）。
  // 文か出どころを変えたら、新しい操作。
  const operation = useRef<string | undefined>(undefined);
  const change = (next: () => void) => {
    operation.current = undefined;
    next();
  };
  const submit = async () => {
    setState('reading');
    operation.current ??= operationId();
    const result = await read({ text, sender, operationId: operation.current });
    if (result.status === 'ok') {
      operation.current = undefined;
      setText('');
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
          disabled={state === 'reading'}
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
      <textarea
        value={text}
        readOnly={state === 'reading'}
        onChange={(e) => change(() => setText(e.target.value))}
        rows={6}
        maxLength={4000}
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
      <Button
        onClick={() => void submit()}
        disabled={state === 'reading' || text.trim().length === 0}
      >
        {ctx.t(state === 'reading' ? 'input.reading' : 'input.submit')}
      </Button>
    </Card>
  );
}

function Missing({ ctx }: { ctx: Ctx }) {
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
