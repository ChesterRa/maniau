// 知らせの決まり（01-model §7「追いかける時機」、02-foundation §5.7・§9）。今の計画から、有効な大人
// ごとに、もう待てない物だけを知らせの意図にする。送るか・いつ送ったかはサーバーの仕事が持ち、送る
// 直前に、もう一度この関数で確かめる。
//
// キーは「何についての知らせか」だけを表し、中身（時刻・品物）を入れない。何回目かは、サーバーが
// 事象を書き込みのまとまりごとに再生して、無かったキーが出た時を数える（同じキーが出ている間は一回。
// 消えてまた出れば次の回）。キーは事象（notified）に残るので、計画の ID と決まった符号だけで作る。
// 文はロック画面に出るので、子・学校・人の名前を入れない。
import type { DomainEvent } from '../schema/events';
import type { Household } from '../schema/household';
import type { PlanResult, Task } from '../schema/plan';
import {
  addDays,
  type DateTime,
  type EpochMinutes,
  localDateOf,
  localTimeOf,
  toEpochMinutes,
  zonedToEpochMinutes,
} from '../time';
import {
  BACKUP_LEAD_MIN,
  choosable,
  mustChooseAgain,
  NOREPLY_LEAD_MIN,
  needStep,
  type TodayCard,
  todayCards,
} from './today';

/** 決める事・問いを知らせ始める時：期限のこの時間前から（予備の勧めと同じ、前の晩）。 */
export const URGENT_LEAD_MIN = BACKUP_LEAD_MIN;
/** 夜（家庭の時区で）は、朝まで待てる知らせを送らない。 */
export const NIGHT_START = '22:00';
export const MORNING = '07:00';
/** 朝に送ると、期限までこれだけの余裕が無い物は、夜でも送る（待てない）。 */
export const MORNING_SLACK_MIN = 120;
/**
 * お知らせから読んだ「すること」を、読み取りからこれだけたっても確かめていなければ、お知らせを入れた人に一度
 * 知らせる（読み取りの日時は確かめていないので、それで急ぐかを決めない。締切に間に合うとは言わない）。
 */
export const READ_CHECK_AFTER_MIN = 60;

export type NotificationKind = 'decisionApproaching' | 'question' | 'cancellation' | 'assignment';

/** 一つの知らせの文。 */
export type NotificationTitle =
  | 'notify.released'
  | 'notify.releasedCheck'
  | 'notify.cancel'
  | 'notify.check'
  | 'notify.backup'
  | 'notify.noReply'
  | 'notify.decide'
  | 'notify.proposal'
  | 'notify.changed'
  | 'notify.question'
  | 'notify.unowned'
  | 'notify.readCheck'
  | 'notify.need'
  | 'notify.needGaps';

/** 知らせの元（検証器が、キーを読まずに計画の物と照らすため）。 */
export type NotificationSubject =
  | { type: 'request'; id: string }
  /** 手配（案を決める・予備の時は案。「すること」のやり方を選ぶ・受け持ちの時は手配だけ）。 */
  | { type: 'arrangement'; id: string; optionId?: string; requestId?: string }
  | { type: 'task'; id: string }
  | { type: 'question'; id: string }
  /** お知らせの読み取り（出典と、読み取りの事象の番号）。 */
  | { type: 'reading'; id: string; seq: number };

export interface NotificationIntent {
  /** 何についての知らせか（大人ごと）。中身は入れない。 */
  key: string;
  subject: NotificationSubject;
  toMemberId: string;
  kind: NotificationKind;
  titleKey: NotificationTitle;
  /** これを過ぎたら送らない（役に立たない）。無ければ、札が消えるまで。 */
  until?: DateTime;
  /** 本人がこれまでに動けば間に合う時（夜に朝まで待つかを決める）。無ければ until。 */
  actBy?: DateTime;
}

export type NotificationLanguage = 'ja' | 'en';

/** ロック画面の文（名前を含まない）。いくつも同時に送る時は many を使う。 */
export const NOTIFICATION_TEXT: Record<
  NotificationLanguage,
  Record<NotificationTitle | 'notify.app' | 'notify.many', string>
