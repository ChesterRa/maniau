// 「断られたら？」（W5）：返事を待っている頼み事を、断られたと仮に置いて、同じ計算で何が変わるかを見せる（予備に
// 進むか・選び直しか、残る手と決め時、いつまでに返事をもらえば間に合うか）。何も記録せず、だれにも送らない
// （サーバーの見る口。本当の返事は「きょう」で記録する）。計算はサーバー、ここは見せるだけ。選ぶのは家族である。
import type { Arrangement, HouseholdPreview } from '@maniau/core';
import { useEffect, useState } from 'react';
import { ChoiceClock } from './choice-clock';
import { householdPreviewLines } from './household';
import {
  type Ctx,
  day,
  dayTime,
  decideRoute,
  Missing,
  nameOf,
  optionTitle,
  replyBy,
} from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Text, Title } from './ui';

export function WhatIfScreen({ ctx, requestId }: { ctx: Ctx; requestId: string }) {
  const request = ctx.plan.requests.find((r) => r.requestId === requestId);
  const current = ctx.plan.arrangements.find(
    (a) => a.live && a.key === request?.basis.arrangementKey,
  );
  const waiting = request?.state === 'awaitingReply' && request.live;
  const { previewChange } = ctx;
  // 計画が変わるたびに計算し直す（見せた後に返事が記録された・ほかの手が選ばれた等）。
  const [read, setRead] = useState<{ key: string; preview?: HouseholdPreview; refused?: string }>();
  const [again, setAgain] = useState(0);
  const readKey = `${requestId}|${ctx.plan.throughSeq}|${again}`;
  useEffect(() => {
    if (!previewChange || !waiting) return;
    let cancelled = false;
    void previewChange({ type: 'recordReply', requestId, reply: 'no' }).then((result) => {
      if (cancelled) return;
      setRead({
        key: readKey,
        ...(result && 'preview' in result ? { preview: result.preview } : {}),
        ...(result && 'refused' in result ? { refused: result.refused } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [previewChange, waiting, requestId, readKey]);

  if (!request || !current) return <Missing ctx={ctx} />;
  const to = nameOf(ctx.household, request.to);
  const fresh = read?.key === readKey ? read : undefined;
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('whatIf.eyebrow')}
        title={ctx.t('whatIf.title', { to })}
      />
      <Main>
        <Card tone="accent">
          <Label tone="warn">{ctx.t('whatIf.label')}</Label>
          <Text>{ctx.t('whatIf.hypothetical', { to })}</Text>
        </Card>
        {!waiting ? (
          <Text>{ctx.t('whatIf.notWaiting', { to })}</Text>
        ) : !previewChange ? (
          <Text>{ctx.t('whatIf.failed')}</Text>
        ) : !fresh ? (
          <Text quiet>{ctx.t('whatIf.loading')}</Text>
        ) : fresh.refused ? (
          <Text>{ctx.t('whatIf.refused')}</Text>
        ) : !fresh.preview ? (
          <Card tone="warn">
            <Text>{ctx.t('whatIf.failed')}</Text>
            <Button onClick={() => setAgain((n) => n + 1)}>{ctx.t('whatIf.retry')}</Button>
          </Card>
        ) : (
          <WhatIfOutcome
            ctx={ctx}
            current={current}
            preview={fresh.preview}
            taskKey={request.taskKey}
          />
        )}
        {/* この画面では何も選ばない（選ぶのは、決める画面と「きょう」の札。押すと本当に記録する）。 */}
        <MoreLink onClick={() => ctx.go(decideRoute(current))}>{ctx.t('card.backup.all')}</MoreLink>
        <Text quiet>{ctx.t('whatIf.note')}</Text>
      </Main>
    </>
  );
}

/**
 * 仮の計算の結果：今の手のまま進むか（断られたのが予備の時）、ほかの選んだ手に進むか（本命が断られて予備に進む
 * 時）、選び直しか。変わること。選び直しなら、残る手の決め時と、返事をもらう目安。
 */
export function WhatIfOutcome(props: {
  ctx: Ctx;
  /** 今の計画の、その依頼の手配（仮定の前）。 */
  current: Arrangement;
  preview: HouseholdPreview;
  taskKey: string;
}) {
  const { ctx, current, preview, taskKey } = props;
  const after = preview.arrangement;
  // 決める画面の「選んだら」と同じく、新しい違反だけを書く（決め時は目安と書いてある。何も保存しない）。
  const lines = householdPreviewLines(ctx, { ...preview, unverified: [] });
  // 断られた手（頼んだ作業を持つ手）。残る手には数えない。
  const declined = after?.options.find((o) => o.taskKeys.includes(taskKey));
  const inUse = after?.options.find((o) => o.key === after.inUseOptionKey);
  // 今使っている手が変わらない（断られたのは今使っていない手、例えば予備）か、ほかの選んだ手に移るか。
  const stays = inUse !== undefined && inUse.key === current.inUseOptionKey;
  const lostBackup =
    stays && declined !== undefined && after?.backupOptionKeys.includes(declined.key) === true;
  const toBackup = inUse !== undefined && after?.backupOptionKeys.includes(inUse.key) === true;
  const recommended = after?.options.find((o) => o.key === after.recommendedOptionKey);
  const others = after?.options.filter((o) => o.key !== declined?.key) ?? [];
  // 選び直しになる時だけ：ほかの手で最も早い決め時の前の晩までに返事をもらえば、断られても間に合う（頼む文・
  // 決める画面と同じ計算）。
  const reply = after && !inUse ? replyBy(ctx, after, declined?.key) : undefined;
  const until =
    after?.kind === 'need' && after.needShape === 'by' ? after.end : (after?.start ?? ctx.now);
  return (
    <>
      <Card>
        <Title>
          {inUse
            ? ctx.t(stays ? 'whatIf.stays' : toBackup ? 'whatIf.backup' : 'whatIf.moves', {
                option: optionTitle(ctx, inUse),
              })
            : recommended
              ? ctx.t('whatIf.rechooseRecommended', { option: optionTitle(ctx, recommended) })
              : ctx.t('whatIf.rechoose')}
        </Title>
        {lostBackup && declined && (
          <Text>{ctx.t('whatIf.backupLost', { option: optionTitle(ctx, declined) })}</Text>
        )}
        {reply && (
          <Text>
            {reply.evening
              ? ctx.t('decide.replyBy', {
                  night: day(ctx, reply.evening),
                  fallback: optionTitle(ctx, reply.fallback),
                })
              : ctx.t('decide.replySoon', {
                  deadline: dayTime(ctx, reply.deadline),
                  fallback: optionTitle(ctx, reply.fallback),
                })}
          </Text>
        )}
        {lines.length > 0 && (
          <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
            <Label tone="accent">{ctx.t('whatIf.changes')}</Label>
            {lines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </div>
        )}
      </Card>
      {after && !inUse && others.length > 0 && (
        <ChoiceClock
          t={ctx.t}
          lang={ctx.lang}
          tz={ctx.tz}
          now={ctx.now}
          until={until}
          options={others.map((o) => ({
            key: o.key,
            title: optionTitle(ctx, o),
            ...(o.decisionDeadline ? { deadline: o.decisionDeadline } : {}),
            expired: o.expired,
          }))}
        />
      )}
    </>
  );
}
