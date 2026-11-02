// 画面：きょう・決める・頼む・よてい・お知らせ。計画と「きょう」の札はサーバーが作り、ここは見せ方と、
// 命令を送ることだけ（02-foundation §7.1・§7.2）。
import {
  type Arrangement,
  type Command,
  type ExternalRequest,
  type Household,
  type Item,
  type Member,
  type OptionPlan,
  type PlanResult,
  proposalSnapshot,
  type Source,
  type Task,
  type TodayCard,
  toEpochMinutes,
} from '@maniau/core';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import type { Reading, SendResult } from './family';
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
  /** 今の事項。条件しだい・確かめていない物は、確かな予定と見分けて見せる。 */
  items: { item: Item; live: boolean; conditional: boolean; trusted: boolean }[];
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
        {shown.length === 0 && (
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

function cardKey(card: TodayCard): string {
  switch (card.kind) {
    case 'cancel':
    case 'proposal':
    case 'todo':
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
      {isConditional(arrangement) && <Text quiet>{ctx.t('card.decide.conditional')}</Text>}
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
        <Text>{ctx.t(task.handoff ? 'card.proposal.handoff' : 'card.proposal.unplaced')}</Text>
      )}
      <Row>
        {shown && <Button onClick={accept}>{ctx.t('card.proposal.accept')}</Button>}
        <Button kind="secondary" onClick={decline}>
          {ctx.t('card.proposal.decline')}
        </Button>
      </Row>
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
    for (const { item, live, conditional, trusted } of ctx.items) {
      if (!live || item.interpretation.date !== date) continue;
      if (item.kind === 'event' || item.kind === 'dayChange' || item.kind === 'test') {
        const what = item.interpretation.what ?? item.written;
        // 確かでない予定を、決まった予定と同じ形で見せない。
        lines.push(
          !trusted
            ? ctx.t('week.unconfirmed', { what })
            : conditional
              ? ctx.t('week.conditional', { what })
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
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('sources.eyebrow')}
        title={ctx.t('sources.title')}
      />
      <Main>
        <Card tone="accent">
          <Label tone="accent">{ctx.t('sources.snapLabel')}</Label>
          <Text>{ctx.t('sources.snapBody')}</Text>
        </Card>
        {/* お知らせごと消した出典は、見せる物に来ない（原文を出さない）。 */}
        {props.sourceId && shown.length === 0 && (
          <Card>
            <Text quiet>{ctx.t('sources.gone')}</Text>
          </Card>
        )}
        {shown.map((source) => {
          const reading = ctx.readings.find((r) => r.sourceId === source.id);
          return (
            <Card key={source.id}>
              <Label tone="sub">
                {ctx.t('sources.received', { at: dayTime(ctx, source.receivedAt) })}
              </Label>
              <Title>{source.title ?? ctx.t('sources.untitled')}</Title>
              <div className="flex flex-col gap-1">
                {source.sentences.map((sentence) => (
                  <p
                    key={sentence.id}
                    className={`rounded-lg px-1.5 text-base leading-relaxed ${highlight.has(sentence.id) ? 'bg-bag font-bold' : ''}`}
                  >
                    {sentence.text}
                  </p>
                ))}
              </div>
              {reading && (
                <Text quiet>
                  {reading.origin === 'recorded'
                    ? ctx.t('sources.recorded', { model: reading.model })
                    : ctx.t('sources.handWritten')}
                </Text>
              )}
            </Card>
          );
        })}
      </Main>
    </>
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
