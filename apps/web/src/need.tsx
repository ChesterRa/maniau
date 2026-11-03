// 通用の「すること」の画面：家族の言ったことを欄で足す表と、一つの「すること」を決める画面（やり方を選ぶ・本命を
// 選ぶ・まだ受け持ちを確かめられていない時間）。場面の言葉を入れず、「すること」の欄と、家族が登録したやり方の
// データだけで組む（02-foundation §3.4）。計算はサーバー（見る口と命令）。保存は、見た物と同じ計算の時だけ。
import {
  formatDateTime,
  type HouseholdPreview,
  type NeedInterpretation,
  type PreviewCommand,
  type Way,
  zonedToEpochMinutes,
} from '@maniau/core';
import { useState } from 'react';
import { localDate } from './format';
import { deadlineText, householdPreviewLines } from './household';
import {
  ConditionLine,
  type Ctx,
  Missing,
  nameOf,
  needGaps,
  needItem,
  needStep,
  needWhen,
  OptionChooser,
} from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text } from './ui';

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

/** サーバーが断った理由の符号を、画面の言葉の鍵にする（知らない物は一つにまとめる）。 */
function refusedKey(reason: string): string {
  return [
    'needWindowMissing',
    'needWindowOvernight',
    'needMemberUnknown',
    'needDeadlineMissing',
    'needGone',
    'wayUnknown',
    'unavailable',
  ].includes(reason)
    ? reason
    : 'other';
}

/**
 * 見る → 保存。見た物は、見た時の命令（の要約）と一緒に持ち、欄や選びが替われば見せない（替わった中身を、
 * 前に見た物で保存しない）。保存は、見た計画の番号と見た物の要約を付ける（サーバーが同じ計算で確かめる）。
 */
function usePreviewSave(ctx: Ctx) {
  const [shown, setShown] = useState<{ key: string; preview: HouseholdPreview }>();
  const [refused, setRefused] = useState<{ key: string; reason: string }>();
  const [busy, setBusy] = useState(false);
  const keyOf = (command: PreviewCommand) => JSON.stringify(command);
  const look = async (command: PreviewCommand) => {
    if (!ctx.previewChange) return;
    const key = keyOf(command);
    setBusy(true);
    const result = await ctx.previewChange(command);
    setBusy(false);
    if (!result) setRefused({ key, reason: 'unavailable' });
    else if ('refused' in result) setRefused({ key, reason: result.refused });
    else {
      setShown({ key, preview: result.preview });
      setRefused(undefined);
    }
  };
  const save = async (command: PreviewCommand): Promise<boolean> => {
    const seen = shown?.key === keyOf(command) ? shown.preview : undefined;
    if (!seen) return false;
    setBusy(true);
    const result = await ctx.send({
      ...command,
      seen: { throughSeq: seen.throughSeq, changes: seen.seen },
    });
    setBusy(false);
    // 断られた時（見た後に計画が変わった等）は、見た物を捨てて、もう一度見てもらう。
    setShown(undefined);
    return result.status === 'ok' || result.status === 'noop';
  };
  return {
    busy,
    shownFor: (command: PreviewCommand) =>
      shown?.key === keyOf(command) ? shown.preview : undefined,
    refusedFor: (command: PreviewCommand) =>
      refused?.key === keyOf(command) ? refused.reason : undefined,
    look,
    save,
  };
}

/** 「この変更で変わること」（サーバーが同じ計算で出した物）か、保存できない理由。 */
function PreviewBlock(props: { ctx: Ctx; preview?: HouseholdPreview; refused?: string }) {
  const { ctx, preview, refused } = props;
  if (refused) return <Text>{ctx.t(`need.refused.${refusedKey(refused)}`)}</Text>;
  if (!preview) return null;
  const lines = householdPreviewLines(ctx, preview);
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
      <Label tone="accent">{ctx.t('household.preview.label')}</Label>
      {lines.length === 0 ? (
        <Text>{ctx.t('household.preview.none')}</Text>
      ) : (
        lines.map((line) => <Text key={line}>{line}</Text>)
      )}
    </div>
  );
}

