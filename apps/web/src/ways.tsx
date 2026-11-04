// 「すること」のやり方：家族が足す・直す・やめる（02-foundation §3.4・§6）。やり方は家族の言葉のデータで、場面の
// 種類を持たない（どの「すること」にも同じ表）。分からない欄は分からないのまま（0・決まり無しに置き換えない）。保存の
// 前に「この変更で変わること」を見せる（サーバーが書き込まずに、書く時と同じ命令と同じ計算で作った物）。やめるのは
// これからの選びだけで、今選んである「すること」の選び・作業・頼み事は替えない。Claude の案（W4）は、この表に写して
// から家族が直す：Claude に分からなかった欄と外の事実の欄は、家族が選ぶまで保存しない。
import {
  type CheckedDraft,
  type CostField,
  type DeadlineRule,
  type Household,
  type HouseholdPreview,
  type Member,
  type Place,
  placesWithoutHours,
  repeatedNames,
  type SegmentKind,
  shownName,
  type Way,
  type WayStep,
} from '@maniau/core';
import { useState } from 'react';
import { deadlineText, householdPreviewLines } from './household';
import { SourceLink } from './resources';
import { type Ctx, leaveText, nameOf, succeeded } from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text, Title } from './ui';
import { noteText } from './way-ideas';

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
const COST_FIELDS: readonly CostField[] = ['leaveMinutes', 'helperRequests', 'yen', 'extraTasks'];
const SEGMENTS: readonly SegmentKind[] = ['home', 'commute', 'work', 'pickup', 'away'];
/** 返事までに見込む時間の選び（分）。 */
const WAITS = [0, 60, 180, 720, 1440, 2880] as const;
const NEW_PLACE_KINDS = ['other', 'store', 'helperHome'] as const;
const MAX_STEPS = 3;

/** 画面の ID（サーバーの形 ^[a-z0-9][a-z0-9-]{0,47}$ に合わせる。比べるだけで、区切って読まない）。 */
const newId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

// ── 見せる ──────────────────────────────

/** 代償の行（分かっている欄と、分からない欄）。 */
export function costLines(ctx: Ctx, cost: Way['cost']): string[] {
  const unknown = new Set(cost.unknown ?? []);
  const parts: string[] = [];
  if (!unknown.has('yen') && cost.yen > 0) {
    parts.push(ctx.t('household.ways.yen', { yen: cost.yen }));
  }
  if (!unknown.has('leaveMinutes') && cost.leaveMinutes > 0) {
    parts.push(leaveText(ctx, cost.leaveMinutes));
  }
  if (!unknown.has('helperRequests') && cost.helperRequests > 0) parts.push(ctx.t('cost.helper'));
  if (!unknown.has('extraTasks') && cost.extraTasks > 0) {
    parts.push(ctx.t('cost.extraTasks', { count: cost.extraTasks }));
  }
  const lines = parts.length > 0 ? [parts.join(ctx.t('list.separator'))] : [];
  if (unknown.size > 0) {
    const fields = COST_FIELDS.filter((f) => unknown.has(f)).map((f) => ctx.t(`cost.field.${f}`));
    lines.push(
      ctx.t('cost.unknown', {
        fields: new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(fields),
      }),
    );
  }
  return lines;
}

/** やり方の中身を短く：手順（外の相手を待つ物は相手と待つ物）、受け持つ人と時間、締切、行ける時間、代償。 */
export function wayLines(ctx: Ctx, way: Way): string[] {
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
  for (const step of way.steps) {
    if (step.deadline) {
      lines.push(
        ctx.t('ways.stepDeadline', { name: step.name, rule: deadlineText(ctx, step.deadline) }),
      );
    }
  }
  for (const place of placesWithoutHours(ctx.household, { kind: 'need' }, { templateId: way.id })) {
    lines.push(ctx.t('ways.noHours', { place: place.name }));
  }
  lines.push(...costLines(ctx, way.cost));
  return lines;
}

/** そのやり方を、今選んである「すること」（生きている手配の、家族の言葉の「何を」）。 */
function usedBy(ctx: Ctx, wayId: string): { key: string; what: string }[] {
  return ctx.plan.arrangements
    .filter((a) => a.live && a.kind === 'need' && a.options.some((o) => o.templateId === wayId))
    .map((a) => ({
      key: a.key,
      what: ctx.plan.requirements.find((r) => r.key === a.requirementKey)?.what ?? '',
    }));
}

/** サーバーが直しを断った理由の符号を、画面の言葉の鍵にする（知らない物は一つにまとめる）。 */
function refusedKey(reason: string): string {
  return [
    'householdInvalid',
    'routineGap',
    'routinePlace',
    'routineExceptionMember',
    'wayRemoved',
    'wayInvalid',
    'wayRefUnknown',
    'membersLocked',
    'placesLocked',
    'nameTaken',
    'unavailable',
  ].includes(reason)
    ? reason
    : 'other';
}

/**
 * 見る → 保存（家の情報の直し）。見た物は、見た時の家の情報と一緒に持ち、欄が替われば見せない（替わった中身を、
 * 前に見た物で保存しない）。保存は、見た計画の番号と見た物の要約を付ける（サーバーが同じ計算で確かめる）。
 */
export function useHouseholdSave(ctx: Ctx) {
  const [shown, setShown] = useState<{ key: string; preview: HouseholdPreview }>();
  const [refused, setRefused] = useState<{ key: string; reason: string }>();
  const [busy, setBusy] = useState(false);
  const keyOf = (household: Household) => JSON.stringify(household);
  return {
    busy,
    shownFor: (household: Household) =>
      shown?.key === keyOf(household) ? shown.preview : undefined,
    refusedFor: (household: Household) =>
      refused?.key === keyOf(household) ? refused.reason : undefined,
    look: async (household: Household) => {
      if (!ctx.previewHousehold) return;
      const key = keyOf(household);
      setBusy(true);
      const result = await ctx.previewHousehold(household);
      setBusy(false);
      if (!result) setRefused({ key, reason: 'unavailable' });
      else if ('refused' in result) setRefused({ key, reason: result.refused });
      else {
        setShown({ key, preview: result.preview });
        setRefused(undefined);
      }
    },
    save: async (household: Household): Promise<boolean> => {
      const seen = shown?.key === keyOf(household) ? shown.preview : undefined;
      if (!seen) return false;
      setBusy(true);
      const result = await ctx.send({
        type: 'updateHousehold',
        household,
        seen: { throughSeq: seen.throughSeq, changes: seen.seen },
      });
      setBusy(false);
      // 断られた時（見た後に計画が変わった等）は、見た物を捨てて、もう一度見てもらう。
      setShown(undefined);
      return succeeded(result);
    },
  };
}

