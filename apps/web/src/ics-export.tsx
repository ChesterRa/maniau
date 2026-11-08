// スマホの暦への書き出し（ICS）。02-product §5.3 の約束（今週は、確定した事の書き出しまで）を、11/7 の体検で
// 未実装と分かったので足す。書き出すのは確かな事だけ：家族が確かめて条件の無い行事、引き受けた作業、OK の記録が
// ある頼み事、いつにするかで決めた日、お知らせに書かれた持ち物・提出物の締切。候補の日・決め時・返事待ち・確かめて
// いない事・条件しだいの事・こちらの目安の時刻は入れない（暦の上で、決まった事と見分けられなくなるので）。一度きりの
// 写しで、後の変更は暦に届かない（画面にそう書く）。
import { isActiveTask, isValidLocalDate, toEpochMinutes, zonedToEpochMinutes } from '@maniau/core';
import { useState } from 'react';
import { localDate } from './format';
import { type IcsEvent, toIcs } from './ics';
import {
  type Ctx,
  type ItemTimes,
  itemDay,
  itemDeadline,
  itemTimes,
  nameOf,
  prepDeadline,
  taskTitle,
} from './screens';
import { Button, Card, Label, Text } from './ui';

const ms = (minutes: number) => minutes * 60_000;
const TIME = /^\d{2}:\d{2}$/;