> = {
  ja: {
    'notify.app': 'まにあう',
    'notify.released': '引き受けたことが、もう要らなくなりました。確かめてください。',
    'notify.releasedCheck':
      '引き受けたことが、今の計画に見つかりません。まだ要るか確かめてください。',
    'notify.cancel': 'もう要らない頼み事があります。相手に取り消しを伝えてください。',
    'notify.check': '頼み事が、まだ要るか確かめてください。',
    'notify.backup': '返事を待つ間に、予備の案を押さえるか決める時が近づいています。',
    'notify.noReply': '返事がまだ記録されていない頼み事があります。日が近づいています。',
    'notify.decide': '決めることがあります。決め時が近づいています。',
    'notify.proposal': 'おねがいが届いています。引き受けられるか確かめてください。',
    'notify.changed': '引き受けたことの中身が変わりました。確かめてください。',
    'notify.question': '段取りについて、聞きたいことがあります。',
    'notify.unowned': 'まだだれもやると決めていないことがあります。期限が近づいています。',
    'notify.readCheck': 'お知らせの読み取りで、まだ確かめていないものがあります。',
    'notify.need': '進め方がまだ決まっていないことがあります。日が近づいています。',
    'notify.needGaps': 'まだ受け持ちを確かめられていない時間があります。',
    'notify.many': '確かめてほしいことが {{count}} 件あります。',
  },
  en: {
    'notify.app': 'Maniau',
    'notify.released': 'Something you took on is no longer needed. Please check.',
    'notify.releasedCheck':
      'Something you took on is no longer in the plan. Please check whether it is still needed.',
    'notify.cancel': 'A request is no longer needed. Please let them know.',
    'notify.check': 'Please check whether a request is still needed.',
    'notify.backup': "While you wait for a reply, it's nearly time to decide on a backup.",
    'notify.noReply': 'A request still has no reply recorded, and its day is coming up.',
    'notify.decide': 'Something needs deciding. The decision deadline is coming up.',
    'notify.proposal': "There's a request for you. Can you take it on?",
    'notify.changed': 'Something you took on has changed. Please check it.',
    'notify.question': "There's a question about your plans.",
    'notify.unowned': 'Something still has no one to do it, and its deadline is coming up.',
    'notify.readCheck': "Part of a notice's reading hasn't been checked yet.",
    'notify.need': 'Something still has no way to proceed chosen, and its date is coming up.',
    'notify.needGaps': 'Some hours still have no one confirmed to cover them.',
    'notify.many': '{{count}} things need your attention.',
  },
};

/** 送る文。同じ大人に同時にいくつも送る時は、件数の文一つにまとめる。 */
export function notificationMessage(
  language: NotificationLanguage,
  intents: readonly Pick<NotificationIntent, 'titleKey'>[],
): { title: string; body: string; titleKey: NotificationTitle | 'notify.many'; count: number } {
  const text = NOTIFICATION_TEXT[language];
  const [only] = intents;
  if (intents.length === 1 && only) {
    return {
      title: text['notify.app'],
      body: text[only.titleKey],
      titleKey: only.titleKey,
      count: 1,
    };
  }
  const count = new Intl.NumberFormat(language).format(intents.length);
  return {
    title: text['notify.app'],
    body: text['notify.many'].replace('{{count}}', count),
    titleKey: 'notify.many',
    count: intents.length,
  };
}

/** 期限まで、今からの残り（分）が、知らせ始める幅に入っているか。 */
function urgent(deadline: DateTime | undefined, now: EpochMinutes): boolean {
  if (deadline === undefined) return false;
  const left = toEpochMinutes(deadline) - now;
  return left > 0 && left <= URGENT_LEAD_MIN;
}

/** 事象から読む、作業を頼んだ人。 */
export interface NotificationHistory {
  /** その作業を最後に提案した人（仕組みの提案なら無い）。 */
  proposedBy(taskKey: string): string | undefined;
}

