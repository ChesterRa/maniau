// お知らせの原文と読み取った日を見比べて直す。保存の前にはサーバーの計算で変わる事を見る。
import {
  type Item,
  isValidLocalDate,
  type SaveablePreview,
  type Source,
  weekdayOf,
} from '@maniau/core';
import { useState } from 'react';
import { formatDay } from './format';
import { PreviewBlock, usePreviewSave } from './need';
import type { Ctx } from './screens';
import { Button, Label, Row, Text } from './ui';

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

function DateEdit({
  ctx,
  item,
  live,
  trusted,
  links,
}: {
  ctx: Ctx;
  item: Item;
  live: boolean;
  trusted: boolean;
  links: { label?: string; value: string }[];
}) {
  const [date, setDate] = useState(item.interpretation.date ?? '');
  const flow = usePreviewSave(ctx);
  const command: SaveablePreview = {
    type: 'correctItem',
    itemId: item.id,
    interpretation: { date },
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const linked = links.length > 0 && date !== item.interpretation.date;
  const wrongWeekday =
    isValidLocalDate(date) &&
    item.interpretation.writtenWeekday !== undefined &&
    weekdayOf(date) !== item.interpretation.writtenWeekday;
  const valid =
    isValidLocalDate(date) &&
    (date !== item.interpretation.date || !trusted) &&
    !linked &&
    !wrongWeekday;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{item.written}</Text>
      <Text quiet>
        {item.interpretation.date
          ? ctx.t('sourceFix.date.read', {
              date: formatDay(item.interpretation.date, ctx.lang, ctx.tz),
            })
          : ctx.t('sourceFix.date.missing')}
      </Text>
      {!live && <Text quiet>{ctx.t('sourceFix.date.inactive')}</Text>}
      {!trusted && <Text>{ctx.t('sourceFix.date.unconfirmed')}</Text>}
      {wrongWeekday && (
        <div role="status">
          <Text>{ctx.t('sourceFix.date.weekdayMismatch')}</Text>
          <Text>
            {ctx.t(
              ctx.read ? 'sourceFix.date.weekdayHelp' : 'sourceFix.date.weekdayHelpUnavailable',
            )}
          </Text>
        </div>
      )}
      {linked && (
        <div className="flex flex-col gap-1" role="status">
          {links.map((link, index) => (
            <Text key={link.label ?? index}>
              {ctx.t('sourceFix.date.link', {
                label: link.label ?? ctx.t('sourceFix.date.unknownCondition'),
                date: formatDay(link.value, ctx.lang, ctx.tz),
              })}
            </Text>
          ))}
          <Text>
            {ctx.t(ctx.read ? 'sourceFix.date.linkHelp' : 'sourceFix.date.linkHelpUnavailable')}
          </Text>
        </div>
      )}
      <label className="flex flex-col gap-1">
        {ctx.t('sourceFix.date.label')}
        <input
          className={input}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {refused === 'legacyRequestUnclear' ? (
        <Text>{ctx.t('sourceFix.date.legacy')}</Text>
      ) : refused === 'dateLinkedCondition' ? (
        <div className="flex flex-col gap-2" role="status">
          <Text>{ctx.t('sourceFix.date.changed')}</Text>
          {ctx.refresh && (
            <Button kind="secondary" onClick={ctx.refresh}>
              {ctx.t('sourceFix.date.refresh')}
            </Button>
          )}
        </div>
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown ? (
          <Button disabled={flow.busy || !valid} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.date.save')}
          </Button>
        ) : (
          <Button
            disabled={flow.busy || !valid || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

function DiscardEdit({ ctx, source }: { ctx: Ctx; source: Source }) {
  const flow = usePreviewSave(ctx);
  const [reason, setReason] = useState<'misfiled' | 'misread'>();
  const command: SaveablePreview = {
    type: 'discardSource',
    sourceId: source.id,
    reason: reason ?? 'misfiled',
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{ctx.t('sourceFix.discard.body')}</Text>
      <Text>{ctx.t('sourceFix.discard.noUndo')}</Text>
      <Text>
        {ctx.t(ctx.read ? 'sourceFix.discard.readd' : 'sourceFix.discard.readdUnavailable')}
      </Text>
      <fieldset className="flex flex-col gap-2">
        <legend>{ctx.t('sourceFix.discard.reason')}</legend>
        {(['misfiled', 'misread'] as const).map((choice) => (
          <label key={choice} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`discard-${source.id}`}
              value={choice}
              checked={reason === choice}
              onChange={() => setReason(choice)}
            />
            {ctx.t(`sourceFix.discard.${choice}`)}
          </label>
        ))}
      </fieldset>
      {refused === 'legacyRequestUnclear' ? (
        <Text>{ctx.t('sourceFix.discard.legacy')}</Text>
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown ? (
          <Button disabled={flow.busy} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.discard.save')}
          </Button>
        ) : (
          <Button
            kind="secondary"
            disabled={flow.busy || !reason || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

/** 原文を残したまま、読み取った日を直す・入れ間違えたお知らせを外す。 */
export function SourceEdits({ ctx, source }: { ctx: Ctx; source: Source }) {
  const excluded = ctx.excludedSources?.get(source.id);
  // 家族が直接書いた「すること」は読み取りではない。専用の画面から直す・要らなくする。
  if (!excluded && !ctx.readings.some((reading) => reading.sourceId === source.id)) return null;
  const editable = ctx.items.filter(
    ({ item }) =>
      item.sourceId === source.id &&
      item.kind !== 'need' &&
      (item.interpretation.date !== undefined ||
        ['event', 'dayChange', 'test'].includes(item.kind)),
  );
  return (
    <div className="flex flex-col gap-2">
      {excluded && <Text>{ctx.t(`sourceFix.discard.excluded.${excluded}`)}</Text>}
      {!excluded && editable.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.date.open')}
          </summary>
          <div className="flex flex-col gap-2">
            <Label tone="sub">{ctx.t('sourceFix.date.compare')}</Label>
            {editable.map(({ item, live, trusted, dateLinks }) => (
              <DateEdit
                key={item.id}
                ctx={ctx}
                item={item}
                live={live}
                trusted={trusted}
                links={dateLinks ?? []}
              />
            ))}
          </div>
        </details>
      )}
      {!excluded && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.discard.open')}
          </summary>
          <DiscardEdit ctx={ctx} source={source} />
        </details>
      )}
    </div>
  );
}