/** きょうから後の、確かな事（書き出す物）。 */
export function firmEvents(ctx: Ctx): IcsEvent[] {
  const today = localDate(ctx.now, ctx.tz);
  const events: IcsEvent[] = [];
  // 書かれていた（stated）事項でも、読み取りが「確かめてほしい」と指した文（または出典の全体）から読んだ物は、
  // 家族が確かめる・直す（confirmed）まで、行事・持ち物・作業・決めた日の書き出しに使わない（画面では「要確認」と
  // 出しているのに、暦では確かな予定に見えないように）。OK の記録がある頼み事は、相手が OK と言った時間という
  // 記録した事実なので、元の文の確かめとは別に書き出す。
  const flagged = (item: (typeof ctx.items)[number]['item']) => {
    if (item.evidence === 'confirmed') return false;
    const reading = ctx.readings.find((r) => r.sourceId === item.sourceId);
    return (
      reading?.checkAll === true ||
      item.sentenceIds.some((id) => reading?.check?.includes(id) === true)
    );
  };
  const trusted = (ids: readonly string[]) =>
    ids.every((id) => {
      const entry = ctx.items.find(({ item }) => item.id === id);
      return entry?.live === true && entry.trusted && !entry.conditional && !flagged(entry.item);
    });
  // お知らせの行事・日の変更・テスト・締切：確かめ済みで条件の無い物。時刻の読み方はよていと同じ（itemTimes）：
  // 始まりが分からない行事は書き出さず（終日の予定にしない。時刻が書かれていないとは言えない）、終わりの日を
  // 決められない行事は始まりだけを書く（同じ日の範囲にしない。11/7 見直しの指摘）。
  for (const { item, live, trusted: sure, conditional } of ctx.items) {
    if (!live || !sure || conditional) continue;
    if (!['event', 'dayChange', 'test', 'deadline'].includes(item.kind)) continue;
    if (flagged(item)) continue;
    const times: ItemTimes =
      item.kind === 'event' || item.kind === 'test' ? itemTimes(ctx, item) : { kind: 'none' };
    if (times.kind === 'unsure') continue;
    const date = itemDay(ctx, item);
    if (!date || !isValidLocalDate(date) || date < today) continue;
    const written = item.interpretation.what ?? item.written;
    const title = ctx.sources.get(item.sourceId)?.title?.trim();
    const base = {
      uid: `item-${item.id}@maniau`,
      ...(title ? { description: ctx.t('ics.fromNotice', { title }) } : {}),
    };
    if (item.kind === 'deadline') {
      // 締切は、書かれた時刻があればその時刻（終わりは作らない）、日だけなら終日。
      const deadline = itemDeadline(item);
      const summary = ctx.t('week.prep.deadline', { what: written });
      events.push(
        deadline?.time
          ? { ...base, summary, start: ms(toEpochMinutes(deadline.at)) }
          : { ...base, summary, date },
      );
      continue;
    }
    const at = (time: string) =>
      TIME.test(time) ? ms(zonedToEpochMinutes(date, time, ctx.tz)) : undefined;
    const start = times.kind === 'from' || times.kind === 'span' ? at(times.start) : undefined;
    const end = times.kind === 'span' ? at(times.end) : undefined;
    events.push({
      ...base,
      summary: written,
      ...(start === undefined ? { date } : { start, ...(end === undefined ? {} : { end }) }),
    });
  }
  // 引き受けた作業：今進める案の物（本命が「はい」で決まって休む予備・使えないとした手の作業は、引き受けの記録が
  // 残っても書き出さない。よていと同じ見方。11/7 見直しの反例）、取り消しの連絡、確かめを待つ印（時刻・番・もう一度
  // の確かめ）が無く、根拠が確かな物。
  for (const task of ctx.plan.tasks) {
    if (!task.live || task.commitment !== 'accepted') continue;
    if (task.cancels === undefined && !isActiveTask(ctx.plan, task)) continue;
    if (task.reconfirm || task.timeUnconfirmed || task.turnUnconfirmed) continue;
    if (!trusted(task.basis.itemIds)) continue;
    const summary = ctx.t('ics.task', {
      name: nameOf(ctx.household, task.assigneeId) || ctx.t('week.unassigned'),
      what: taskTitle(ctx, task),
    });
    if (task.timing === 'undated') continue;
    if (task.timing === 'day') {
      const date = task.earliestStart ? localDate(task.earliestStart, ctx.tz) : undefined;
      if (date && date >= today) events.push({ uid: `task-${task.key}@maniau`, summary, date });
      continue;
    }
    if (!task.start || localDate(task.start, ctx.tz) < today) continue;
    events.push({
      uid: `task-${task.key}@maniau`,
      summary,
      start: ms(toEpochMinutes(task.start)),
      ...(task.end ? { end: ms(toEpochMinutes(task.end)) } : {}),
    });
  }
  // OK の記録がある頼み事：確かめが要らず、条件しだいでなく、時間の変更のお願いを待っていない物。
  for (const request of ctx.plan.requests) {
    if (!request.live || request.state !== 'confirmed') continue;
    if (request.needsCheck || request.conditional || request.changeAsked || !request.window)
      continue;
    if (localDate(request.window.start, ctx.tz) < today) continue;
    const name = nameOf(ctx.household, request.to) || ctx.t('week.unknownRecipient');
    const what = request.askedNeed?.what ?? nameOf(ctx.household, request.childId);
    events.push({
      uid: `request-${request.requestId}@maniau`,
      summary: what ? ctx.t('ics.request', { what, name }) : ctx.t('ics.requestPlain', { name }),
      start: ms(toEpochMinutes(request.window.start)),
      end: ms(toEpochMinutes(request.window.end)),
    });
  }
  // いつにするかで決めた日：決めた後に根拠が変わっておらず（stale でない）、記録した手が離せない時間と重ならず、
  // 条件しだいでない物。決めたのは日で、手配（頼んだ相手の返事・受け持ち）とは別なので、題にそう書く（やり方を
  // 選んだことを、見てもらえると約束できたとは言わない。頼み事は OK の記録がある時に別の予定として書き出す。
  // 11/7 見直しの指摘）。
  for (const requirement of ctx.plan.requirements) {
    if (!requirement.live || requirement.conditional || !requirement.when?.chosen) continue;
    const when = requirement.when;
    if (when.chosen?.stale) continue;
    const chosen = when.candidates.find((c) => c.id === when.chosen?.candidateId);
    if (!chosen || chosen.unavailable || chosen.date < today) continue;
    if (!trusted(requirement.basis.itemIds)) continue;
    events.push({
      uid: `when-${requirement.key}@maniau`,
      summary: ctx.t('ics.whenChosen', { what: requirement.what }),
      start: ms(toEpochMinutes(chosen.start)),
      end: ms(toEpochMinutes(chosen.end)),
    });
  }
  // 持ち物・提出物の時刻（行事の朝など。計画が出す）。時刻は行事の日から来るので、同じお知らせに条件しだいか
  // 確かめていない事項が残る間は書き出さない（雨なら延期の発表会の朝を、決まった時刻として暦に置かない）。
  const settledSources = (ids: readonly string[]) => {
    const sources = new Set(
      ctx.items.filter(({ item }) => ids.includes(item.id)).map(({ item }) => item.sourceId),
    );
    return ctx.items.every(
      ({ item, live, trusted: sure, conditional }) =>
        !sources.has(item.sourceId) || !live || (sure && !conditional && !flagged(item)),
    );
  };
  for (const requirement of ctx.plan.requirements) {
    if (!requirement.live || requirement.conditional || !requirement.by) continue;
    if (requirement.kind !== 'belongings' && requirement.kind !== 'submission') continue;
    if (!trusted(requirement.basis.itemIds) || !settledSources(requirement.basis.itemIds)) continue;
    // お知らせに書かれた締切だけ（書かれていない朝 8:00 は目安なので、暦に決まった時刻として置かない。
    // 01-model「日付の書き方」。11/7 見直しの指摘）。日だけの締切は、その日の終日の予定にする。
    const stated = prepDeadline(ctx, requirement);
    if (stated === 'estimate') continue;
    const day = localDate(requirement.by, ctx.tz);
    if (day < today) continue;
    const summary = ctx.t(`week.prep.${requirement.kind}`, { what: requirement.what });
    events.push(
      stated === 'time'
        ? {
            uid: `prep-${requirement.key}@maniau`,
            summary,
            start: ms(toEpochMinutes(requirement.by)),
          }
        : { uid: `prep-${requirement.key}@maniau`, summary, date: day },
    );
  }
  return events;
}

/** よていの下の札：確かな事を .ics にして渡す。 */
export function IcsExportCard({ ctx }: { ctx: Ctx }) {
  const events = firmEvents(ctx);
  const [saved, setSaved] = useState(false);
  const save = () => {
    const text = toIcs(events, ms(toEpochMinutes(ctx.now)), ctx.t('ics.calendarName'));
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `maniau-${localDate(ctx.now, ctx.tz)}.ics`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setSaved(true);
  };
  return (
    <Card>
      <Label tone="sub">{ctx.t('ics.label')}</Label>
      <Text quiet>{ctx.t('ics.body')}</Text>
      <Text quiet>{ctx.t('ics.snapshot')}</Text>
      {events.length === 0 ? (
        <Text quiet>{ctx.t('ics.none')}</Text>
      ) : (
        <Button kind="secondary" onClick={save}>
          {ctx.t('ics.button', { count: events.length })}
        </Button>
      )}
      {saved && <Text>{ctx.t('ics.saved')}</Text>}
    </Card>
  );
}