export function notificationHistory(events: readonly DomainEvent[]): NotificationHistory {
  const proposer = new Map<string, { seq: number; actorId: string }>();
  for (const event of events) {
    if (event.type !== 'assignmentProposed') continue;
    const before = proposer.get(event.taskKey);
    if (!before || before.seq < event.seq) {
      proposer.set(event.taskKey, { seq: event.seq, actorId: event.actorId });
    }
  }
  return { proposedBy: (taskKey) => proposer.get(taskKey)?.actorId };
}

const NO_HISTORY = notificationHistory([]);

type Draft = Omit<NotificationIntent, 'toMemberId'>;

/**
 * 本人が動く時：書かれた時刻の決まった作業（当番）は、その始まり（終わりまでに済めば良いのではない）。日だけの
 * 当番は始まりが書かれていないので作らず、その日の終わり（締切）で決める。ただし、読み取りの始まりを確かめ
 * られなかった当番（timeUnconfirmed）は、朝早くかもしれないので、その日の始まり（0 時）を目安にする（書かれた
 * 始まりとはしない。画面にも出さない。急ぐかと、夜に朝まで待つかを決めるだけ）。ほかの作業は無し。
 */
const actByOf = (task: Task): DateTime | undefined =>
  task.timing === 'fixed' ||
  task.timing === 'fixedEndEstimated' ||
  (task.timing === 'day' && task.timeUnconfirmed)
    ? task.earliestStart
    : undefined;

/**
 * 急ぐか：本人が動く時（無ければ期限）が近い。始まりを確かめられなかった当番は、目安（0 時）を過ぎた後も
 * （その日に届いた等）、その日の終わりが近ければ急ぐ（過ぎた目安で、知らせを止めない）。
 */
const due = (
  task: Task,
  actBy: DateTime | undefined,
  deadline: DateTime | undefined,
  now: EpochMinutes,
): boolean =>
  urgent(actBy ?? deadline, now) ||
  (task.timeUnconfirmed === true &&
    actBy !== undefined &&
    toEpochMinutes(actBy) <= now &&
    urgent(deadline, now));

