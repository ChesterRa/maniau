// 通用の「すること」の画面：家族の言ったことを欄で足す表と、一つの「すること」を決める画面（やり方を選ぶ・本命を
// 選ぶ・まだ受け持ちを確かめられていない時間）。場面の言葉を入れず、「すること」の欄と、家族が登録したやり方の
// データだけで組む（02-foundation §3.4）。計算はサーバー（見る口と命令）。保存は、見た物と同じ計算の時だけ。
import {
  type CorrectedInterpretation,
  formatDateTime,
  type HouseholdPreview,
  type Item,
  type NeedInterpretation,
  needStep,
  type SaveablePreview,
  SELF_WAY_ID,
  zonedToEpochMinutes,
} from '@maniau/core';
import { useState } from 'react';
import { localDate } from './format';
import { householdPreviewLines } from './household';
import {
  ConditionLine,
  type Ctx,
  Missing,
  NoticeText,
  nameOf,
  needGaps,
  needItem,
  needWhen,
  OptionChooser,
  ReadingShown,
  succeeded,
} from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text } from './ui';
import { wayLines } from './ways';

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

/** サーバーが断った理由の符号を、画面の言葉の鍵にする（知らない物は一つにまとめる）。 */
function refusedKey(reason: string): string {
  if (reason === 'itemGone' || reason === 'sourceWithdrawn') return 'needGone';
  return [
    'needWindowMissing',
    'needWindowOvernight',
    'needMemberUnknown',
    'needDeadlineMissing',
    'needGone',
    'wayUnknown',
    'wayInactive',
    'unavailable',
    'candidatesNeedWindow',
    'candidateDuplicate',
    'candidateUnknown',
    'candidateNeedTimeLocked',
    'candidateChanged',
    'decisionInUse',
    'thingPast',
    'selfWayChanged',
    'dateWeekdayMismatch',
    'legacyRequestUnclear',
  ].includes(reason)
    ? reason
    : 'other';
}

/**
 * 見る → 保存。見た物は、見た時の命令（の要約）と一緒に持ち、欄や選びが替われば見せない（替わった中身を、
 * 前に見た物で保存しない）。保存は、見た計画の番号と見た物の要約を付ける（サーバーが同じ計算で確かめる）。
 */
