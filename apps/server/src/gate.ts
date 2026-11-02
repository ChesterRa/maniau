// 知らせを送る前の確かめ（02-foundation §2.5）。検証器（エンジンと別に書いた物）にかける。
// - 計画に違反があれば、どの知らせに響くかを絞れないので、その家庭の知らせを全部止める。
// - 知らせの検証の違反は、その知らせだけ止める（$all なら全部）。
// - 未判定は止めない（知らせの文は事実を言い切らず、開いて確かめてもらうだけなので）。回の数え方は
//   検証器では未判定（サーバーの試験で確かめる）。
// 記録には違反の種類（code）だけを残す（中身・名前を残さない）。
import { verifyNotificationMessage, verifyNotifications, verifyPlan } from '@maniau/verify';
import type { MessageGate, SendGate } from './notifier';

const ALL = '$all';

export const sendGate: SendGate = ({ household, plan, events, intents }) => {
  const planIssues = verifyPlan({ household, plan, events }).issues.filter(
    (issue) => issue.kind === 'violation',
  );
  const noticeIssues = verifyNotifications({ household, plan, events, intents }).issues.filter(
    (issue) => issue.kind === 'violation',
  );
  return {
    all: planIssues.length > 0 || noticeIssues.some((issue) => issue.subject === ALL),
    blocked: new Set(noticeIssues.map((issue) => issue.subject)),
    codes: [...new Set([...planIssues, ...noticeIssues].map((issue) => issue.code))],
  };
};

export const messageGate: MessageGate = ({ language, message, intents }) => {
  const violations = verifyNotificationMessage({ message, language, intents }).issues.filter(
    (issue) => issue.kind === 'violation',
  );
  return {
    ok: violations.length === 0,
    codes: [...new Set(violations.map((issue) => issue.code))],
  };
};