function intentOf(
  card: TodayCard,
  memberId: string,
  now: EpochMinutes,
  history: NotificationHistory,
): Draft | undefined {
  switch (card.kind) {
    case 'released': {
      // 引き受けた作業が要らなくなった：本人が動き始める時（置いた始まり）の前の知らせ始める幅から、終わるまで
      // 知らせる（約束どおりに出かけてしまわないように。始まった後に中止が届いても、移動を止められる）。夜に
      // 待つかは始まりで決め、終わったら送らない。時刻の無い物は、いつ動くか分からないので、出たら知らせる
      // （夜は朝まで待つ）。外への取り消しの連絡とは別。
      // 根拠のお知らせを消した等で、要らなくなったとは言えない物は、まだ要るか確かめてと知らせる。
      const { released } = card;
      const check = released.reason === 'unconfirmed';
      const until = released.end ?? released.start;
      const actBy = released.start;
      const from = actBy ?? until;
      if (from !== undefined && toEpochMinutes(from) - now > URGENT_LEAD_MIN) return undefined;
      return {
        key: `${check ? 'releasedCheck' : 'released'}:${released.taskKey}`,
        subject: { type: 'task', id: released.taskKey },
        kind: 'assignment',
        titleKey: check ? 'notify.releasedCheck' : 'notify.released',
        ...(until ? { until } : {}),
        ...(actBy && actBy !== until ? { actBy } : {}),
      };
    }
    case 'cancel':
    case 'check': {
      // 頼んだ時間が終わるまでは伝える意味がある（始まった後でも、残りの時間がある）。相手が動き始め
      // る前（頼んだ時間の始まり）に伝えたいので、夜に待つかはそれで決める。時間の無い依頼は、
      // 札が消えるまで。
      const window = card.request.window;
      return {
        key: `${card.kind}:${card.request.requestId}`,
        subject: { type: 'request', id: card.request.requestId },
        kind: card.kind === 'cancel' ? 'cancellation' : 'question',
        titleKey: card.kind === 'cancel' ? 'notify.cancel' : 'notify.check',
        ...(window ? { until: window.end, actBy: window.start } : {}),
      };
    }
    case 'backup': {
      // 予備の札は、次の案の決め時の前の晩から出る（今日の札の決まり）。出たら知らせる。
      const { arrangement, option } = card;
      return {
        key: `backup:${arrangement.key}:${option.key}`,
        subject: {
          type: 'arrangement',
          id: arrangement.key,
          optionId: option.key,
          requestId: card.waitingFor.requestId,
        },
        kind: 'decisionApproaching',
        titleKey: 'notify.backup',
        ...(option.decisionDeadline ? { until: option.decisionDeadline } : {}),
      };
    }
    case 'noReply': {
      // 返事待ちを今やることに上げた時に一度（札が出るのは、頼んだ時間の始まりの NOREPLY_LEAD_MIN 前から）。その時
      // 以降に送った頼み事（遅く頼んだ物）は、送った本人が動いたばかりなので、いつ計算し直しても知らせない（札は出す）。
      // 頼んだ時間が始まったら送らない（その後は画面で足りる）。
      const { request } = card;
      const window = request.window;
      if (!window) return undefined;
      const from = toEpochMinutes(window.start) - NOREPLY_LEAD_MIN;
      if (toEpochMinutes(request.sentAt) >= from) return undefined;
      return {
        key: `noReply:${request.requestId}`,
        subject: { type: 'request', id: request.requestId },
        kind: 'decisionApproaching',
        titleKey: 'notify.noReply',
        until: window.start,
      };
    }
    case 'decide': {
      // 決める事は、最初に選べなくなる案の決め時が近づいた時だけ（届いた時は、画面で足りる）。
      // 選んだ案が使えなくなった時は、その案を除いて数える。
      const { arrangement } = card;
      // 選んだ後も残す札（見守れる大人を確かめられない時間が分かれる日。splitOpen）は、知らせない（画面で足りる）。
      if (arrangement.chosenOptionKey !== undefined && !mustChooseAgain(arrangement))
        return undefined;
      const first = arrangement.options
        .filter(
          (o) =>
            choosable(arrangement, o) &&
            o.decisionDeadline !== undefined &&
            o.key !== arrangement.chosenOptionKey,
        )
        .map((o) => ({ key: o.key, deadline: o.decisionDeadline as DateTime }))
        .sort((a, b) => toEpochMinutes(a.deadline) - toEpochMinutes(b.deadline))[0];
      if (!first || !urgent(first.deadline, now)) return undefined;
      return {
        key: `decide:${arrangement.key}:${first.key}`,
        subject: { type: 'arrangement', id: arrangement.key, optionId: first.key },
        kind: 'decisionApproaching',
        titleKey: 'notify.decide',
        until: first.deadline,
      };
    }
    case 'proposal': {
      const { task } = card;
      const changed = task.reconfirm === true;
      const by = history.proposedBy(task.key);
      // 時刻を置けなかった案の作業で、案の決め時も過ぎた物（これからの空きが無い）は知らせない（今から引き受けても
      // 間に合わない）。
      const own = card.arrangement?.options.find((o) => o.key === task.basis.optionKey);
      if (task.start === undefined && own?.expired) return undefined;
      // 自分で自分に頼んだ物（案を選んで自分を担当にした）は知らせない。引き受けた後に中身が
      // 変わった物は、誰が頼んだ物でも知らせる。
      if (!changed && by === memberId) return undefined;
      // 仕組みの提案（勧めた買い物を、通る人に。提案の事象が無いか、仕組みが書いた物）は、日ごとに
      // 置き直すので、決め時が近い時だけ。大人が頼んだ物は、頼まれた時に知らせる（引き受けるまで追う）。
      // 書かれた時刻の決まった当番だけ、始まりで急ぐかを決める（ほかの作業は、これまでどおり締切から）。
      const actBy = actByOf(task);
      if (!changed && (by === undefined || by === 'system')) {
        const option = card.arrangement?.options.find((o) => o.key === task.basis.optionKey);
        const decideBy = option?.decisionDeadline;
        if (
          decideBy !== undefined
            ? !urgent(decideBy, now)
            : !due(task, actBy, task.deadline ?? task.start, now)
        ) {
          return undefined;
        }
      }
      // 出ている間に時刻などが替わっても、知らせ直さない（開けば今の中身を見せる）。引き受け直して
      // 消えた後に、また替われば、次の回として知らせる。
      const until = task.start ?? task.deadline;
      return {
        key: `${changed ? 'changed' : 'proposal'}:${task.key}`,
        subject: { type: 'task', id: task.key },
        kind: 'assignment',
        titleKey: changed ? 'notify.changed' : 'notify.proposal',
        ...(until ? { until } : {}),
        ...(actBy && actBy !== until ? { actBy } : {}),
      };
    }
    case 'unowned': {
      // だれも持っていない作業は、二人の「きょう」に出し続け、期限が近づいた時だけ二人に知らせる
      // （届いた時は、画面で足りる）。期限は、案の手順なら案の決め時（過ぎて始めた案なら作業の締切）、
      // それ以外は作業の締切（提出物は出す日）。
      // 書かれた時刻の決まった当番は、終わりではなく始まりまでに誰かが持つ（急ぐか・夜に待つかも始まりで
      // 決める。終わるまでは、知らせる意味がある）。
      const { task } = card;
      const option = card.arrangement?.options.find((o) => o.key === task.basis.optionKey);
      const deadline =
        option && !option.expired && option.decisionDeadline !== undefined
          ? option.decisionDeadline
          : task.deadline;
      const actBy = option ? undefined : actByOf(task);
      if (!due(task, actBy, deadline, now)) return undefined;
      return {
        key: `unowned:${task.key}`,
        subject: { type: 'task', id: task.key },
        kind: 'assignment',
        titleKey: 'notify.unowned',
        ...(deadline ? { until: deadline } : {}),
        ...(actBy ? { actBy } : {}),
      };
    }
    case 'question': {
      // 家にあるかの問いは、聞く目安（askBy）の前に。家族が決める値の問いは、答えが要る最後の時（until）の
      // 前に（期限の分からない問いは知らせない。札だけ）。
      const by = card.question.family ? card.question.until : card.question.askBy;
      if (!urgent(by, now)) return undefined;
      return {
        key: `question:${card.question.unknownId}`,
        subject: { type: 'question', id: card.question.unknownId },
        kind: 'question',
        titleKey: 'notify.question',
        ...(by ? { until: by } : {}),
      };
    }
    case 'need': {
      // 通用の「すること」の手配（札は大人の全員に出る）。やり方の本命を選ぶ時は、決める事と同じく、最初に選べなく
      // なる案の決め時の前から（決め時の分からない案だけなら知らせない。札だけ）。やり方をまだ選んでいない時は、
      // 確かめた日時（窓の始まり、締切の形は締切）が近づいた時だけ、中身を言わずに（選ぶ前は、やり方の前もっての
      // 手順が分からないので、その時ではもう遅いこともある）。窓の受け持ちを確かめられない時間は、窓の始まりの前
      // から終わりまで。間に合う進め方が無い時は札だけ（できないと言い切らない）。
      const { arrangement } = card;
      const step = needStep(arrangement);
      const window = arrangement.needShape === 'window';
      if (step === 'choose') {
        const first = arrangement.options
          .filter(
            (o) =>
              choosable(arrangement, o) &&
              o.decisionDeadline !== undefined &&
              o.key !== arrangement.chosenOptionKey,
          )
          .map((o) => ({ key: o.key, deadline: o.decisionDeadline as DateTime }))
          .sort((a, b) => toEpochMinutes(a.deadline) - toEpochMinutes(b.deadline))[0];
        if (!first || !urgent(first.deadline, now)) return undefined;
        return {
          key: `decide:${arrangement.key}:${first.key}`,
          subject: { type: 'arrangement', id: arrangement.key, optionId: first.key },
          kind: 'decisionApproaching',
          titleKey: 'notify.decide',
          until: first.deadline,
        };
      }
      const end = toEpochMinutes(arrangement.end);
      if (now >= end) return undefined;
      if (step === 'ways' || step === 'waysChanged' || step === 'waysStopped') {
        const by = window ? arrangement.start : arrangement.end;
        if (toEpochMinutes(by) - now > URGENT_LEAD_MIN) return undefined;
        return {
          key: `needWays:${arrangement.key}`,
          subject: { type: 'arrangement', id: arrangement.key },
          kind: 'decisionApproaching',
          titleKey: 'notify.need',
          until: arrangement.end,
          ...(window ? { actBy: arrangement.start } : {}),
        };
      }
      if (step === 'gaps' && window) {
        if (toEpochMinutes(arrangement.start) - now > URGENT_LEAD_MIN) return undefined;
        return {
          key: `needGaps:${arrangement.key}`,
          subject: { type: 'arrangement', id: arrangement.key },
          kind: 'assignment',
          titleKey: 'notify.needGaps',
          until: arrangement.end,
          actBy: arrangement.start,
        };
      }
      return undefined;
    }
    case 'needCheck': {
      // お知らせから読んだ「すること」の確かめ：読み取りから READ_CHECK_AFTER_MIN たっても確かめていなければ、
      // お知らせを入れた大人にだけ一度（中身は入れない。同じ読み取りの事項はキーでまとめる。札が消えてまた出れば、
      // ほかの知らせと同じく次の回）。読み取りの日時は確かめていないので、期限にしない（夜は朝まで待つ）。
      // 仕組みが入れたお知らせは、だれも入れていないので知らせない。確かめ・直し・外し・取り下げ・読み直しで
      // 札が消えれば、送る前に消える。
      const reading = card.requirement.reading;
      if (!reading || reading.addedBy === 'system' || reading.addedBy !== memberId)
        return undefined;
      if (now < toEpochMinutes(reading.at) + READ_CHECK_AFTER_MIN) return undefined;
      return {
        key: `readCheck:${reading.sourceId}:${reading.seq}`,
        subject: { type: 'reading', id: reading.sourceId, seq: reading.seq },
        kind: 'question',
        titleKey: 'notify.readCheck',
      };
    }
    default:
      return undefined;
  }
}