/** 「この変更で変わること」（サーバーが同じ計算で出した物）か、保存できない理由。 */
export function Shown(props: {
  ctx: Ctx;
  preview?: HouseholdPreview;
  refused?: string;
  /** 直した後の家の情報（新しく足す場所の名前を書くため）。 */
  household?: Household;
}) {
  const { ctx, preview, refused } = props;
  if (refused) return <Text>{ctx.t(`household.refused.${refusedKey(refused)}`)}</Text>;
  if (!preview) return null;
  const lines = householdPreviewLines(ctx, preview, props.household);
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

/**
 * 「うちのこと」のやり方の一覧：使っているやり方（選んである「すること」の数）と、やめたやり方。足す・直すは別の
 * 画面、やめる・使い直すはここで「この変更で変わること」を見てから保存する。
 */
export function WaysCard({ ctx }: { ctx: Ctx }) {
  const [toggling, setToggling] = useState<string>();
  const flow = useHouseholdSave(ctx);
  const stopped = new Set(ctx.household.stoppedWayIds ?? []);
  const ways = ctx.household.ways;
  const draftFor = (wayId: string): Household => {
    const next = structuredClone(ctx.household);
    const ids = new Set(next.stoppedWayIds ?? []);
    if (ids.has(wayId)) ids.delete(wayId);
    else ids.add(wayId);
    // やめた物の並びは、家の情報のやり方の並び（押した順で別の物にしない）。
    const list = next.ways.map((w) => w.id).filter((id) => ids.has(id));
    if (list.length > 0) next.stoppedWayIds = list;
    else delete next.stoppedWayIds;
    return next;
  };
  const draft = toggling ? draftFor(toggling) : undefined;
  const shown = draft ? flow.shownFor(draft) : undefined;
  const refused = draft ? flow.refusedFor(draft) : undefined;
  const row = (way: Way) => {
    const using = usedBy(ctx, way.id);
    const isStopped = stopped.has(way.id);
    const open = toggling === way.id;
    return (
      <div key={way.id} className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3">
        <Title>{way.name}</Title>
        {wayLines(ctx, way).map((line) => (
          <Text key={line} quiet>
            {line}
          </Text>
        ))}
        {using.length > 0 && <Text>{ctx.t('ways.inUse', { count: using.length })}</Text>}
        {open && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-paper px-3 py-2.5">
            <Text>{ctx.t(isStopped ? 'ways.resumeNote' : 'ways.stopNote')}</Text>
            {!isStopped &&
              using.map((u) => (
                <Text key={u.key}>{ctx.t('ways.stopUsing', { what: u.what })}</Text>
              ))}
          </div>
        )}
        {open && draft && (
          <Shown
            ctx={ctx}
            {...(shown ? { preview: shown } : {})}
            {...(refused ? { refused } : {})}
          />
        )}
        <Row>
          {!open && !isStopped && (
            <Button kind="secondary" onClick={() => ctx.go({ name: 'way', wayId: way.id })}>
              {ctx.t('ways.edit')}
            </Button>
          )}
          {!open && (
            <Button kind="secondary" onClick={() => setToggling(way.id)}>
              {ctx.t(isStopped ? 'ways.resume' : 'ways.stop')}
            </Button>
          )}
          {open && draft && !shown && (
            <Button
              onClick={() => void flow.look(draft)}
              disabled={flow.busy || !ctx.previewHousehold}
            >
              {ctx.t('need.look')}
            </Button>
          )}
          {open && draft && shown && (
            <Button
              onClick={() =>
                void flow.save(draft).then((ok) => {
                  if (ok) setToggling(undefined);
                })
              }
              disabled={flow.busy}
            >
              {ctx.t(isStopped ? 'ways.confirmResume' : 'ways.confirmStop')}
            </Button>
          )}
          {open && (
            <Button kind="secondary" onClick={() => setToggling(undefined)} disabled={flow.busy}>
              {ctx.t('ways.back')}
            </Button>
          )}
        </Row>
      </div>
    );
  };
  return (
    <Card>
      <Label tone="sub">{ctx.t('ways.label')}</Label>
      {ways.length === 0 && <Text>{ctx.t('ways.none')}</Text>}
      {ways.filter((w) => !stopped.has(w.id)).map(row)}
      {ways.some((w) => stopped.has(w.id)) && <Label tone="sub">{ctx.t('ways.stopped')}</Label>}
      {ways.filter((w) => stopped.has(w.id)).map(row)}
      <Text quiet>{ctx.t('ways.used')}</Text>
      <Row>
        <Button kind="secondary" onClick={() => ctx.go({ name: 'way' })}>
          {ctx.t('ways.add')}
        </Button>
      </Row>
    </Card>
  );
}

// ── 足す・直す ──────────────────────────────

type DeadlineKind = '' | 'keep' | 'none' | 'daysBefore' | 'businessDaysBefore' | 'onTheDay';

interface StepForm {
  id: string;
  name: string;
  /** 空は大人のだれでも。? は Claude の案で分からない（選ぶまで保存しない）。 */
  assigneeId: string;
  /** 空は頼まない、+new は新しく登録、? は Claude の案で分からない（選ぶまで保存しない）、ほかは相手の ID。 */
  to: string;
  /** 新しく登録する相手。人なら、頼む文の言葉（空は選んでいない）と呼び方（任意）。 */
  newTo: {
    id: string;
    name: string;
    kind: 'helper' | 'place';
    language: '' | 'ja' | 'en';
    addressAs: string;
  };
  /** 返事までに見込む時間（分）。空は選んでいない。keep は今のまま。 */
  wait: string;
  /** 空は選んでいない、- は決まった場所は無い、+new は新しく登録、ほかは場所の ID。 */
  place: string;
  newPlace: { id: string; name: string; kind: (typeof NEW_PLACE_KINDS)[number] };
  segments: SegmentKind[];
  minutes: string;
  deadline: DeadlineKind;
  days: string;
  at: string;
  cover: boolean;
  /** Claude の案で、受け持つか分からない（選ぶまで保存しない）。 */
  coverAsk?: true;
  /** Claude の案の手順なら、引用とその出どころ（null は Claude の提案）。家族が足した手順には無い。 */
  quote?: { text: string; from: 'written' | 'words' | 'both' } | null;
  /** 直す時の元の手順（画面に出さない欄を残す）。 */
  original?: WayStep;
}

interface WayForm {
  id: string;
  name: string;
  steps: StepForm[];
  coversStart: string;
  coversEnd: string;
  /**
   * Claude の案で、受け持つ時間が分からない時だけ（受け持つ手順がある時に、選ぶまで保存しない）。whole は「すること」
   * の時間の全部を頼む・受け持つ（相手の「はい」か家族の予定で確かめる）、part は下の時間だけ。
   */
  coversAsk?: '' | 'whole' | 'part';
  cost: Record<CostField, { value: string; unknown: boolean }>;
  /**
   * Claude の案から写した表で、頼める人に頼む数を手順から数えている間（家族が数を直すまで）。手順の相手を替えると
   * 数え直す（前の手順で数えた数を、今の手順の代償にしない）。
   */
  derivedHelpers?: true;
  /** やり方全体の締切（前からある時だけ見せる）。 */
  wayDeadline: DeadlineKind;
  wayDays: string;
  wayAt: string;
  /** 使う前に済ませておく前提（Preparation の id。家族が選ぶ。前提を選んでも、頼む先・行く所は替わらない）。 */
  requires: string[];
  /**
   * 周りの資源の所を使う、写した新しいやり方（02-foundation §3.5）：写した元の名前、使う資源とその場所、代わりに
   * する資源とその場所（あれば）。この所の事前の登録は、表で選び直す：その登録の前提の ID（この所の登録か、同じ
   * 登録とした前提）、none（要らない）、unsure（まだ分からない）、空（選んでいない）。選ぶまで、まだ分からないのも、
   * 保存しない。この所の登録は、この欄だけで決める（前提の一覧には出さない）。
   */
  copy?: {
    from: string;
    resourceId: string;
    placeId: string;
    insteadOf: string;
    insteadPlaceId?: string;
    registration: string;
  };
  original?: Way;
}