// ── 足す ──────────────────────────────

/**
 * 家族が言ったことを、原文のまま書き、計算に使う欄（何を・形・日・時間か締切・だれのため）を家族が埋める。欄は
 * 推し量らない（書かれていない時刻を作らない。日だけの締切は、その日の終わりまで）。保存の前に、変わることを見る。
 */
export function StateNeedScreen({ ctx }: { ctx: Ctx }) {
  const [text, setText] = useState('');
  const [what, setWhat] = useState('');
  const [shape, setShape] = useState<'window' | 'by'>('window');
  const [date, setDate] = useState(() => localDate(ctx.now, ctx.tz));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [byTime, setByTime] = useState('');
  const [forId, setForId] = useState('');
  const flow = usePreviewSave(ctx);
  const people = ctx.household.members.filter(
    (m) => m.active && (m.kind === 'adult' || m.kind === 'child'),
  );
  const filled =
    text.trim() !== '' &&
    what.trim() !== '' &&
    date !== '' &&
    (shape === 'by' || (from !== '' && to !== ''));
  const interpretation = (): NeedInterpretation => {
    const base = { what: what.trim(), shape, date, ...(forId ? { forMemberId: forId } : {}) };
    if (shape === 'window') return { ...base, startTime: from, endTime: to };
    return {
      ...base,
      deadline: formatDateTime(zonedToEpochMinutes(date, byTime || '00:00', ctx.tz), ctx.tz),
      ...(byTime ? {} : { deadlineDayOnly: true as const }),
    };
  };
  const command: PreviewCommand | undefined = filled
    ? { type: 'stateNeed', text: text.trim(), interpretation: interpretation() }
    : undefined;
  const shown = command && flow.shownFor(command);
  const refused = command && flow.refusedFor(command);
  const save = async () => {
    if (command && (await flow.save(command))) ctx.go({ name: 'today' });
  };
  const field = 'flex flex-col gap-1';
  const label = 'text-sm font-bold text-sub';
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        title={ctx.t('need.add.title')}
      />
      <Main>
        <Text quiet>{ctx.t('need.add.intro')}</Text>
        <Card>
          <label className={field}>
            <span className={label}>{ctx.t('need.add.text')}</span>
            <textarea
              className={`${input} min-h-24 py-2`}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label className={field}>
            <span className={label}>{ctx.t('need.add.what')}</span>
            <input
              className={input}
              maxLength={200}
              value={what}
              onChange={(e) => setWhat(e.target.value)}
            />
          </label>
          <fieldset className={field}>
            <legend className={label}>{ctx.t('need.add.shape')}</legend>
            {(['window', 'by'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="need-shape"
                  className="size-5 accent-accent"
                  checked={shape === value}
                  onChange={() => setShape(value)}
                />
                {ctx.t(`need.add.${value}`)}
              </label>
            ))}
          </fieldset>
          <label className={field}>
            <span className={label}>{ctx.t('need.add.date')}</span>
            <input
              type="date"
              className={input}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {shape === 'window' ? (
            <div className="flex flex-wrap gap-3">
              <label className={field}>
                <span className={label}>{ctx.t('need.add.from')}</span>
                <input
                  type="time"
                  className={input}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className={field}>
                <span className={label}>{ctx.t('need.add.to')}</span>
                <input
                  type="time"
                  className={input}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <label className={field}>
              <span className={label}>{ctx.t('need.add.byTime')}</span>
              <input
                type="time"
                className={input}
                value={byTime}
                onChange={(e) => setByTime(e.target.value)}
              />
            </label>
          )}
          <label className={field}>
            <span className={label}>{ctx.t('need.add.for')}</span>
            <select className={input} value={forId} onChange={(e) => setForId(e.target.value)}>
              <option value="">{ctx.t('need.add.nobody')}</option>
              {people.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </Card>
        {!filled && <Text quiet>{ctx.t('need.add.missing')}</Text>}
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
        <Row>
          {shown ? (
            <Button onClick={() => void save()} disabled={flow.busy}>
              {ctx.t('need.add.save')}
            </Button>
          ) : (
            <Button
              onClick={() => command && void flow.look(command)}
              disabled={flow.busy || !command || !ctx.previewChange}
            >
              {ctx.t('need.look')}
            </Button>
          )}
        </Row>
      </Main>
    </>
  );
}

