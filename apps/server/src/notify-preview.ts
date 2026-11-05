// デモだけ：デモの時刻に、家族の知らせの決まりで出る「知らせの候補」を作る（送らない・記録しない）。
// 家族の家庭の送り手（notifier.ts）と同じ手順を通す：今の計画から意図を作り（notificationIntents）、検証器の
// 門（sendGate）に今の意図を全部かけて止めた物を外し、夜なら朝まで待つ物を分け、大人ごとにまとめた文を文の門
// （messageGate）にかける。
// 本物の送り手だけが持つ物（登録した端末、何回目か・送った記録、やり直し、送る直前の作り直し）はデモに無いので、
// 画面は「まだ送っていないとした時の候補」と言う。計画は、この要求の見せる物と同じ物（地図の根拠を含むことが
// ある。家族の家庭は今は地図を使わないので、家族の家庭で送る物と同じだとは言わない）。
import {
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type Household,
  holdUntilMorning,
  type NotificationIntent,
  type NotificationLanguage,
  type NotificationTitle,
  notificationHistory,
  notificationIntents,
  notificationMessage,
  type PlanResult,
  toEpochMinutes,
} from '@maniau/core';
import { messageGate as defaultMessageGate, sendGate as defaultSendGate } from './gate';
import type { MessageGate, SendGate } from './notifier';

export interface NotificationPreviewMember {
  memberId: string;
  /** 今送る候補（文の元。画面の言葉で文にする。二つ以上なら件数の文にまとまる）。 */
  now: NotificationTitle[];
  /** 夜なので、朝まで待つ候補と、送ってよい朝の時刻。 */
  morning?: { at: DateTime; titles: NotificationTitle[] };
  /** 検証器が止めた候補の数（送る前の門と、文の門）。 */
  blocked: number;
}

export interface NotificationPreview {
  /** 計画に検証器の違反があり、全部を止めた（どの知らせに響くか絞れない）。 */
  blockedAll: boolean;
  /** 有効な大人の全員（候補が無い大人も入れる。だれに送らないかも見せるため）。 */
  members: NotificationPreviewMember[];
}

const LANGUAGES: readonly NotificationLanguage[] = ['ja', 'en'];

/** 文の門：どの画面の言葉でも決まった文か（一つでも外れれば、その大人の分を止める）。 */
function messagesPass(intents: readonly NotificationIntent[], gate: MessageGate): boolean {
  return LANGUAGES.every(
    (language) => gate({ language, message: notificationMessage(language, intents), intents }).ok,
  );
}

export function notificationPreview(
  events: readonly DomainEvent[],
  plan: PlanResult,
  household: Household,
  gates: { send?: SendGate; message?: MessageGate } = {},
): NotificationPreview {
  const intents = notificationIntents(plan, household, notificationHistory(events));
  const verdict = (gates.send ?? defaultSendGate)({
    household,
    plan,
    events,
    batchEnds: events.map((e) => e.seq),
    intents,
  });
  const adults = household.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id);
  return {
    blockedAll: verdict.all,
    members: previewMembers(
      intents,
      verdict,
      adults,
      toEpochMinutes(plan.now),
      household.timeZone,
      gates.message ?? defaultMessageGate,
    ),
  };
}

/**
 * 今の意図と送る前の門の答えから、大人ごとの候補を作る：門が止めた物を外し、夜なら朝まで待つ物を分け、
 * それぞれを大人ごとにまとめた文で文の門にかける（外れたら、その分を止めた数に入れる）。
 */
export function previewMembers(
  intents: readonly NotificationIntent[],
  verdict: { all: boolean; blocked: ReadonlySet<string> },
  adults: readonly string[],
  now: number,
  timeZone: string,
  messageGate: MessageGate,
): NotificationPreviewMember[] {
  return adults.map((memberId): NotificationPreviewMember => {
    const mine = intents.filter((i) => i.toMemberId === memberId);
    if (verdict.all) return { memberId, now: [], blocked: mine.length };
    const open = mine.filter((i) => !verdict.blocked.has(i.key));
    let blocked = mine.length - open.length;
    const ready: NotificationIntent[] = [];
    const held: NotificationIntent[] = [];
    let at: number | undefined;
    for (const intent of open) {
      const morning = holdUntilMorning(intent, now, timeZone);
      if (morning === undefined) ready.push(intent);
      else {
        held.push(intent);
        at = at === undefined ? morning : Math.min(at, morning);
      }
    }
    const pass = (list: NotificationIntent[]) => {
      if (list.length === 0 || messagesPass(list, messageGate)) return list;
      blocked += list.length;
      return [];
    };
    const sendNow = pass(ready);
    const sendLater = pass(held);
    return {
      memberId,
      now: sendNow.map((i) => i.titleKey),
      ...(sendLater.length > 0 && at !== undefined
        ? {
            morning: {
              at: formatDateTime(at, timeZone),
              titles: sendLater.map((i) => i.titleKey),
            },
          }
        : {}),
      blocked,
    };
  });
}