function deadlineForm(rule: DeadlineRule | undefined): {
  kind: DeadlineKind;
  days: string;
  at: string;
} {
  if (!rule) return { kind: 'none', days: '1', at: '21:00' };
  switch (rule.type) {
    case 'daysBefore':
    case 'businessDaysBefore':
      return { kind: rule.type, days: String(rule.days), at: rule.at };
    case 'onTheDay':
      return { kind: 'onTheDay', days: '1', at: rule.at };
    case 'weekdayOfPreviousWeek':
      return { kind: 'keep', days: '1', at: rule.at };
  }
}

function emptyStep(n: number): StepForm {
  return {
    id: `s${n}`,
    name: '',
    assigneeId: '',
    to: '',
    newTo: { id: newId('h'), name: '', kind: 'helper', language: '', addressAs: '' },
    wait: '',
    place: '',
    newPlace: { id: newId('p'), name: '', kind: 'other' },
    segments: ['home', 'commute', 'work'],
    minutes: '10',
    deadline: '',
    days: '1',
    at: '21:00',
    cover: false,
  };
}

function formOf(way: Way | undefined): WayForm {
  const cost = (field: CostField) => ({
    value: way ? String(field === 'leaveMinutes' ? way.cost[field] / 60 : way.cost[field]) : '',
    unknown: way ? (way.cost.unknown ?? []).includes(field) : true,
  });
  const whole = deadlineForm(way?.deadline);
  return {
    id: way?.id ?? newId('way'),
    name: way?.name ?? '',
    steps: way
      ? way.steps.map((s, i) => {
          const rule = deadlineForm(s.deadline);
          return {
            ...emptyStep(i + 1),
            id: s.id,
            name: s.name,
            assigneeId: s.assigneeId ?? '',
            to: s.external?.to ?? '',
            wait: s.external
              ? WAITS.some((w) => w === s.waitAfterMin)
                ? String(s.waitAfterMin)
                : 'keep'
              : '',
            place: s.placeId ?? '-',
            segments: [...s.segments],
            minutes: String(s.durationMin),
            deadline: rule.kind,
            days: rule.days,
            at: rule.at,
            cover: s.cover === true,
            original: s,
          };
        })
      : [emptyStep(1)],
    coversStart: way?.covers?.start ?? '',
    coversEnd: way?.covers?.end ?? '',
    cost: {
      leaveMinutes: cost('leaveMinutes'),
      helperRequests: cost('helperRequests'),
      yen: cost('yen'),
      extraTasks: cost('extraTasks'),
    },
    wayDeadline: way?.deadline ? whole.kind : 'none',
    wayDays: whole.days,
    wayAt: whole.at,
    requires: [...(way?.requires ?? [])],
    ...(way ? { original: way } : {}),
  };
}

const whole = (value: string) => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined);
/** その ID の人・場所の名前が、ほかの物と重なっているか（重なっていれば、画面で見分けられない）。 */
function sameNamed(household: Household): (id: string) => boolean {
  const repeated = repeatedNames(household);
  return (id) => {
    const name = nameOf(household, id);
    return name !== '' && repeated.has(shownName(name));
  };
}

/** 表の手順から、頼める人に頼む数を数える（相手の分からない手順があれば数えない）。 */
function helperCount(household: Household, steps: StepForm[]): number | undefined {
  let n = 0;
  for (const s of steps) {
    if (s.to === '?') return undefined;
    if (s.to === '+new') {
      if (s.newTo.kind === 'helper') n += 1;
    } else if (s.to !== '' && household.members.some((m) => m.id === s.to && m.kind === 'helper')) {
      n += 1;
    }
  }
  return n;
}

/** 休みの時間（0.5 時間きざみ）を分にする。 */
const halfHours = (value: string) =>
  /^\d+(\.5)?$/.test(value) ? Math.round(Number.parseFloat(value) * 60) : undefined;

/**
 * Claude の案を表に写す（新しいやり方として）。分からない欄は、選ぶまで保存できない形にする：だれ・相手が分からない
 * なら「?」、場所は未選択、かかる時間は空、できる時は無し、受け持つかは選ぶ。外の事実（いつまでに・返事までに見込む
 * 時間・値段・受け持てる時間）は案に無いので、いつまでには未選択、返事は未選択、値段は「分からない」にする。今の家に
 * 無い ID は、分からないと同じに扱う。
 */
export function formOfDraft(household: Household, draft: CheckedDraft): WayForm {
  const base = formOf(undefined);
  const adults = new Set(
    household.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id),
  );
  const contacts = new Set([
    ...household.members.filter((m) => m.kind === 'helper' && m.active).map((m) => m.id),
    ...household.places.filter((p) => p.kind !== 'home').map((p) => p.id),
  ]);
  const places = new Set(household.places.filter((p) => p.kind !== 'home').map((p) => p.id));
  const steps = draft.steps.map((d, i): StepForm => {
    const s: StepForm = {
      ...emptyStep(i + 1),
      name: d.name,
      quote: d.quote && d.quoteFrom ? { text: d.quote, from: d.quoteFrom } : null,
    };
    s.assigneeId =
      d.assignee.kind === 'anyAdult'
        ? ''
        : d.assignee.kind === 'adult' && adults.has(d.assignee.id)
          ? d.assignee.id
          : '?';
    const c = d.counterpart;
    if (c.kind === 'none') s.to = '';
    else if ((c.kind === 'helper' || c.kind === 'place') && contacts.has(c.id)) s.to = c.id;
    else if (c.kind === 'newHelper' || c.kind === 'newPlace') {
      s.to = '+new';
      s.newTo = { ...s.newTo, name: c.name, kind: c.kind === 'newHelper' ? 'helper' : 'place' };
    } else s.to = '?';
    const p = d.place;
    if (p.kind === 'none') s.place = '-';
    else if (p.kind === 'place' && places.has(p.id)) s.place = p.id;
    else if (p.kind === 'newPlace') {
      s.place = '+new';
      s.newPlace = { ...s.newPlace, name: p.name };
    } else s.place = '';
    s.segments = d.segments ? [...d.segments] : [];
    s.minutes = d.minutes === null ? '' : String(d.minutes);
    s.wait = '';
    s.deadline = '';
    if (d.cover === null) {
      s.cover = false;
      s.coverAsk = true;
    } else s.cover = d.cover;
    return s;
  });
  const known = (value: number | null, perHour = false) =>
    value === null
      ? { value: '', unknown: true }
      : { value: String(perHour ? value / 60 : value), unknown: false };
  const covering = steps.some((s) => s.cover || s.coverAsk === true);
  return {
    ...base,
    name: draft.name,
    steps,
    ...(covering && draft.covers === 'unknown' ? { coversAsk: '' as const } : {}),
    cost: {
      leaveMinutes: known(draft.cost.leaveMinutes, true),
      // 手順から数える（確かめた案と同じ数え方。今の家に無い・見分けられない相手は「?」なので数えない）。
      helperRequests: known(helperCount(household, steps) ?? null),
      yen: { value: '', unknown: true },
      extraTasks: known(draft.cost.extraTasks),
    },
    derivedHelpers: true,
  };
}