export function usePreviewSave(ctx: Ctx) {
  const [shown, setShown] = useState<{ key: string; preview: HouseholdPreview }>();
  const [refused, setRefused] = useState<{ key: string; reason: string }>();
  const [busy, setBusy] = useState(false);
  const keyOf = (command: SaveablePreview) => JSON.stringify(command);
  const look = async (command: SaveablePreview) => {
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
  const save = async (command: SaveablePreview): Promise<boolean> => {
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
    shownFor: (command: SaveablePreview) =>
      shown?.key === keyOf(command) ? shown.preview : undefined,
    refusedFor: (command: SaveablePreview) =>
      refused?.key === keyOf(command) ? refused.reason : undefined,
    look,
    save,
  };
}

/** 「この変更で変わること」（サーバーが同じ計算で出した物）か、保存できない理由。 */
export function PreviewBlock(props: {
  ctx: Ctx;
  preview?: HouseholdPreview;
  refused?: string;
  /** 計画の差の表に出ない、この変更で変わること（画面が今の状態から確かに言える物）。 */
  notes?: readonly string[];
}) {
  const { ctx, preview, refused, notes = [] } = props;
  if (refused) return <Text>{ctx.t(`need.refused.${refusedKey(refused)}`)}</Text>;
  if (!preview) return null;
  const lines = [...notes, ...householdPreviewLines(ctx, preview)];
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

// ── 一言で足す ──────────────────────────────

/**
 * いつまでに何をするかと、だれがするかだけで「すること」を足す（一つの命令 addThing）。家族の一言をそのまま「何を」
 * にし、日（時刻は空でよい。空ならその日のうち）とする大人を選ぶ。自分たちで済ませるやり方（家に無ければ足す）を
 * 本命にして、その人に作業を提案する（自分を選んでも、引き受けるのは「きょう」で）。時間の窓・日の候補・だれの
 * ためは、詳しい表で入れる。保存の前に、変わることを見る。
 */
export function AddThingScreen({ ctx }: { ctx: Ctx }) {
  const adults = ctx.household.members.filter((m) => m.active && m.kind === 'adult');
  const [text, setText] = useState('');
  const [date, setDate] = useState(() => localDate(ctx.now, ctx.tz));
  const [byTime, setByTime] = useState('');
  const [who, setWho] = useState(() =>
    adults.some((m) => m.id === ctx.me.id) ? ctx.me.id : (adults[0]?.id ?? ''),
  );
  const flow = usePreviewSave(ctx);
  const filled = text.trim() !== '' && date !== '' && who !== '';
  const command: SaveablePreview | undefined = filled
    ? {
        type: 'addThing',
        text: text.trim(),
        date,
        ...(byTime ? { byTime } : {}),
        assigneeId: who,
        wayName: ctx.t('need.thing.wayName'),
        stepName: ctx.t('need.thing.stepName'),
      }
    : undefined;
  const shown = command && flow.shownFor(command);
  const refused = command && flow.refusedFor(command);
  const save = async () => {
    if (command && (await flow.save(command))) ctx.go({ name: 'today' });
  };
  // 家にまだ無ければ、自分たちで済ませるやり方を足す（今の家の情報から、画面が確かに言える事）。
  const selfWay = ctx.household.ways.find((w) => w.id === SELF_WAY_ID);
  const notes = selfWay ? [] : [ctx.t('need.thing.newWay', { name: ctx.t('need.thing.wayName') })];
  // 置き方の前提（かかる時間と、する所）は家族が入れていないので、そうと書く（できると確かめた事ではない）。家に
  // あるやり方を使う時は、その手順の時間と区間で書く。
  const step = selfWay?.steps[0];
  const assumed = ctx.t('need.thing.assumed', {
    min: step?.durationMin ?? 15,
    where: new Intl.ListFormat(ctx.lang, { type: 'disjunction' }).format(
      (step?.segments ?? ['home', 'work']).map((s) =>
        ctx.t('need.thing.where', { kind: ctx.t(`household.week.kind.${s}`) }),
      ),
    ),
  });
  const field = 'flex flex-col gap-1';
  const label = 'text-sm font-bold text-sub';
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        title={ctx.t('need.add.title')}
      />
      <Main>
        <Text quiet>{ctx.t('need.thing.intro')}</Text>
        <Card>
          <label className={field}>
            <span className={label}>{ctx.t('need.thing.what')}</span>
            <input
              className={input}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="text-sm text-sub">{ctx.t('need.thing.example')}</span>
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={field}>
              <span className={label}>{ctx.t('need.thing.date')}</span>
              <input
                type="date"
                className={input}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className={field}>
              <span className={label}>{ctx.t('need.thing.byTime')}</span>
              <input
                type="time"
                className={input}
                value={byTime}
                onChange={(e) => setByTime(e.target.value)}
              />
            </label>
          </div>
          <fieldset className={field}>
            <legend className={label}>{ctx.t('need.thing.who')}</legend>
            {adults.map((m) => (
              <label key={m.id} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="thing-who"
                  className="size-5 accent-accent"
                  checked={who === m.id}
                  onChange={() => setWho(m.id)}
                />
                {m.name}
              </label>
            ))}
          </fieldset>
        </Card>
        <Text quiet>{assumed}</Text>
        {!filled && <Text quiet>{ctx.t('need.thing.missing')}</Text>}
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
          notes={notes}
        />
        <Row>
          {shown ? (
            <Button onClick={() => void save()} disabled={flow.busy}>
              {ctx.t('need.thing.save')}
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
        <MoreLink onClick={() => ctx.go({ name: 'stateNeed' })}>
          {ctx.t('need.thing.detailed')}
        </MoreLink>
      </Main>
    </>
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
  // 窓の形で、日を相手の答えで決める時の候補（2〜8）と、窓の間ずっとだれかが受け持つ必要があるか。
  const [byAnswers, setByAnswers] = useState(false);
  const [slots, setSlots] = useState(() =>
    [0, 1].map((n) => ({ key: n, date: localDate(ctx.now, ctx.tz), from: '', to: '' })),
  );
  const [hold, setHold] = useState(true);
  const flow = usePreviewSave(ctx);
  const people = ctx.household.members.filter(
    (m) => m.active && (m.kind === 'adult' || m.kind === 'child'),
  );
  const candidates = shape === 'window' && byAnswers;
  const filled =
    text.trim() !== '' &&
    what.trim() !== '' &&
    (candidates
      ? slots.length >= 2 && slots.every((s) => s.date !== '' && s.from !== '' && s.to !== '')
      : date !== '' && (shape === 'by' || (from !== '' && to !== '')));
  const interpretation = (): NeedInterpretation => {
    const who = forId ? { forMemberId: forId } : {};
    // 受け持ちが要るか：要らない時だけ書く（書かなければ要る。既定の値で埋めない）。
    const held = shape === 'window' && !hold ? { holdNeeded: false } : {};
    if (candidates) return { what: what.trim(), shape, ...who, ...held };
    const base = { what: what.trim(), shape, date, ...who, ...held };
    if (shape === 'window') return { ...base, startTime: from, endTime: to };
    return {
      ...base,
      deadline: formatDateTime(zonedToEpochMinutes(date, byTime || '00:00', ctx.tz), ctx.tz),
      ...(byTime ? {} : { deadlineDayOnly: true as const }),
    };
  };
  const command: SaveablePreview | undefined = filled
    ? {
        type: 'stateNeed',
        text: text.trim(),
        interpretation: interpretation(),
        ...(candidates
          ? {
              candidates: slots.map((s) => ({ date: s.date, startTime: s.from, endTime: s.to })),
            }
          : {}),
      }
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
          {shape === 'window' && (
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={byAnswers}
                onChange={(e) => setByAnswers(e.target.checked)}
              />
              {ctx.t('need.add.byAnswers')}
            </label>
          )}
          {candidates ? (
            <div className="flex flex-col gap-2">
              <Text quiet>{ctx.t('need.add.candidatesNote')}</Text>
              {slots.map((s, index) => (
                <div key={s.key} className="flex flex-wrap items-end gap-2">
                  <label className={field}>
                    <span className={label}>{ctx.t('need.add.candidate', { n: index + 1 })}</span>
                    <input
                      type="date"
                      className={input}
                      value={s.date}
                      onChange={(e) =>
                        setSlots((list) =>
                          list.map((x) => (x.key === s.key ? { ...x, date: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label className={field}>
                    <span className={label}>{ctx.t('need.add.from')}</span>
                    <input
                      type="time"
                      className={input}
                      value={s.from}
                      onChange={(e) =>
                        setSlots((list) =>
                          list.map((x) => (x.key === s.key ? { ...x, from: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label className={field}>
                    <span className={label}>{ctx.t('need.add.to')}</span>
                    <input
                      type="time"
                      className={input}
                      value={s.to}
                      onChange={(e) =>
                        setSlots((list) =>
                          list.map((x) => (x.key === s.key ? { ...x, to: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  {slots.length > 2 && (
                    <MoreLink
                      onClick={() => setSlots((list) => list.filter((x) => x.key !== s.key))}
                    >
                      {ctx.t('need.add.removeCandidate')}
                    </MoreLink>
                  )}
                </div>
              ))}
              {slots.length < 8 && (
                <MoreLink
                  onClick={() =>
                    setSlots((list) => [
                      ...list,
                      {
                        key: Math.max(...list.map((x) => x.key)) + 1,
                        date: list.at(-1)?.date ?? localDate(ctx.now, ctx.tz),
                        from: list.at(-1)?.from ?? '',
                        to: list.at(-1)?.to ?? '',
                      },
                    ])
                  }
                >
                  {ctx.t('need.add.addCandidate')}
                </MoreLink>
              )}
            </div>
          ) : (
            <label className={field}>
              <span className={label}>{ctx.t('need.add.date')}</span>
              <input
                type="date"
                className={input}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          )}
          {candidates ? null : shape === 'window' ? (
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
          {shape === 'window' && (
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={hold}
                onChange={(e) => setHold(e.target.checked)}
              />
              {ctx.t('need.add.hold')}
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
/**
 * モデルが読んだ出典の事項か（家族の言明〔stateNeed〕には読み取りが無い）。送り手が家族のお知らせでも、
 * モデルが読んだ物は読み取りとして扱う（条件や読み取りの印を見せ、外す理由を聞く）。
 */
function readByModel(ctx: Ctx, item: Item): boolean {
  return ctx.readings.some((r) => r.sourceId === item.sourceId);
}

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
  const choosingWays = step === 'ways' || step === 'waysChanged' || step === 'waysStopped';
  const ways = item && (
    <WaysPicker
      key={`${item.id}|${arrangement.options.map((o) => o.templateId).join(',')}`}
      ctx={ctx}
      itemId={item.id}
      arrangementKey={arrangement.key}
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
          {requirement?.when && (
            <MoreLink onClick={() => ctx.go({ name: 'when', key: requirement.key })}>
              {ctx.t('when.fromNeed')}
            </MoreLink>
          )}
          <ConditionLine
            ctx={ctx}
            basis={{
              itemIds: requirement?.basis.itemIds ?? [],
              requirementKey: arrangement.requirementKey,
              arrangementKey: arrangement.key,
            }}
          />
          <Text quiet>
            {ctx.t(item && !readByModel(ctx, item) ? 'need.stated' : 'need.written')}
          </Text>
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
        {item && <NeedActions key={item.id} ctx={ctx} item={item} />}
        {arrangement.reasons.some((r) => r.code === 'turnedDown') && (
          <Card tone="warn">
            <Text>{ctx.t('card.decide.turnedDown')}</Text>
          </Card>
        )}
        {(step === 'stuck' || step === 'noSlot' || step === 'waysStopped') && (
          <Card tone="warn">
            <Text>{ctx.t(`card.need.${step}`)}</Text>
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

/**
 * 計画に入っている「すること」を直す・要らないにする入口。直すは直す画面へ。要らないは（お知らせから読んだ物は理由を
 * 選び）、この変更で変わること（要らなくなる引き受け・頼んだ相手への取り消しの連絡など）を見てから決める。
 */
export function NeedActions({ ctx, item }: { ctx: Ctx; item: Item }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<'other' | 'notOurs' | 'misread'>('other');
  const [failed, setFailed] = useState(false);
  const flow = usePreviewSave(ctx);
  const read = readByModel(ctx, item);
  if (!open) {
    return (
      <div className="flex flex-wrap gap-x-5">
        <MoreLink onClick={() => ctx.go({ name: 'needFix', itemId: item.id })}>
          {ctx.t('need.edit')}
        </MoreLink>
        <MoreLink onClick={() => setOpen(true)}>{ctx.t('need.dismiss.open')}</MoreLink>
      </div>
    );
  }
  const command: SaveablePreview = { type: 'dismissItem', itemId: item.id, reason };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const save = async () => {
    setFailed(false);
    if (await flow.save(command)) ctx.go({ name: 'today' });
    else setFailed(true);
  };
  return (
    <Card>
      <Label tone="warn">{ctx.t('need.dismiss.label')}</Label>
      {read && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-bold text-sub">{ctx.t('need.dismiss.reason')}</legend>
          {(['other', 'notOurs', 'misread'] as const).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="need-dismiss-reason"
                className="size-5 accent-accent"
                checked={reason === value}
                onChange={() => setReason(value)}
              />
              {ctx.t(`need.dismiss.reasons.${value}`)}
            </label>
          ))}
        </fieldset>
      )}
      <Text quiet>{ctx.t('need.dismiss.note')}</Text>
      <PreviewBlock
        ctx={ctx}
        {...(shown ? { preview: shown } : {})}
        {...(refused ? { refused } : {})}
      />
      {failed && <Text>{ctx.t('need.fix.changedPreview')}</Text>}
      <Row>
        {shown ? (
          <Button onClick={() => void save()} disabled={flow.busy}>
            {ctx.t('need.dismiss.save')}
          </Button>
        ) : (
          <Button
            onClick={() => void flow.look(command)}
            disabled={flow.busy || !ctx.previewChange}
          >
            {ctx.t('need.look')}
          </Button>
        )}
      </Row>
      <MoreLink onClick={() => setOpen(false)}>{ctx.t('need.dismiss.close')}</MoreLink>
    </Card>
  );
}

/**
 * 使うやり方を選ぶ（家族が登録したやり方から。ここで作らない・推し量らない）。選ぶまで作業は作らない。選んだ後に
 * 中身かやり方が変わったら、選び直してもらう。保存の前に、変わることを見る。
 */
function WaysPicker(props: {
  ctx: Ctx;
  itemId: string;
  arrangementKey: string;
  chosen: string[];
  changed: boolean;
}) {
  const { ctx, itemId, arrangementKey, chosen, changed } = props;
  // やめたやり方は、今の選びに入っている物だけ出す（残せる。外すと、もう選べない）。
  const stopped = new Set(ctx.household.stoppedWayIds ?? []);
  const ways = ctx.household.ways.filter((w) => !stopped.has(w.id) || chosen.includes(w.id));
  const [picked, setPicked] = useState<string[]>(chosen);
  const flow = usePreviewSave(ctx);
  // 家庭の並びで送る（同じ選びを、押した順で別の物にしない）。
  const wayIds = ways.filter((w) => picked.includes(w.id)).map((w) => w.id);
  const command: SaveablePreview = { type: 'setNeedWays', itemId, wayIds };
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
              {stopped.has(way.id) && (
                <span className="text-sm font-bold text-warn">{ctx.t('need.ways.stopped')}</span>
              )}
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
      <MoreLink onClick={() => ctx.go({ name: 'way', from: arrangementKey })}>
        {ctx.t('need.ways.add')}
      </MoreLink>
      {ctx.wayIdeas && (
        <MoreLink onClick={() => ctx.go({ name: 'wayIdeas', key: arrangementKey })}>
          {ctx.t('wayIdeas.entry')}
        </MoreLink>
      )}
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

/**
 * 「すること」を直す。まだ確かめていないモデルの読み取りは、元の文を見ながら直す（直すと「家族が確認」になり、計画に
 * 入る。保存は見せた時の番号を付ける）。計画に入っている物（家族の言明か、家族が確かめた読み取り）は、保存の前に
 * 「この変更で変わること」（選び直し・頼んだ相手への確かめ・要らなくなる引き受け）を見せ、見た物で保存する。何を・日・
 * 時刻（締切の時刻が空なら、その日の終わりまで）・だれのためを入れる。形は替えない（読み取りに形が無かった時だけ選ぶ）。
 */
export function NeedFixScreen({ ctx, itemId }: { ctx: Ctx; itemId: string }) {
  const live = ctx.items.find((l) => l.item.id === itemId);
  const i = live?.item.interpretation;
  const [what, setWhat] = useState(i?.what ?? live?.item.written ?? '');
  const [shape, setShape] = useState<'window' | 'by'>(i?.shape ?? 'window');
  // 締切の形の「日」は締切の日（読み取りの日付は、行事の日のことがある）。読み取りにも原文にも日が無ければ空にし、
  // 家族が入れるまで保存させない（きょうの日を、家族が確かめた日にしない）。
  const [date, setDate] = useState(
    (i?.shape === 'by'
      ? (i.deadline?.slice(0, 10) ?? i.date)
      : (i?.date ?? i?.deadline?.slice(0, 10))) ?? '',
  );
  const [from, setFrom] = useState(i?.startTime ?? '');
  const [to, setTo] = useState(i?.endTime ?? '');
  const [byTime, setByTime] = useState(
    i?.deadline && i.deadlineDayOnly !== true ? i.deadline.slice(11, 16) : '',
  );
  const [forId, setForId] = useState(i?.forMemberId ?? '');
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const flow = usePreviewSave(ctx);
  // まだ確かめていない読み取りか（計画に入っていない）。計画に入っている物は、見てから保存し、その「すること」へ戻る。
  const awaiting = ctx.plan.requirements.some(
    (r) => r.unconfirmed === true && r.basis.itemIds.includes(itemId),
  );
  const arrangement = ctx.plan.arrangements.find(
    (a) =>
      a.kind === 'need' &&
      ctx.plan.requirements.find((r) => r.key === a.requirementKey)?.basis.itemIds.includes(itemId),
  );
  // いつにするかの候補のある「すること」：日と時刻は候補が持つ（サーバーも、ここからは直させない）。日の欄を出さず、
  // 何を・だれのためのうち替えた欄だけを送り、「いつにするか」へ戻る（直すと候補の代が進み、集めた答えを数えなくなる
  // ので、何も替えていなければ送らない）。
  const byAnswers = ctx.plan.requirements.find(
    (r) => r.when !== undefined && r.basis.itemIds.includes(itemId),
  );
  const back = () =>
    byAnswers
      ? ctx.go({ name: 'when', key: byAnswers.key })
      : !awaiting && arrangement
        ? ctx.go({ name: 'need', key: arrangement.key })
        : ctx.go({ name: 'today' });
  const backLabel = ctx.t(
    byAnswers ? 'when.eyebrow' : !awaiting && arrangement ? 'need.label' : 'nav.today',
  );
  if (!live || !i) {
    return (
      <>
        <Header back={{ label: backLabel, onClick: back }} title={ctx.t('need.fix.title')} />
        <Main>
          <Text>{ctx.t('need.refused.needGone')}</Text>
        </Main>
      </>
    );
  }
  const source = ctx.sources.get(live.item.sourceId);
  const stated = !readByModel(ctx, live.item);
  const people = ctx.household.members.filter(
    (m) => m.active && (m.kind === 'adult' || m.kind === 'child'),
  );
  const filled =
    what.trim() !== '' &&
    (byAnswers !== undefined || (date !== '' && (shape === 'by' || (from !== '' && to !== ''))));
  const base = {
    what: what.trim(),
    ...(i.shape === undefined ? { shape } : {}),
    // 選ばないにしたら、前の「だれのため」を外す（直しは前の欄に重ねるので、外すには null を送る）。
    ...(forId ? { forMemberId: forId } : i.forMemberId !== undefined ? { forMemberId: null } : {}),
  };
  const changed = {
    ...(what.trim() !== (i.what ?? live.item.written) ? { what: what.trim() } : {}),
    ...(forId !== (i.forMemberId ?? '') ? { forMemberId: forId === '' ? null : forId } : {}),
  };
  const interpretation: CorrectedInterpretation | undefined = !filled
    ? undefined
    : byAnswers
      ? Object.keys(changed).length > 0
        ? changed
        : undefined
      : shape === 'window'
        ? { ...base, date, startTime: from, endTime: to }
        : {
            ...base,
            deadline: formatDateTime(zonedToEpochMinutes(date, byTime || '00:00', ctx.tz), ctx.tz),
            deadlineDayOnly: byTime === '',
          };
  const command: SaveablePreview | undefined = interpretation && {
    type: 'correctItem',
    itemId,
    interpretation,
  };
  const shown = command && !awaiting ? flow.shownFor(command) : undefined;
  const refused = command && !awaiting ? flow.refusedFor(command) : undefined;
  // 候補のある物を直すと、サーバーは全部の候補の代を進める：今の答えは数えなくなり、決めた日は使わなくなる。選んだ
  // やり方も、中身が変わるので選び直しになる（どれも、決める前は計画の差の表に出ないので、今の状態から言う）。
  const resets = byAnswers?.when
    ? [
        ...(byAnswers.when.answers.length > 0
          ? [ctx.t('need.fix.answersReset', { count: byAnswers.when.answers.length })]
          : []),
        ...(byAnswers.when.chosen ? [ctx.t('need.fix.chosenReset')] : []),
        ...(byAnswers.when.candidates.some((c) => c.ways.length > 0)
          ? [ctx.t('need.fix.waysReset')]
          : []),
      ]
    : [];
  const save = async () => {
    if (!command) return;
    setFailed(undefined);
    if (!awaiting) {
      if (await flow.save(command)) back();
      else setFailed('changedPreview');
      return;
    }
    setBusy(true);
    const result = await ctx.send({ ...command, seen: { throughSeq: ctx.plan.throughSeq } });
    setBusy(false);
    if (succeeded(result)) back();
    else setFailed(('reason' in result && result.reason) || 'other');
  };
  const field = 'flex flex-col gap-1';
  const label = 'text-sm font-bold text-sub';
  return (
    <>
      <Header
        back={{ label: backLabel, onClick: back }}
        title={ctx.t(awaiting ? 'need.fix.title' : 'need.fix.titlePlanned')}
      />
      <Main>
        <Text quiet>{ctx.t(awaiting ? 'need.fix.intro' : 'need.fix.introPlanned')}</Text>
        <NoticeText source={source} cited={live.item.sentenceIds} t={ctx.t} />
        {!stated && <ReadingShown ctx={ctx} live={live} />}
        {!stated &&
          (live.item.conditionNodeId !== undefined || (live.answers ?? []).length > 0) &&
          live.unshown !== true && (
            <Text quiet>
              {ctx.t(awaiting ? 'need.fix.conditionNote' : 'need.fix.conditionNotePlanned')}
            </Text>
          )}
        <Card>
          <label className={field}>
            <span className={label}>{ctx.t('need.add.what')}</span>
            <input
              className={input}
              maxLength={200}
              value={what}
              onChange={(e) => setWhat(e.target.value)}
            />
          </label>
          {byAnswers ? (
            <Text quiet>{ctx.t('need.fix.candidateTime')}</Text>
          ) : (
            <>
              {i.shape === undefined ? (
                <fieldset className={field}>
                  <legend className={label}>{ctx.t('need.add.shape')}</legend>
                  {(['window', 'by'] as const).map((value) => (
                    <label key={value} className="flex min-h-11 items-center gap-2">
                      <input
                        type="radio"
                        name="need-fix-shape"
                        className="size-5 accent-accent"
                        checked={shape === value}
                        onChange={() => setShape(value)}
                      />
                      {ctx.t(`need.add.${value}`)}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <Text quiet>
                  {ctx.t(awaiting ? 'need.fix.shape' : 'need.fix.shapePlanned', {
                    shape: ctx.t(`need.add.${i.shape}`),
                  })}
                </Text>
              )}
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
            </>
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
        {failed !== undefined && (
          <Text>
            {failed === 'changedPreview'
              ? ctx.t('need.fix.changedPreview')
              : fixRefused(ctx, failed)}
          </Text>
        )}
        {live.unshown !== true &&
          (awaiting ? (
            <Row>
              <Button onClick={() => void save()} disabled={!filled || busy}>
                {ctx.t('need.fix.save')}
              </Button>
            </Row>
          ) : (
            <>
              <PreviewBlock
                ctx={ctx}
                notes={resets}
                {...(shown ? { preview: shown } : {})}
                {...(refused ? { refused } : {})}
              />
              <Row>
                {shown ? (
                  <Button onClick={() => void save()} disabled={flow.busy}>
                    {ctx.t('need.fix.savePlanned')}
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
            </>
          ))}
      </Main>
    </>
  );
}

/** 直す画面で断られた理由の文。見せた後に中身が変わった時は、きょうの札で見直してもらう。 */
function fixRefused(ctx: Ctx, reason: string): string {
  if (reason === 'itemChanged' || reason === 'seenAhead') return ctx.t('need.fix.changed');
  if (reason === 'itemGone' || reason === 'sourceWithdrawn') return ctx.t('need.refused.needGone');
  if (reason === 'rereadPending') return ctx.t('card.needCheck.failed.rereadPending');
  if (reason === 'readingUnshown') return ctx.t('card.needCheck.failed.readingUnshown');
  return ctx.t(`need.refused.${refusedKey(reason)}`);
}