// ── 一つの「すること」 ──────────────────────────────

/**
 * 一つの「すること」で決める：何を・いつ・だれのため・元の文、まだ受け持ちを確かめられていない時間、本命を選ぶ
 * （子の居場所と同じ選ぶ所）、使うやり方を選ぶ（家族が登録したやり方から）。
 */
export function NeedScreen({ ctx, arrangementKey }: { ctx: Ctx; arrangementKey: string }) {
  const arrangement = ctx.plan.arrangements.find(
    (a) => a.key === arrangementKey && a.kind === 'need' && a.live,
  );
  if (!arrangement) return <Missing ctx={ctx} />;
  const requirement = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey);
  const item = needItem(ctx, arrangement);
  const step = needStep(arrangement);
  const gaps = needGaps(ctx, arrangement);
  const place = item?.interpretation.place;
  const forId = item?.interpretation.forMemberId;
  const source = item ? ctx.sources.get(item.sourceId) : undefined;
  const choosingWays = step === 'ways' || step === 'waysChanged';
  const ways = item && (
    <WaysPicker
      key={`${item.id}|${arrangement.options.map((o) => o.templateId).join(',')}`}
      ctx={ctx}
      itemId={item.id}
      chosen={arrangement.options.map((o) => o.templateId)}
      changed={step === 'waysChanged'}
    />
  );
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={needWhen(ctx, arrangement, item)}
        title={requirement?.what ?? ''}
      />
      <Main>
        <Card>
          <Label tone="sub">{ctx.t('need.label')}</Label>
          <Text>{needWhen(ctx, arrangement, item)}</Text>
          {forId && <Text>{ctx.t('need.for', { name: nameOf(ctx.household, forId) })}</Text>}
          {place && <Text>{ctx.t('need.place', { place })}</Text>}
          <ConditionLine
            ctx={ctx}
            basis={{
              itemIds: requirement?.basis.itemIds ?? [],
              requirementKey: arrangement.requirementKey,
              arrangementKey: arrangement.key,
            }}
          />
          <Text quiet>{ctx.t(source?.sender === 'family' ? 'need.stated' : 'need.written')}</Text>
          {item && (
            <MoreLink
              onClick={() =>
                ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
              }
            >
              {ctx.t('need.source')}
            </MoreLink>
          )}
        </Card>
        {arrangement.reasons.some((r) => r.code === 'turnedDown') && (
          <Card tone="warn">
            <Text>{ctx.t('card.decide.turnedDown')}</Text>
          </Card>
        )}
        {step === 'stuck' && (
          <Card tone="warn">
            <Text>{ctx.t('card.need.stuck')}</Text>
          </Card>
        )}
        {gaps.length > 0 && (
          <Card>
            <Label tone="warn">{ctx.t('card.need.gapsLabel')}</Label>
            {gaps.map((gap) => (
              <Text key={gap}>{gap}</Text>
            ))}
            <Text quiet>{ctx.t('need.gapsNote')}</Text>
            {place && <Text quiet>{ctx.t('need.placeNote')}</Text>}
          </Card>
        )}
        {choosingWays && ways}
        {arrangement.options.length > 0 && (
          <>
            <Label tone="sub">{ctx.t('need.options')}</Label>
            <OptionChooser ctx={ctx} arrangement={arrangement} />
          </>
        )}
        {!choosingWays && ways}
      </Main>
    </>
  );
}