/**
 * 周りの資源の所を使う新しいやり方の表：今のやり方を写し、代わりにする資源の場所に頼む・行く手順だけを、この所に
 * する（家族が表で直せる。ほかの手順・資源・前提はそのまま）。前の所の時間・費用・期限・返事までの時間は、この所の
 * 事実にしない：受け持つ時間と、替えた手順の期限・返事までの時間は、選ぶまで保存せず、費用の円は分からないにする。
 * 前提は、代わりにする資源の前提を外した案で、家族が選ぶ。この所の事前の登録は、登録の欄で選び直す（この所の登録・
 * 同じ登録・要らない。まだ分からないのは保存しない）。元のやり方・資源・場所が無ければ無い。
 */
export function formOfCopy(
  ctx: Ctx,
  copy: { wayId: string; resourceId: string; insteadOf: string },
): WayForm | undefined {
  const household = ctx.household;
  const way = household.ways.find((w) => w.id === copy.wayId);
  const resource = household.resources.find((r) => r.id === copy.resourceId);
  const instead = household.resources.find((r) => r.id === copy.insteadOf);
  const placeId = resource?.placeId;
  if (!way || !resource || !instead || placeId === undefined) return undefined;
  const from = instead.placeId;
  const base = formOf(way);
  const steps = base.steps.map((s): StepForm => {
    const asks = from !== undefined && s.original?.external?.to === from;
    const goes = from !== undefined && s.original?.placeId === from;
    if (!asks && !goes) return s;
    return {
      ...s,
      ...(asks ? { to: placeId, wait: '' } : {}),
      ...(goes ? { place: placeId } : {}),
      deadline: '',
    };
  });
  const insteadPreps = new Set(
    household.preparations.filter((p) => p.resourceId === instead.id).map((p) => p.id),
  );
  // 前提の案：代わりにする資源の前提を外す（この所の登録は、登録の欄で選ぶ）。
  const own = new Set(
    household.preparations.filter((p) => p.resourceId === resource.id).map((p) => p.id),
  );
  const kept = (way.requires ?? []).filter((id) => !insteadPreps.has(id) && !own.has(id));
  const id = newId('way');
  return {
    ...base,
    id,
    name: ctx.t('way.copy.name', { way: way.name, place: resource.name }),
    steps,
    coversStart: '',
    coversEnd: '',
    ...(steps.some((s) => s.cover) ? { coversAsk: '' as const } : {}),
    cost: { ...base.cost, yen: { value: '', unknown: true } },
    wayDeadline: way.deadline ? '' : base.wayDeadline,
    requires: kept,
    copy: {
      from: way.name,
      resourceId: resource.id,
      placeId,
      insteadOf: instead.id,
      ...(from === undefined ? {} : { insteadPlaceId: from }),
      registration: '',
    },
    original: { ...way, id },
  };
}

function ruleOf(
  kind: DeadlineKind,
  days: string,
  at: string,
  keep: DeadlineRule | undefined,
): DeadlineRule | undefined | 'missing' {
  switch (kind) {
    case '':
      return 'missing';
    case 'keep':
      return keep ?? 'missing';
    case 'none':
      return undefined;
    case 'onTheDay':
      return /^\d\d:\d\d$/.test(at) ? { type: 'onTheDay', at } : 'missing';
    case 'daysBefore':
    case 'businessDaysBefore': {
      const n = whole(days);
      return n !== undefined && n > 0 && /^\d\d:\d\d$/.test(at)
        ? { type: kind, days: n, at }
        : 'missing';
    }
  }
}

/**
 * 表から、家の情報の直し（やり方と、新しく登録する相手・場所）を作る。足りない欄があれば作らない（分からない欄を
 * 0・決まり無しに置き換えない：いつまでに・場所・返事までに見込む時間は、選ぶまで保存しない）。
 */