/**
 * 今の計画から、有効な大人ごとに、知らせの意図を作る（その大人の「きょう」の上の札から）。
 * history は、事象から読んだ、作業を頼んだ人（notificationHistory）。
 */
export function notificationIntents(
  plan: PlanResult,
  household: Household,
  history: NotificationHistory = NO_HISTORY,
): NotificationIntent[] {
  const now = toEpochMinutes(plan.now);
  const intents: NotificationIntent[] = [];
  for (const member of household.members) {
    if (member.kind !== 'adult' || !member.active) continue;
    const keys = new Set<string>();
    for (const card of todayCards(plan, member.id).main) {
      const intent = intentOf(card, member.id, now, history);
      if (!intent) continue;
      if (intent.until !== undefined && toEpochMinutes(intent.until) <= now) continue;
      // 同じ物についての知らせ（同じ読み取りの事項など）は、一つにまとめる。
      const key = `${intent.key}:${member.id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      intents.push({ ...intent, key, toMemberId: member.id });
    }
  }
  return intents;
}

/**
 * 夜なら、朝まで待つか。待つなら、送ってよい朝の時刻を返す。朝に送ると、本人が動く時（actBy、無けれ
 * ば until）まで MORNING_SLACK_MIN の余裕が無い物は、待たない（夜でも送る）。
 */
export function holdUntilMorning(
  intent: Pick<NotificationIntent, 'until' | 'actBy'>,
  now: EpochMinutes,
  timeZone: string,
): EpochMinutes | undefined {
  const time = localTimeOf(now, timeZone);
  if (time >= MORNING && time < NIGHT_START) return undefined;
  const today = localDateOf(now, timeZone);
  const morning = zonedToEpochMinutes(
    time >= NIGHT_START ? addDays(today, 1) : today,
    MORNING,
    timeZone,
  );
  const by = intent.actBy ?? intent.until;
  if (by !== undefined && toEpochMinutes(by) - morning < MORNING_SLACK_MIN) return undefined;
  return morning;
}