/** やり方の中身を短く：手順（外の相手を待つ物は相手と待つ物）、受け持つ人と時間、決め時、代償。 */
function wayLines(ctx: Ctx, way: Way): string[] {
  const steps = way.steps
    .map((step) =>
      step.external
        ? ctx.t(`need.ways.wait.${step.external.kind}`, {
            name: step.name,
            to: nameOf(ctx.household, step.external.to),
          })
        : step.name,
    )
    .join(' → ');
  const covers = way.steps
    .filter((step) => step.cover)
    .map((step) =>
      step.external
        ? nameOf(ctx.household, step.external.to)
        : step.assigneeId
          ? nameOf(ctx.household, step.assigneeId)
          : ctx.t('need.ways.family'),
    );
  const who = new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(covers);
  const lines = [steps];
  lines.push(
    covers.length === 0
      ? ctx.t('need.ways.noCover')
      : way.covers
        ? ctx.t('need.ways.coverTime', { who, from: way.covers.start, to: way.covers.end })
        : ctx.t('need.ways.cover', { who }),
  );
  if (way.deadline) {
    lines.push(ctx.t('need.ways.deadline', { rule: deadlineText(ctx, way.deadline) }));
  }
  const cost: string[] = [];
  if (way.cost.yen > 0) cost.push(ctx.t('household.ways.yen', { yen: way.cost.yen }));
  if (way.cost.leaveMinutes > 0) {
    cost.push(ctx.t('cost.leave', { count: Math.round(way.cost.leaveMinutes / 480) || 1 }));
  }
  if (way.cost.helperRequests > 0) cost.push(ctx.t('cost.helper'));
  if (cost.length > 0) lines.push(cost.join(ctx.t('list.separator')));
  return lines;
}

/**
 * 使うやり方を選ぶ（家族が登録したやり方から。ここで作らない・推し量らない）。選ぶまで作業は作らない。選んだ後に
 * 中身かやり方が変わったら、選び直してもらう。保存の前に、変わることを見る。
 */
function WaysPicker(props: { ctx: Ctx; itemId: string; chosen: string[]; changed: boolean }) {
  const { ctx, itemId, chosen, changed } = props;
  const ways = ctx.household.ways;
  const [picked, setPicked] = useState<string[]>(chosen);
  const flow = usePreviewSave(ctx);
  // 家庭の並びで送る（同じ選びを、押した順で別の物にしない）。
  const wayIds = ways.filter((w) => picked.includes(w.id)).map((w) => w.id);
  const command: PreviewCommand = { type: 'setNeedWays', itemId, wayIds };
  const same =
    !changed && wayIds.length === chosen.length && wayIds.every((id) => chosen.includes(id));
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const toggle = (id: string) =>
    setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  return (
    <Card>
      <Label tone="sub">{ctx.t('need.ways.label')}</Label>
      {changed && <Text>{ctx.t('need.ways.changed')}</Text>}
      {ways.length === 0 ? (
        <Text>{ctx.t('need.ways.none')}</Text>
      ) : (
        ways.map((way) => (
          <label
            key={way.id}
            className="flex items-start gap-3 rounded-xl border border-line bg-white px-3 py-2.5"
          >
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0 accent-accent"
              checked={picked.includes(way.id)}
              onChange={() => toggle(way.id)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-bold">{way.name}</span>
              {wayLines(ctx, way).map((line) => (
                <span key={line} className="text-sm text-sub">
                  {line}
                </span>
              ))}
            </span>
          </label>
        ))
      )}
      <Text quiet>{ctx.t('need.ways.note')}</Text>
      <PreviewBlock
        ctx={ctx}
        {...(shown ? { preview: shown } : {})}
        {...(refused ? { refused } : {})}
      />
      {ways.length > 0 && (
        <Row>
          {shown ? (
            <Button onClick={() => void flow.save(command)} disabled={flow.busy}>
              {ctx.t('need.ways.save')}
            </Button>
          ) : (
            <Button
              onClick={() => void flow.look(command)}
              disabled={flow.busy || same || !ctx.previewChange}
            >
              {ctx.t('need.look')}
            </Button>
          )}
        </Row>
      )}
    </Card>
  );
}