function draftOf(household: Household, form: WayForm): Household | undefined {
  const members: Member[] = [];
  const places: Place[] = [];
  const steps: WayStep[] = [];
  if (form.name.trim() === '' || form.steps.length === 0) return undefined;
  // 同じ名前の人・場所（前からある重なり）は、新しく選ばない（前から選んであった物は残せる）。
  const ambiguous = sameNamed(household);
  for (const s of form.steps) {
    const minutes = whole(s.minutes);
    if (s.name.trim() === '' || minutes === undefined || s.segments.length === 0) return undefined;
    // Claude の案で分からなかった欄は、家族が選ぶまで保存しない。
    if (s.assigneeId === '?' || s.to === '?' || s.coverAsk) return undefined;
    if (
      (ambiguous(s.assigneeId) && s.assigneeId !== s.original?.assigneeId) ||
      (ambiguous(s.to) && s.to !== s.original?.external?.to) ||
      (ambiguous(s.place) && s.place !== s.original?.placeId)
    ) {
      return undefined;
    }
    const deadline = ruleOf(s.deadline, s.days, s.at, s.original?.deadline);
    if (deadline === 'missing') return undefined;
    let to: string | undefined;
    if (s.to === '+new') {
      if (s.newTo.name.trim() === '') return undefined;
      if (s.newTo.kind === 'helper') {
        // 頼む文の言葉は、家族が選ぶまで保存しない（分からないのを日本語にしない）。
        if (s.newTo.language === '') return undefined;
        const addressAs = s.newTo.addressAs.trim();
        members.push({
          id: s.newTo.id,
          kind: 'helper',
          name: s.newTo.name.trim(),
          active: true,
          outboundLanguage: s.newTo.language,
          ...(addressAs === '' ? {} : { addressAs }),
        });
      } else {
        places.push({ id: s.newTo.id, kind: 'other', name: s.newTo.name.trim(), goods: [] });
      }
      to = s.newTo.id;
    } else if (s.to !== '') to = s.to;
    let wait = 0;
    if (to !== undefined) {
      if (s.wait === '') return undefined;
      wait = s.wait === 'keep' ? (s.original?.waitAfterMin ?? 0) : Number(s.wait);
    } else if (s.original !== undefined && s.original.external === undefined) {
      // 相手の無い手順の「次の手順まで空ける時間」は、この画面で直さないので元のまま残す。
      // 相手を外した手順は、返事までに見込む時間も一緒に外す（画面にそう出す）。
      wait = s.original.waitAfterMin;
    }
    let placeId: string | undefined;
    if (s.place === '') return undefined;
    if (s.place === '+new') {
      if (s.newPlace.name.trim() === '') return undefined;
      places.push({
        id: s.newPlace.id,
        kind: s.newPlace.kind,
        name: s.newPlace.name.trim(),
        goods: [],
      });
      placeId = s.newPlace.id;
    } else if (s.place !== '-') placeId = s.place;
    // 画面に出さない欄（店の種類・品物・相手の返事の種類）は、元の手順のまま残す。
    const {
      name: _n,
      assigneeId: _a,
      external: _e,
      placeId: _p,
      deadline: _d,
      cover: _c,
      segments: _s,
      durationMin: _m,
      waitAfterMin: _w,
      ...kept
    } = s.original ?? { name: '', segments: [], durationMin: 0, waitAfterMin: 0, id: s.id };
    steps.push({
      ...kept,
      id: s.id,
      name: s.name.trim(),
      durationMin: minutes,
      segments: SEGMENTS.filter((k) => s.segments.includes(k)),
      waitAfterMin: wait,
      ...(s.assigneeId === '' ? {} : { assigneeId: s.assigneeId }),
      ...(to === undefined
        ? {}
        : { external: { to, kind: s.original?.external?.kind ?? 'reply' } }),
      ...(placeId === undefined ? {} : { placeId }),
      ...(deadline === undefined ? {} : { deadline }),
      ...(s.cover ? { cover: true as const } : {}),
    });
  }
  const unknown = COST_FIELDS.filter((f) => form.cost[f].unknown);
  const cost: Way['cost'] = { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 };
  for (const f of COST_FIELDS) {
    if (form.cost[f].unknown) continue;
    const n = f === 'leaveMinutes' ? halfHours(form.cost[f].value) : whole(form.cost[f].value);
    if (n === undefined) return undefined;
    cost[f] = n;
  }
  if (unknown.length > 0) cost.unknown = unknown;
  // 受け持つ時間を選ぶ欄（Claude の案）：受け持つ手順がある時だけ要る。全部なら時刻を使わない。
  const covering = form.steps.some((s) => s.cover);
  const coversMode = covering ? form.coversAsk : undefined;
  if (coversMode === '') return undefined;
  if (coversMode === 'part' && (form.coversStart === '' || form.coversEnd === '')) return undefined;
  const coversStart = coversMode === 'whole' ? '' : form.coversStart;
  const coversEnd = coversMode === 'whole' ? '' : form.coversEnd;
  if ((coversStart === '') !== (coversEnd === '')) return undefined;
  const wayDeadline = form.original?.deadline
    ? ruleOf(form.wayDeadline, form.wayDays, form.wayAt, form.original.deadline)
    : undefined;
  if (wayDeadline === 'missing') return undefined;
  // 写したやり方：この所の登録を家族が選ぶまで（まだ分からないも）保存しない。この所の登録は登録の欄だけで決め
  // （選んだ前提は必ず入れ、この所のほかの登録は入れない）、ほかの前提は一覧で選ぶ。使う資源は、手順が今頼む・行く
  // 所で決める（この所に頼む手順を元に戻したら、この所を使うとは書かない）。
  const copy = form.copy;
  if (copy && (copy.registration === '' || copy.registration === 'unsure')) return undefined;
  const registration = copy && copy.registration !== 'none' ? copy.registration : undefined;
  if (registration !== undefined && !household.preparations.some((p) => p.id === registration)) {
    return undefined;
  }
  const own = new Set(
    copy
      ? household.preparations.filter((p) => p.resourceId === copy.resourceId).map((p) => p.id)
      : [],
  );
  const requires = [
    ...form.requires.filter(
      (id) =>
        household.preparations.some((p) => p.id === id) && !own.has(id) && id !== registration,
    ),
    ...(registration === undefined ? [] : [registration]),
  ];
  const uses = (placeId: string | undefined) =>
    placeId !== undefined && steps.some((s) => s.external?.to === placeId || s.placeId === placeId);
  const resourceIds = copy
    ? [
        ...(form.original?.resourceIds ?? []).filter(
          (id) => id !== copy.resourceId && (id !== copy.insteadOf || uses(copy.insteadPlaceId)),
        ),
        ...(uses(copy.placeId) ? [copy.resourceId] : []),
      ]
    : (form.original?.resourceIds ?? []);
  const { deadline: _d, covers: _c, requires: _r, resourceIds: _ri, ...kept } = form.original ?? {};
  const way: Way = {
    ...kept,
    id: form.id,
    name: form.name.trim(),
    steps,
    cost,
    ...(wayDeadline === undefined ? {} : { deadline: wayDeadline }),
    ...(coversStart === '' ? {} : { covers: { start: coversStart, end: coversEnd } }),
    ...(requires.length === 0 ? {} : { requires }),
    ...(resourceIds.length === 0 ? {} : { resourceIds }),
  };
  const next = structuredClone(household);
  next.members.push(...members);
  next.places.push(...places);
  const at = next.ways.findIndex((w) => w.id === way.id);
  if (at === -1) next.ways.push(way);
  else next.ways[at] = way;
  return next;
}

/**
 * やり方を足す・直す（wayId があれば直す）。保存したら、来た所（「すること」か「うちのこと」）へ戻る。idea は、
 * Claude が出した案（新しいやり方として表に写す。推定と示し、分からない欄は家族が選ぶまで保存しない）。
 */
export function WayScreen({
  ctx,
  wayId,
  from,
  idea,
  copy,
}: {
  ctx: Ctx;
  wayId?: string;
  from?: string;
  idea?: CheckedDraft;
  copy?: { wayId: string; resourceId: string; insteadOf: string };
}) {
  const original = wayId ? ctx.household.ways.find((w) => w.id === wayId) : undefined;
  const fromIdea = idea !== undefined && wayId === undefined ? idea : undefined;
  // 写す元（やり方・資源・場所）が無くなっていれば、写さない（下で「無くなった」と出す）。
  const [copied] = useState(() => (copy && !wayId ? formOfCopy(ctx, copy) : undefined));
  const [form, setForm] = useState<WayForm>(
    () => copied ?? (fromIdea ? formOfDraft(ctx.household, fromIdea) : formOf(original)),
  );
  const flow = useHouseholdSave(ctx);
  const back = () => ctx.go(from ? { name: 'need', key: from } : { name: 'household' });
  const draft = draftOf(ctx.household, form);
  const shown = draft ? flow.shownFor(draft) : undefined;
  const refused = draft ? flow.refusedFor(draft) : undefined;
  const update = (change: (f: WayForm) => void) =>
    setForm((now) => {
      const next = structuredClone(now);
      change(next);
      if (next.derivedHelpers) {
        const n = helperCount(ctx.household, next.steps);
        next.cost.helperRequests =
          n === undefined ? { value: '', unknown: true } : { value: String(n), unknown: false };
      }
      return next;
    });
  const step = (i: number, change: (s: StepForm) => void) =>
    update((f) => {
      const s = f.steps[i];
      if (s) change(s);
    });
  const adults = ctx.household.members.filter((m) => m.kind === 'adult' && m.active);
  const contacts = [
    ...ctx.household.members.filter((m) => m.kind === 'helper' && m.active),
    ...ctx.household.places.filter((p) => p.kind !== 'home'),
  ];
  const places = ctx.household.places.filter((p) => p.kind !== 'home');
  const ambiguous = sameNamed(ctx.household);
  /** 同じ名前の物は、前から選んであった時だけ選べる（新しくは選べない。見分けられないので）。 */
  const option = (id: string, name: string, kept: string | undefined) => (
    <option key={id} value={id} disabled={ambiguous(id) && id !== kept}>
      {ambiguous(id) ? `${name}${ctx.t('way.sameName')}` : name}
    </option>
  );
  // Claude の案で受け持つ時間が分からず、受け持つ手順がある時だけ、全部か一部かを選んでもらう。
  const asksCovers =
    form.coversAsk !== undefined && form.steps.some((s) => s.cover || s.coverAsk === true);
  if ((wayId && !original) || (copy && !wayId && !copied)) {
    return (
      <>
        <Header
          back={{ label: ctx.t('nav.household'), onClick: back }}
          title={ctx.t('way.title.edit')}
        />
        <Main>
          <Text>{ctx.t('way.gone')}</Text>
        </Main>
      </>
    );
  }
  return (
    <>
      <Header
        back={{
          label: ctx.t(from ? 'way.backToNeed' : 'nav.household'),
          onClick: back,
        }}
        title={ctx.t(original ? 'way.title.edit' : 'way.title.new')}
      />
      <Main>
        <Text quiet>{ctx.t('way.intro')}</Text>
        {fromIdea && <IdeaBanner ctx={ctx} draft={fromIdea} />}
        {form.copy && <CopyBanner ctx={ctx} form={form} />}
        <Card>
          <label className="flex flex-col gap-1">
            <span className="font-bold">{ctx.t('way.name')}</span>
            <input
              className={input}
              value={form.name}
              onChange={(e) => update((f) => (f.name = e.target.value))}
            />
          </label>
        </Card>
        <Label tone="sub">{ctx.t('way.steps')}</Label>
        {form.steps.map((s, i) => (
          <Card key={s.id}>
            <Label tone="accent">{ctx.t('way.step', { n: i + 1 })}</Label>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{ctx.t('way.stepName')}</span>
              <input
                className={input}
                value={s.name}
                onChange={(e) => step(i, (x) => (x.name = e.target.value))}
              />
            </label>
            {s.quote !== undefined && (
              <span className="text-sm text-sub">
                {s.quote
                  ? ctx.t(`wayIdeas.quote.${s.quote.from}`, { quote: s.quote.text })
                  : ctx.t('wayIdeas.proposed')}
              </span>
            )}
            <label className="flex flex-col gap-1">
              <span className="font-bold">{ctx.t('way.who')}</span>
              <select
                className={input}
                value={s.assigneeId}
                onChange={(e) => step(i, (x) => (x.assigneeId = e.target.value))}
              >
                {s.assigneeId === '?' && <option value="?">{ctx.t('way.choose')}</option>}
                <option value="">{ctx.t('way.anyone')}</option>
                {adults.map((m) => option(m.id, m.name, s.original?.assigneeId))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{ctx.t('way.to')}</span>
              <select
                className={input}
                value={s.to}
                onChange={(e) => step(i, (x) => (x.to = e.target.value))}
              >
                {s.to === '?' && <option value="?">{ctx.t('way.choose')}</option>}
                <option value="">{ctx.t('way.toNone')}</option>
                {contacts.map((c) => option(c.id, c.name, s.original?.external?.to))}
                <option value="+new">{ctx.t('way.toNew')}</option>
              </select>
            </label>
            {s.to === '+new' && (
              <div className="flex flex-wrap gap-2">
                <input
                  aria-label={ctx.t('way.newToName')}
                  placeholder={ctx.t('way.newToName')}
                  className={`${input} min-w-0 flex-1`}
                  value={s.newTo.name}
                  onChange={(e) => step(i, (x) => (x.newTo.name = e.target.value))}
                />
                <select
                  aria-label={ctx.t('way.newToKind')}
                  className={input}
                  value={s.newTo.kind}
                  onChange={(e) =>
                    step(i, (x) => (x.newTo.kind = e.target.value === 'place' ? 'place' : 'helper'))
                  }
                >
                  <option value="helper">{ctx.t('way.newToKindHelper')}</option>
                  <option value="place">{ctx.t('way.newToKindPlace')}</option>
                </select>
                {s.newTo.kind === 'helper' && (
                  <>
                    <select
                      aria-label={ctx.t('way.newToLanguage')}
                      className={input}
                      value={s.newTo.language}
                      onChange={(e) =>
                        step(i, (x) => {
                          const v = e.target.value;
                          x.newTo.language = v === 'ja' || v === 'en' ? v : '';
                        })
                      }
                    >
                      <option value="">{ctx.t('way.newToLanguage')}</option>
                      <option value="ja">日本語</option>
                      <option value="en">English</option>
                    </select>
                    <input
                      aria-label={ctx.t('way.newToAddressAs')}
                      placeholder={ctx.t('way.newToAddressAs')}
                      className={`${input} min-w-0 flex-1`}
                      value={s.newTo.addressAs}
                      onChange={(e) => step(i, (x) => (x.newTo.addressAs = e.target.value))}
                    />
                  </>
                )}
              </div>
            )}
            {s.to !== '' && (
              <label className="flex flex-col gap-1">
                <span className="font-bold">{ctx.t('way.wait')}</span>
                <select
                  className={input}
                  value={s.wait}
                  onChange={(e) => step(i, (x) => (x.wait = e.target.value))}
                >
                  <option value="">{ctx.t('way.choose')}</option>
                  {s.original?.external && s.wait === 'keep' && (
                    <option value="keep">
                      {ctx.t('way.waitKeep', { min: s.original.waitAfterMin })}
                    </option>
                  )}
                  {WAITS.map((w) => (
                    <option key={w} value={String(w)}>
                      {w === 0
                        ? ctx.t('way.waitNone')
                        : w < 1440
                          ? ctx.t('way.waitHours', { count: w / 60 })
                          : ctx.t('way.waitDays', { count: w / 1440 })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {/* 返事を待つだけの時間を、別の手順（人の作業の時間）にもすると、二つが重なる（Claude の案でも起きた）。 */}
            {s.to !== '' && <p className="text-sm text-sub">{ctx.t('way.waitOnly')}</p>}
            {s.to === '' && s.original !== undefined && s.original.waitAfterMin > 0 && (
              <p className="text-sm text-sub">
                {s.original.external
                  ? ctx.t('way.waitDropped', { min: s.original.waitAfterMin })
                  : ctx.t('way.waitAfterKept', { min: s.original.waitAfterMin })}
              </p>
            )}
            <label className="flex flex-col gap-1">
              <span className="font-bold">{ctx.t('way.place')}</span>
              <select
                className={input}
                value={s.place}
                onChange={(e) => step(i, (x) => (x.place = e.target.value))}
              >
                <option value="">{ctx.t('way.choose')}</option>
                <option value="-">{ctx.t('way.placeNone')}</option>
                {places.map((p) => option(p.id, p.name, s.original?.placeId))}
                <option value="+new">{ctx.t('way.placeNew')}</option>
              </select>
            </label>
            {s.place === '+new' && (
              <div className="flex flex-wrap gap-2">
                <input
                  aria-label={ctx.t('way.newPlaceName')}
                  placeholder={ctx.t('way.newPlaceName')}
                  className={`${input} min-w-0 flex-1`}
                  value={s.newPlace.name}
                  onChange={(e) => step(i, (x) => (x.newPlace.name = e.target.value))}
                />
                <select
                  aria-label={ctx.t('way.newPlaceKind')}
                  className={input}
                  value={s.newPlace.kind}
                  onChange={(e) =>
                    step(i, (x) => {
                      const kind = NEW_PLACE_KINDS.find((k) => k === e.target.value);
                      if (kind) x.newPlace.kind = kind;
                    })
                  }
                >
                  {NEW_PLACE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ctx.t(`household.places.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {s.place !== '' && s.place !== '-' && <Text quiet>{ctx.t('way.placeHoursNote')}</Text>}
            <fieldset className="flex flex-col gap-1">
              <legend className="font-bold">{ctx.t('way.segments')}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {SEGMENTS.map((k) => (
                  <label key={k} className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-5 accent-accent"
                      checked={s.segments.includes(k)}
                      onChange={() =>
                        step(i, (x) => {
                          x.segments = x.segments.includes(k)
                            ? x.segments.filter((y) => y !== k)
                            : [...x.segments, k];
                        })
                      }
                    />
                    {ctx.t(`household.week.kind.${k}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2">
              <span className="font-bold">{ctx.t('way.minutes')}</span>
              <input
                type="number"
                min={0}
                max={1440}
                className={`${input} w-24`}
                value={s.minutes}
                onChange={(e) => step(i, (x) => (x.minutes = e.target.value))}
              />
            </label>
            <DeadlineField
              ctx={ctx}
              label={ctx.t('way.deadline')}
              kind={s.deadline}
              days={s.days}
              at={s.at}
              {...(s.original?.deadline ? { keep: s.original.deadline } : {})}
              onChange={(kind, days, at) =>
                step(i, (x) => {
                  x.deadline = kind;
                  x.days = days;
                  x.at = at;
                })
              }
            />
            {s.coverAsk ? (
              <label className="flex flex-col gap-1">
                <span className="font-bold">{ctx.t('way.cover')}</span>
                <select
                  className={input}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== 'yes' && v !== 'no') return;
                    step(i, (x) => {
                      x.cover = v === 'yes';
                      delete x.coverAsk;
                    });
                  }}
                >
                  <option value="">{ctx.t('way.choose')}</option>
                  <option value="yes">{ctx.t('way.coverYes')}</option>
                  <option value="no">{ctx.t('way.coverNo')}</option>
                </select>
                <span className="text-sm text-sub">{ctx.t('way.coverNote')}</span>
              </label>
            ) : (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0 accent-accent"
                  checked={s.cover}
                  onChange={() => step(i, (x) => (x.cover = !x.cover))}
                />
                <span className="flex flex-col">
                  <span>{ctx.t('way.cover')}</span>
                  <span className="text-sm text-sub">{ctx.t('way.coverNote')}</span>
                </span>
              </label>
            )}
            {form.steps.length > 1 && (
              <MoreLink onClick={() => update((f) => f.steps.splice(i, 1))}>
                {ctx.t('way.removeStep')}
              </MoreLink>
            )}
          </Card>
        ))}
        {form.steps.length < MAX_STEPS && (
          <MoreLink
            onClick={() =>
              update((f) => {
                let n = f.steps.length + 1;
                while (f.steps.some((s) => s.id === `s${n}`)) n += 1;
                f.steps.push(emptyStep(n));
              })
            }
          >
            {ctx.t('way.addStep')}
          </MoreLink>
        )}
        <Card>
          {form.original?.deadline && (
            <DeadlineField
              ctx={ctx}
              label={ctx.t('way.wayDeadline')}
              kind={form.wayDeadline}
              days={form.wayDays}
              at={form.wayAt}
              keep={form.original.deadline}
              onChange={(kind, days, at) =>
                update((f) => {
                  f.wayDeadline = kind;
                  f.wayDays = days;
                  f.wayAt = at;
                })
              }
            />
          )}
          <span className="font-bold">{ctx.t('way.covers')}</span>
          {asksCovers && (
            <select
              aria-label={ctx.t('way.covers')}
              className={input}
              value={form.coversAsk}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || v === 'whole' || v === 'part') update((f) => (f.coversAsk = v));
              }}
            >
              <option value="">{ctx.t('way.choose')}</option>
              <option value="whole">{ctx.t('way.coversWhole')}</option>
              <option value="part">{ctx.t('way.coversPart')}</option>
            </select>
          )}
          {(!asksCovers || form.coversAsk === 'part') && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label={ctx.t('way.coversStart')}
                className={input}
                value={form.coversStart}
                onChange={(e) => update((f) => (f.coversStart = e.target.value))}
              />
              <span>–</span>
              <input
                type="time"
                aria-label={ctx.t('way.coversEnd')}
                className={input}
                value={form.coversEnd}
                onChange={(e) => update((f) => (f.coversEnd = e.target.value))}
              />
            </div>
          )}
          <Text quiet>
            {ctx.t(
              asksCovers
                ? form.copy
                  ? 'way.copy.coversAskNote'
                  : 'way.coversAskNote'
                : 'way.coversNote',
            )}
          </Text>
        </Card>
        <Card>
          <span className="font-bold">{ctx.t('way.cost')}</span>
          {COST_FIELDS.map((f) => (
            <div key={f} className="flex flex-wrap items-center gap-2">
              <span className="min-w-36">{ctx.t(`way.costField.${f}`)}</span>
              <input
                type="number"
                min={0}
                step={f === 'leaveMinutes' ? 0.5 : 1}
                aria-label={ctx.t(`way.costField.${f}`)}
                className={`${input} w-24`}
                value={form.cost[f].unknown ? '' : form.cost[f].value}
                disabled={form.cost[f].unknown}
                onChange={(e) =>
                  update((x) => {
                    x.cost[f].value = e.target.value;
                    if (f === 'helperRequests') delete x.derivedHelpers;
                  })
                }
              />
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-5 accent-accent"
                  checked={form.cost[f].unknown}
                  onChange={() =>
                    update((x) => {
                      x.cost[f].unknown = !x.cost[f].unknown;
                      if (!x.cost[f].unknown && x.cost[f].value === '') x.cost[f].value = '0';
                      if (f === 'helperRequests') delete x.derivedHelpers;
                    })
                  }
                />
                {ctx.t('way.unknown')}
              </label>
            </div>
          ))}
          {form.derivedHelpers && <Text quiet>{ctx.t('way.helpersDerived')}</Text>}
          <Text quiet>{ctx.t('way.costNote')}</Text>
        </Card>
        {(form.copy || ctx.household.preparations.length > 0) && (
          <Card>
            <span className="font-bold">{ctx.t('way.requires.label')}</span>
            {form.copy && <CopyRegistration ctx={ctx} form={form} update={update} />}
            {ctx.household.preparations
              // 写した表では、この所の登録と、登録の欄で選んだ前提は、登録の欄だけで決める（一覧に重ねて出さない）。
              .filter(
                (p) =>
                  !form.copy ||
                  (p.resourceId !== form.copy.resourceId && p.id !== form.copy.registration),
              )
              .map((p) => {
                const on = form.requires.includes(p.id);
                return (
                  <label key={p.id} className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-5 accent-accent"
                      checked={on}
                      onChange={() =>
                        update((f) => {
                          f.requires = on
                            ? f.requires.filter((id) => id !== p.id)
                            : [...f.requires, p.id];
                        })
                      }
                    />
                    <span>
                      {ctx.t('way.requires.item', {
                        name: p.name,
                        state: ctx.t(`resources.preparation.state.${p.state}`),
                      })}
                    </span>
                  </label>
                );
              })}
            <Text quiet>{ctx.t('way.requires.note')}</Text>
          </Card>
        )}
        <Card tone="accent">
          {!draft && <Text>{ctx.t(form.copy ? 'way.copy.missing' : 'way.missing')}</Text>}
          {draft && (
            <Shown
              ctx={ctx}
              {...(shown ? { preview: shown } : {})}
              {...(refused ? { refused } : {})}
            />
          )}
          <Row>
            {shown && draft ? (
              <Button
                onClick={() =>
                  void flow.save(draft).then((ok) => {
                    if (ok) back();
                  })
                }
                disabled={flow.busy}
              >
                {ctx.t('way.save')}
              </Button>
            ) : (
              <Button
                onClick={() => draft && void flow.look(draft)}
                disabled={!draft || flow.busy || !ctx.previewHousehold}
              >
                {ctx.t('need.look')}
              </Button>
            )}
            <Button kind="secondary" onClick={back} disabled={flow.busy}>
              {ctx.t('ways.back')}
            </Button>
          </Row>
        </Card>
      </Main>
    </>
  );
}

/**
 * 写したやり方の、この所の事前の登録：この所の登録（家にある物）か、ほかの登録と同じか、要らないか、まだ分からないか
 * を一つ選ぶ（選んだ前提が、そのまま前提になる）。この所の登録が家に無ければ、そう書く。
 */
function CopyRegistration({
  ctx,
  form,
  update,
}: {
  ctx: Ctx;
  form: WayForm;
  update: (change: (f: WayForm) => void) => void;
}) {
  const copy = form.copy;
  if (!copy) return null;
  const place = nameOf(ctx.household, copy.placeId);
  const own = ctx.household.preparations.filter((p) => p.resourceId === copy.resourceId);
  const others = ctx.household.preparations.filter((p) => p.resourceId !== copy.resourceId);
  const state = (p: { state: string }) => ctx.t(`resources.preparation.state.${p.state}`);
  return (
    <>
      <label className="flex flex-col gap-1">
        <span>{ctx.t('way.copy.registration', { place })}</span>
        <select
          className={input}
          value={copy.registration}
          onChange={(e) => {
            const v = e.target.value;
            update((f) => {
              if (f.copy) f.copy.registration = v;
            });
          }}
        >
          <option value="">{ctx.t('way.choose')}</option>
          {own.map((p) => (
            <option key={p.id} value={p.id}>
              {ctx.t('way.copy.registrationOwn', { name: p.name, state: state(p) })}
            </option>
          ))}
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {ctx.t('way.copy.registrationSame', { name: p.name, state: state(p) })}
            </option>
          ))}
          <option value="none">{ctx.t('way.copy.registrationNotNeeded')}</option>
          <option value="unsure">{ctx.t('way.copy.registrationUnsure')}</option>
        </select>
      </label>
      {copy.registration === 'unsure' && <Text>{ctx.t('way.copy.registrationUnsureNote')}</Text>}
      {own.length === 0 && <Text quiet>{ctx.t('way.copy.noOwnRegistration', { place })}</Text>}
    </>
  );
}

/**
 * 周りの資源の所を使う、写したやり方の表の上に：写した元と前のやり方を替えないこと、今この所に頼む・行く手順（表の
 * 今の中身から。元に戻したら、そう出す）、前の所の時間・費用・期限を使わないこと、この所の出典の頁。
 */
function CopyBanner({ ctx, form }: { ctx: Ctx; form: WayForm }) {
  const copy = form.copy;
  if (!copy) return null;
  const place = nameOf(ctx.household, copy.placeId);
  const here = form.steps
    .filter((s) => s.to === copy.placeId || s.place === copy.placeId)
    .map((s) => s.name.trim() || ctx.t('way.step', { n: form.steps.indexOf(s) + 1 }));
  const source = ctx.household.resources.find((r) => r.id === copy.resourceId)?.notes[0]?.source;
  return (
    <Card tone="accent">
      <Label tone="accent">{ctx.t('way.copy.label')}</Label>
      <Text>{ctx.t('way.copy.intro', { way: copy.from, place })}</Text>
      <Text>
        {here.length > 0
          ? ctx.t('way.copy.steps', { place, steps: here.join(ctx.t('list.separator')) })
          : ctx.t('way.copy.noSteps', { place })}
      </Text>
      <Text quiet>{ctx.t('way.copy.facts', { place })}</Text>
      {source && <SourceLink ctx={ctx} source={source} />}
    </Card>
  );
}

/** Claude の案を写した表の上に、推定であることと、Claude が埋めない欄・確かめてほしいことを出す。 */
function IdeaBanner({ ctx, draft }: { ctx: Ctx; draft: CheckedDraft }) {
  return (
    <Card tone="accent">
      <Label tone="accent">{ctx.t('wayIdeas.formLabel')}</Label>
      <Text>{ctx.t('wayIdeas.formIntro')}</Text>
      {draft.why !== '' && <Text quiet>{draft.why}</Text>}
      <Text quiet>{ctx.t('wayIdeas.formOutside')}</Text>
      <Text quiet>{ctx.t('wayIdeas.formEstimates')}</Text>
      {draft.unclear.length > 0 && (
        <>
          <Label tone="sub">{ctx.t('wayIdeas.unclearLabel')}</Label>
          {draft.unclear.map((u) => (
            <Text key={u}>{u}</Text>
          ))}
        </>
      )}
      {draft.notes.length > 0 && (
        <>
          <Label tone="sub">{ctx.t('wayIdeas.notesLabel')}</Label>
          {draft.notes.map((n) => (
            <Text key={JSON.stringify(n)} quiet>
              {noteText(ctx, n)}
            </Text>
          ))}
        </>
      )}
    </Card>
  );
}

/** いつまでに：選ぶまで保存しない（決まり無しは、選ぶ物の一つ）。 */
function DeadlineField(props: {
  ctx: Ctx;
  label: string;
  kind: DeadlineKind;
  days: string;
  at: string;
  keep?: DeadlineRule;
  onChange: (kind: DeadlineKind, days: string, at: string) => void;
}) {
  const { ctx, kind, days, at, keep, onChange } = props;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="font-bold">{props.label}</span>
        <select
          className={input}
          value={kind}
          onChange={(e) => {
            const next = (
              ['', 'keep', 'none', 'daysBefore', 'businessDaysBefore', 'onTheDay'] as const
            ).find((k) => k === e.target.value);
            if (next !== undefined) onChange(next, days, at);
          }}
        >
          <option value="">{ctx.t('way.choose')}</option>
          {keep?.type === 'weekdayOfPreviousWeek' && (
            <option value="keep">
              {ctx.t('way.deadlineKeep', { rule: deadlineText(ctx, keep) })}
            </option>
          )}
          <option value="none">{ctx.t('way.deadlineNone')}</option>
          <option value="daysBefore">{ctx.t('way.deadlineDays')}</option>
          <option value="businessDaysBefore">{ctx.t('way.deadlineBusinessDays')}</option>
          <option value="onTheDay">{ctx.t('way.deadlineOnTheDay')}</option>
        </select>
      </label>
      {(kind === 'daysBefore' || kind === 'businessDaysBefore' || kind === 'onTheDay') && (
        <div className="flex flex-wrap items-center gap-2">
          {kind !== 'onTheDay' && (
            <label className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={30}
                aria-label={ctx.t('way.days')}
                className={`${input} w-20`}
                value={days}
                onChange={(e) => onChange(kind, e.target.value, at)}
              />
              {ctx.t(
                kind === 'daysBefore'
                  ? 'household.ways.daysUnit'
                  : 'household.ways.businessDaysUnit',
              )}
            </label>
          )}
          <input
            type="time"
            aria-label={ctx.t('way.at')}
            className={input}
            value={at}
            onChange={(e) => onChange(kind, days, e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
