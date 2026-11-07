// 「うちのこと」：まにあうが計算に使っている、家族と暮らしの情報（人・ふだんの一週間・場所と店・取れる手）。
// 見て、直して、保存の前に「この変更で変わること」を見る（サーバーが書き込まずに、書く時と同じ命令と同じ計算で
// 作った結果）。直せる範囲はサーバーが決める（成員の身元・場所・手の形は替えない）。
import type {
  CareOptionTemplate,
  DeadlineRule,
  Household,
  HouseholdPreview,
  Member,
  Place,
  RoutineSegment,
} from '@maniau/core';
import { useState } from 'react';
import { HouseholdMapCard } from './household-map';
import { RecordedDays } from './member-day';
import { ResourcesCard } from './resources';
import {
  type Ctx,
  day,
  dayTime,
  leaveText,
  nameOf,
  optionList,
  releasedTitle,
  taskTitle,
  timeOnly,
} from './screens';
import { Button, Card, Header, Label, Main, Row, Text, Title } from './ui';
import { WaysCard } from './ways';

type Mode = 'people' | 'week' | 'places' | 'ways';
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const EDITABLE_KINDS = ['home', 'work', 'pickup', 'away'] as const;
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

/**
 * 取れる手を「使えない」とする（学童の登録が無かった・頼めなくなった等）。保存した後は戻さない（また使う時は新しく
 * 足す）。保存の前なら、付けた印を外せる。
 */
function UnusableToggle(props: {
  ctx: Ctx;
  saved: boolean;
  marked: boolean;
  onChange: (marked: boolean) => void;
}) {
  const { ctx } = props;
  if (props.saved) return null;
  return (
    <Row>
      <Button kind="secondary" onClick={() => props.onChange(!props.marked)}>
        {ctx.t(props.marked ? 'household.ways.keepUsable' : 'household.ways.markUnusable')}
      </Button>
    </Row>
  );
}

/** 子の習い事の送り迎えの決まり（行き＝送る・帰り＝迎える）の選び肢。決めていない（無い）は、選び肢に入れない。 */
const ESCORT_RULES = {
  toFrom: { to: true, from: true },
  toNoFrom: { to: true, from: false },
  noFrom: { to: false, from: true },
  noNoFrom: { to: false, from: false },
} as const;
type EscortRule = Member['clubEscort'];
const escortKey = (rule: NonNullable<EscortRule>) =>
  `${rule.to ? 'to' : 'no'}${rule.from ? 'From' : 'NoFrom'}` as keyof typeof ESCORT_RULES;
const sameEscort = (a: EscortRule, b: EscortRule) =>
  a === undefined || b === undefined ? a === b : a.to === b.to && a.from === b.from;
/** 子の決まりの言葉（決めていなければ、そう書く）。 */
const escortText = (ctx: Ctx, rule: EscortRule) =>
  ctx.t(`household.people.escortRule.${rule ? escortKey(rule) : 'unset'}`);

/** 時刻の欄の値が、分までの時刻か。 */
const clockOk = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * 下書きの学童の手の見てもらえる時間が、どれも始まりと終わりのそろった、前後の正しい時間か（そうでない間は、保存の
 * 前に変わることを見る所へ進ませない。画面に出ている値と違う物を見せない・書かない）。
 */
export function hoursReady(household: Household): boolean {
  return household.careOptions.every(
    (o) =>
      o.kind !== 'afterSchoolFullDay' ||
      typeof o.covers !== 'object' ||
      (clockOk(o.covers.start) && clockOk(o.covers.end) && o.covers.start < o.covers.end),
  );
}

/**
 * 学童の一日利用で見てもらえる時間を直す欄。欄は家の情報の下書きをそのまま映し（打った値は、空でも逆さまでも下書きに
 * 入る）、空・逆さまの間はそう書く（hoursReady が、見る所へ進ませない）。
 */
function HoursEdit(props: {
  ctx: Ctx;
  covers: CareOptionTemplate['covers'];
  onChange: (covers: { start: string; end: string }) => void;
}) {
  const { ctx } = props;
  const typed = typeof props.covers === 'object' ? props.covers : undefined;
  const from = typed?.start ?? '';
  const to = typed?.end ?? '';
  const missing = typed !== undefined && (!clockOk(from) || !clockOk(to));
  const backwards = typed !== undefined && !missing && from >= to;
  return (
    <div className="flex flex-col gap-1.5">
      <span>{ctx.t('careAdd.afterSchool.hours')}</span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="time"
          aria-label={ctx.t('careAdd.afterSchool.hoursFrom')}
          className={input}
          value={from}
          onChange={(e) => props.onChange({ start: e.target.value, end: to })}
        />
        <span aria-hidden="true">–</span>
        <input
          type="time"
          aria-label={ctx.t('careAdd.afterSchool.hoursTo')}
          className={input}
          value={to}
          onChange={(e) => props.onChange({ start: from, end: e.target.value })}
        />
      </div>
      {missing && (
        <span className="text-sm font-bold text-warn">
          {ctx.t('careAdd.afterSchool.hoursMissing')}
        </span>
      )}
      {backwards && (
        <span className="text-sm font-bold text-warn">
          {ctx.t('careAdd.afterSchool.hoursBackwards')}
        </span>
      )}
    </div>
  );
}

/** 曜日の名前（1 が月曜）。2026-11-23 は月曜。 */
const weekdayName = (ctx: Ctx, weekday: number) =>
  new Intl.DateTimeFormat(ctx.lang, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 22 + weekday)),
  );

/** 同じ時間の曜日をまとめた営業時間（毎日・月・火…）。休みの曜日は書かない。 */
function hoursText(ctx: Ctx, place: Place): string {
  const periods = place.hours?.periods ?? [];
  if (periods.length === 0) return ctx.t('household.places.noHours');
  const groups = new Map<string, number[]>();
  for (const p of periods) {
    const key = `${p.open}–${p.close}`;
    groups.set(key, [...(groups.get(key) ?? []), p.weekday]);
  }
  return [...groups]
    .map(([range, days]) =>
      days.length === 7
        ? ctx.t('household.places.everyDay', { range })
        : `${days.map((d) => weekdayName(ctx, d)).join(ctx.t('household.places.daySeparator'))} ${range}`,
    )
    .join(ctx.t('list.separator'));
}

function sourceText(ctx: Ctx, place: Place): string | undefined {
  const hours = place.hours;
  if (!hours) return undefined;
  const from = ctx.t(`household.places.source.${hours.source}`);
  return hours.checkedAt
    ? ctx.t('household.places.checked', { from, when: dayTime(ctx, hours.checkedAt) })
    : from;
}

export function deadlineText(ctx: Ctx, rule: DeadlineRule): string {
  switch (rule.type) {
    case 'daysBefore':
      return ctx.t('household.ways.daysBefore', { count: rule.days, days: rule.days, at: rule.at });
    case 'businessDaysBefore':
      return ctx.t('household.ways.businessDaysBefore', {
        count: rule.days,
        days: rule.days,
        at: rule.at,
      });
    case 'weekdayOfPreviousWeek':
      return ctx.t('household.ways.previousWeek', {
        weekday: weekdayName(ctx, rule.weekday),
        at: rule.at,
      });
    case 'onTheDay':
      return ctx.t('household.ways.onTheDay', { at: rule.at });
  }
}

/**
 * 取れる手の名前（決める画面と同じ言葉）。from は名前を引く家の情報（保存の前の見通しでは直した後の物。そこで
 * 足す頼める人は、今の家の情報にはまだ居ない）。
 */
function wayTitle(ctx: Ctx, way: CareOptionTemplate, from: Household = ctx.household): string {
  const id = way.kind === 'askHelper' ? way.providerId : way.steps[0]?.assigneeId;
  return ctx.t(`${way.titleKey}.title`, { name: nameOf(from, id) || nameOf(ctx.household, id) });
}

function stepsText(ctx: Ctx, way: CareOptionTemplate): string {
  return way.steps
    .map((step) => {
      const title = ctx.t(step.titleKey, { name: nameOf(ctx.household, way.providerId) });
      return step.external ? ctx.t('household.ways.waitsReply', { title }) : title;
    })
    .join(' → ');
}

function costText(ctx: Ctx, way: CareOptionTemplate): string {
  const parts: string[] = [];
  if (way.cost.yen > 0) parts.push(ctx.t('household.ways.yen', { yen: way.cost.yen }));
  if (way.cost.leaveMinutes > 0) {
    parts.push(leaveText(ctx, way.cost.leaveMinutes));
  }
  if (way.cost.helperRequests > 0) parts.push(ctx.t('cost.helper'));
  return parts.join(ctx.t('list.separator'));
}

export function segmentText(ctx: Ctx, segment: RoutineSegment): string {
  const range = `${segment.start}–${segment.end}`;
  const kind = ctx.t(`household.week.kind.${segment.kind}`);
  const where =
    segment.kind === 'commute'
      ? ctx.t('household.week.route', {
          from: nameOf(ctx.household, segment.fromId),
          to: nameOf(ctx.household, segment.toId),
        })
      : segment.placeId && segment.kind !== 'home'
        ? nameOf(ctx.household, segment.placeId)
        : '';
  return where
    ? ctx.t('household.week.segmentAt', { range, kind, where })
    : ctx.t('household.week.segment', { range, kind });
}

/** 検証器の「確かめられない」のうち、行き先までの道のり（徒歩・乗り換え・通る駅）を照らせない物。 */
const ROUTE_UNVERIFIED = new Set([
  'route_is_estimate',
  'route_estimate_missing',
  'route_evidence_missing',
  'route_unconfirmed',
]);

/**
 * 「この変更で変わること」の行（何も変わらなければ一行）。after は直した後の家の情報（新しく足す場所の名前を、
 * 保存する前にも書けるように。無ければ今の家の情報）。
 */
export function householdPreviewLines(
  ctx: Ctx,
  preview: HouseholdPreview,
  after?: Household,
): string[] {
  const { changes } = preview;
  const lines: string[] = [];
  const placeName = (id: string) => (after ? nameOf(after, id) : '') || nameOf(ctx.household, id);
  const titleOf = (key: string) => {
    const task = ctx.plan.tasks.find((t) => t.key === key);
    return task ? taskTitle(ctx, task) : key;
  };
  // 頼む手順の題に入れる、頼む相手（取れる手の型。作業の鍵の手の部分の最後が型の ID）。
  const templateOf = (key: string) =>
    ctx.household.careOptions.find((o) => o.id === key.split(':').at(-1));
  // 今の計画に無い手（直した後に新しく選べる手）は、差分が持つ手の決まりの ID で、直した後の家の情報（無ければ今の
  // 物）のやり方・取れる手の型から名前を引く。手配が今の計画にあり、日のある「すること」なら日も添える（今の計画の
  // 手と同じ書き方）。どれも無ければ「ある手」。
  const templateTitle = (templateId: string) => {
    for (const household of after ? [after, ctx.household] : [ctx.household]) {
      const way = household.ways.find((w) => w.id === templateId);
      if (way) return ctx.t('option.way.title', { name: way.name });
      const template = household.careOptions.find((o) => o.id === templateId);
      if (template) return wayTitle(ctx, template, household);
    }
    return undefined;
  };
  const optionName = (option: {
    arrangementKey: string;
    optionKey: string;
    templateId: string;
  }) => {
    const named = optionList(ctx, [option.optionKey]);
    if (named) return named;
    const title = templateTitle(option.templateId);
    if (title === undefined) return ctx.t('household.preview.aWay');
    const arrangement = ctx.plan.arrangements.find((a) => a.key === option.arrangementKey);
    const date = arrangement
      ? ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey)?.date
      : undefined;
    return ctx.t('decide.quoted', {
      title: date ? ctx.t('decide.onDay', { title, day: day(ctx, date) }) : title,
    });
  };
  // 手配の主語（手配の時間の変化と勧める手の変化で同じ書き方）。
  const arrangementName = (a: {
    kind: HouseholdPreview['changes']['windows'][number]['kind'];
    childId?: string;
    what?: string;
  }) =>
    a.kind === 'childCare'
      ? ctx.t('household.preview.window.childCare', {
          child: a.childId
            ? nameOf(ctx.household, a.childId)
            : ctx.t('household.preview.window.aChild'),
        })
      : a.kind === 'need'
        ? ctx.t('household.preview.window.need', { what: a.what ?? '' })
        : ctx.t('household.preview.window.purchase');
  // 手配の時間（子の居場所が要る時間など）：同じ日の中なら終わりは時刻だけ。締切までに済ませる「すること」は、
  // 締切だけ（始まりは今で、要る時間ではない）。日だけの締切（その日の終わり。計画の時刻は家庭の時区で書いて
  // ある）は日だけ（書かれていない時刻を見せない）。
  const spanOf = (w: (typeof changes.windows)[number]) => (x: { start: string; end: string }) =>
    w.kind === 'need' && w.needShape === 'by'
      ? ctx.t('household.preview.window.by', {
          by: x.end.slice(11, 16) === '23:59' ? day(ctx, x.end) : dayTime(ctx, x.end),
        })
      : `${dayTime(ctx, x.start)}–${day(ctx, x.end) === day(ctx, x.start) ? timeOnly(ctx, x.end) : dayTime(ctx, x.end)}`;
  for (const w of changes.windows) {
    const span = spanOf(w);
    const what = arrangementName(w);
    const sameWindow =
      w.before !== undefined &&
      w.after !== undefined &&
      w.before.start === w.after.start &&
      w.before.end === w.after.end;
    if (sameWindow) {
      // 手配の時間は同じで、分かれ方だけが変わる（下の行で書く）。
    } else if (w.before && w.after) {
      lines.push(
        ctx.t('household.preview.window.moved', {
          what,
          before: span(w.before),
          after: span(w.after),
        }),
      );
    } else if (w.after) {
      lines.push(ctx.t('household.preview.window.new', { what, when: span(w.after) }));
    } else if (w.before) {
      lines.push(ctx.t('household.preview.window.gone', { what, when: span(w.before) }));
    }
    // 見守れる大人を確かめられない時間が分かれる日は、全部の時間と、手配がどの時間の分かを書く。分かれていた日が
    // 分かれなくなる時も書く（手配の時間が同じでも、短い時間が消えることを黙らない）。
    const list = (gs: readonly { start: string; end: string }[]) =>
      new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(gs.map((g) => span(g)));
    if (w.split && w.after) {
      lines.push(
        ctx.t('household.preview.window.split', {
          what,
          times: list(w.split),
          main: span(w.after),
        }),
      );
    } else if (w.splitBefore && w.after) {
      lines.push(
        ctx.t('household.preview.window.joined', {
          what,
          before: list(w.splitBefore),
          main: span(w.after),
        }),
      );
    }
  }
  // 子の習い事の送り迎えの決まりを替えた（決まりそのものを書く。作業の増減と引き受けは、ほかの行が書く）。
  for (const child of (after?.members ?? []).filter((m) => m.kind === 'child' && m.active)) {
    const was = ctx.household.members.find((m) => m.id === child.id)?.clubEscort;
    if (sameEscort(was, child.clubEscort)) continue;
    lines.push(
      ctx.t('household.preview.escort', {
        name: child.name,
        rule: escortText(ctx, child.clubEscort),
      }),
    );
  }
  // 新しく使えないとした手（手の名前と、送った頼み事は取り消さないこと・また使う時は新しく足すこと）。見てもらえない
  // 時間の変化の行は、この手には出さない（同じことを二度書かない）。
  const before = new Set(ctx.household.unusableCareOptionIds ?? []);
  const unusable = (after?.unusableCareOptionIds ?? []).filter((id) => !before.has(id));
  for (const id of unusable) {
    const template = after?.careOptions.find((o) => o.id === id);
    if (template) {
      lines.push(ctx.t('household.preview.unusable', { name: wayTitle(ctx, template, after) }));
    }
  }
  // 選んだ手（本命・予備）で、手配の時間のうち見てもらえない時間が変わる（学童の時間を直した時など）。
  for (const c of (changes.covers ?? []).filter((x) => !unusable.includes(x.templateId))) {
    const name = optionName(c);
    const gaps = new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(
      c.after.map((g) => `${timeOnly(ctx, g.start)}–${timeOnly(ctx, g.end)}`),
    );
    const known = (list: typeof c.after) => list.filter((g) => !g.unsure);
    if (c.after.length === 0) lines.push(ctx.t('household.preview.cover.full', { name }));
    else if (known(c.after).length === 0)
      lines.push(ctx.t('household.preview.cover.unsure', { name, gaps }));
    else if (known(c.before).length === 0)
      lines.push(ctx.t('household.preview.cover.lost', { name, gaps }));
    else lines.push(ctx.t('household.preview.cover.changed', { name, gaps }));
  }
  // いつにするかの候補と、記録した手が離せない時間の重なりが、新しくできる・無くなる（答えは変えない）。
  for (const o of changes.overlaps ?? []) {
    lines.push(
      ctx.t(
        o.change === 'added'
          ? 'household.preview.overlap.added'
          : 'household.preview.overlap.removed',
        {
          what: o.what ?? '',
          when: `${dayTime(ctx, o.candidate.start)}–${timeOnly(ctx, o.candidate.end)}`,
          name: (after ? nameOf(after, o.personId) : '') || nameOf(ctx.household, o.personId),
          busy: `${timeOnly(ctx, o.busy.start)}–${timeOnly(ctx, o.busy.end)}`,
        },
      ),
    );
  }
  for (const d of changes.deadlines) {
    const name = optionName(d);
    const { before, after } = d;
    if (!after) {
      lines.push(ctx.t('household.preview.wayGone', { name }));
      continue;
    }
    if (!before) {
      lines.push(ctx.t('household.preview.wayNew', { name }));
      continue;
    }
    // 直した後に決め時を計算できない手は、間に合わないとも間に合うとも言わない（確かめられないと書く）。
    // 計算できる手には、決め時がある（エンジンの決まり）。
    if (after.deadlineCertainty === 'undetermined') {
      lines.push(ctx.t('household.preview.deadlineUnknown', { name }));
    } else if (after.expired && !before.expired) {
      lines.push(ctx.t('household.preview.expires', { name }));
    } else if (before.expired && !after.expired) {
      lines.push(ctx.t('household.preview.reopens', { name }));
    } else if (before.decisionDeadline && after.decisionDeadline) {
      lines.push(
        ctx.t('household.preview.deadline', {
          name,
          before: dayTime(ctx, before.decisionDeadline),
          after: dayTime(ctx, after.decisionDeadline),
        }),
      );
    } else if (after.decisionDeadline) {
      lines.push(
        ctx.t('household.preview.deadlineKnown', {
          name,
          after: dayTime(ctx, after.decisionDeadline),
        }),
      );
    }
  }
  // 前もっての前提（事前の登録など）の印と、「使わない」とした資源の印、勧める手の変化。
  const preparationNames = (gaps: { preparationId: string }[]) =>
    gaps
      .map(
        (g) =>
          (after ?? ctx.household).preparations.find((p) => p.id === g.preparationId)?.name ??
          ctx.t('decide.preparation.unnamed'),
      )
      .join(ctx.t('resources.applies.joiner'));
  for (const p of changes.preparations ?? []) {
    const name = optionName(p);
    if (p.after.length === 0) {
      lines.push(
        ctx.t('household.preview.preparation.cleared', { name, what: preparationNames(p.before) }),
      );
    } else {
      lines.push(
        ctx.t(
          p.before.length === 0
            ? 'household.preview.preparation.added'
            : 'household.preview.preparation.changed',
          { name, what: preparationNames(p.after) },
        ),
      );
    }
  }
  const resourceNames = (ids: string[]) =>
    ids
      .map((id) => (after ?? ctx.household).resources.find((r) => r.id === id)?.name ?? id)
      .join(ctx.t('resources.applies.joiner'));
  for (const u of changes.unusedResources ?? []) {
    const name = optionName(u);
    lines.push(
      u.after.length > 0
        ? ctx.t('household.preview.unused.added', { name, what: resourceNames(u.after) })
        : ctx.t('household.preview.unused.cleared', { name, what: resourceNames(u.before) }),
    );
  }
  for (const r of changes.recommendations ?? []) {
    const what = arrangementName(r);
    const named = (o: { optionKey: string; templateId: string }) =>
      optionName({ arrangementKey: r.arrangementKey, ...o });
    if (r.before && r.after) {
      lines.push(
        ctx.t('household.preview.recommend.changed', {
          what,
          before: named(r.before),
          after: named(r.after),
        }),
      );
    } else if (r.after) {
      lines.push(ctx.t('household.preview.recommend.new', { what, name: named(r.after) }));
    } else if (r.before) {
      lines.push(ctx.t('household.preview.recommend.gone', { what, name: named(r.before) }));
    }
  }
  for (const step of changes.added) {
    // 頼む手順の題は、頼む相手の名前を手の決まりから入れる（作業の鍵は task:<手の鍵>:<手順>。手の鍵の最後が型の ID）。
    const template =
      step.titleKey === 'task.helper.ask'
        ? templateOf(step.taskKey.split(':').slice(0, -1).join(':'))
        : undefined;
    const what =
      step.titleKey === 'task.helper.ask'
        ? ctx.t('task.helper.ask', {
            name: template?.kind === 'askHelper' ? nameOf(ctx.household, template.providerId) : '',
          })
        : ctx.t(step.titleKey, step.titleParams);
    lines.push(
      step.start
        ? ctx.t('household.preview.added', { what, when: dayTime(ctx, step.start) })
        : ctx.t('household.preview.addedUntimed', { what }),
    );
  }
  for (const step of changes.removed) {
    lines.push(ctx.t('household.preview.removed', { what: titleOf(step.taskKey) }));
  }
  for (const m of changes.moved) {
    lines.push(
      ctx.t('household.preview.moved', {
        what: titleOf(m.taskKey),
        before: m.before.start ? dayTime(ctx, m.before.start) : '',
        after: m.after.start ? dayTime(ctx, m.after.start) : '',
      }),
    );
  }
  for (const key of changes.unplaced) {
    lines.push(ctx.t('household.preview.unplaced', { what: titleOf(key) }));
  }
  for (const key of changes.placed) {
    lines.push(ctx.t('household.preview.placed', { what: titleOf(key) }));
  }
  for (const r of changes.reassigned) {
    lines.push(
      ctx.t('household.preview.reassigned', {
        what: titleOf(r.taskKey),
        before: r.before ? nameOf(ctx.household, r.before) : ctx.t('household.preview.nobody'),
        after: r.after ? nameOf(ctx.household, r.after) : ctx.t('household.preview.nobody'),
      }),
    );
  }
  for (const r of changes.relocated) {
    lines.push(
      ctx.t('household.preview.relocated', {
        what: titleOf(r.taskKey),
        before: r.before ? placeName(r.before) : ctx.t('household.preview.noPlace'),
        after: r.after ? placeName(r.after) : ctx.t('household.preview.noPlace'),
      }),
    );
  }
  for (const key of changes.reconfirm) {
    lines.push(ctx.t('household.preview.reconfirm', { what: titleOf(key) }));
  }
  for (const key of changes.changed.filter((k) => !changes.reconfirm.includes(k))) {
    lines.push(ctx.t('household.preview.changed', { what: titleOf(key) }));
  }
  // 今の計画に見つからないだけの物（根拠のお知らせは残っている等）は、要らなくなったとは言わず、まだ要るかを
  // 引き受けた人に確かめてもらう（札・知らせと同じ）。
  for (const released of changes.released) {
    lines.push(
      ctx.t(
        released.reason === 'unconfirmed'
          ? 'household.preview.releasedCheck'
          : 'household.preview.released',
        {
          what: releasedTitle(ctx, released),
          name: nameOf(ctx.household, released.assigneeId),
        },
      ),
    );
  }
  // やり方の選びが古くなる「すること」（前の選びは当てない。家族に選び直してもらう）。
  for (const key of changes.rechoose) {
    const arrangement = ctx.plan.arrangements.find((a) => a.key === key);
    const what = ctx.plan.requirements.find((r) => r.key === arrangement?.requirementKey)?.what;
    lines.push(ctx.t('household.preview.rechoose', { what: what ?? '' }));
  }
  for (const request of changes.cancels) {
    lines.push(ctx.t('household.preview.cancel', { to: nameOf(ctx.household, request.to) }));
  }
  for (const request of changes.checks) {
    lines.push(ctx.t('household.preview.check', { to: nameOf(ctx.household, request.to) }));
  }
  if (changes.conflicts.length > 0) {
    lines.push(
      ctx.t('household.preview.conflict', { options: optionList(ctx, changes.conflicts) }),
    );
  }
  if (lines.length === 0 && preview.unverified.length > 0) {
    lines.push(ctx.t('household.preview.none'));
  }
  if (preview.issues.length > 0) {
    lines.push(ctx.t('household.preview.issues', { count: preview.issues.length }));
  }
  // 道のりと、必要な子の見守りを確かめられない点は、家族に意味を伝える。ほかの決まりも省かず数を残す。
  const route = preview.unverified.filter((code) => ROUTE_UNVERIFIED.has(code));
  if (route.length > 0) lines.push(ctx.t('household.preview.unverifiedRoute'));
  const care = preview.unverified.filter((code) => code === 'required_arrangement_missing');
  if (care.length > 0)
    lines.push(ctx.t('household.preview.unverifiedCare', { count: care.length }));
  const others = preview.unverified.length - route.length - care.length;
  if (others > 0) lines.push(ctx.t('household.preview.unverified', { count: others }));
  return lines;
}

export function HouseholdScreen({ ctx }: { ctx: Ctx }) {
  const [mode, setMode] = useState<Mode>();
  const [draft, setDraft] = useState<Household>();
  const [shown, setShown] = useState<HouseholdPreview>();
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [memberId, setMemberId] = useState<string>();
  const [weekday, setWeekday] = useState<number>(1);
  const household = draft ?? ctx.household;
  const people = household.members.filter((m) => m.active);
  const children = people.filter((m) => m.kind === 'child');
  const withRoutines = people.filter((m) => household.routines.some((d) => d.memberId === m.id));
  const editor = memberId ?? withRoutines[0]?.id;

  const edit = (next: Mode) => {
    setMode(next);
    setDraft(structuredClone(ctx.household));
    setShown(undefined);
    setRefused(undefined);
  };
  const change = (update: (h: Household) => void) => {
    const next = structuredClone(household);
    update(next);
    setDraft(next);
    setShown(undefined);
    setRefused(undefined);
  };
  const stop = () => {
    setMode(undefined);
    setDraft(undefined);
    setShown(undefined);
    setRefused(undefined);
  };
  const look = async () => {
    if (!draft || !ctx.previewHousehold) return;
    setBusy(true);
    const result = await ctx.previewHousehold(draft);
    setBusy(false);
    if (!result) setRefused('unavailable');
    else if ('refused' in result) setRefused(result.refused);
    else setShown(result.preview);
  };
  const save = async () => {
    if (!draft || !shown) return;
    setBusy(true);
    const result = await ctx.send({
      type: 'updateHousehold',
      household: draft,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    setBusy(false);
    if (result.status === 'ok' || result.status === 'noop') stop();
    else setShown(undefined);
  };

  const day = household.routines.find((d) => d.memberId === editor && d.weekday === weekday);
  const stores = household.places.filter((p) => p.kind === 'store');
  const lines = shown ? householdPreviewLines(ctx, shown, draft) : [];

  return (
    <>
      <Header title={ctx.t('household.title')} />
      <Main>
        <Text quiet>{ctx.t('household.intro')}</Text>

        {/* 周りの資源（家族と Claude が一緒に保つ。核の層）を最初に置く。ほかの札を直している間は出さない。 */}
        {mode === undefined && <HouseholdMapCard ctx={ctx} />}
        {mode === undefined && <ResourcesCard ctx={ctx} />}

        <Card>
          <Label tone="sub">{ctx.t('household.people.label')}</Label>
          {mode !== 'people' &&
            people.map((m) => (
              <Text key={m.id}>
                {ctx.t(`household.people.kind.${m.kind}`, { name: m.name })}
                {m.grade ? ctx.t('household.people.grade', { grade: m.grade }) : ''}
                {m.kind === 'child'
                  ? ctx.t('household.people.escort', { rule: escortText(ctx, m.clubEscort) })
                  : ''}
              </Text>
            ))}
          {/* 子ごとの習い事の送り迎えの決まり。決めていない子は、どれも選ばれていない（要らないとは決めない）。 */}
          {mode === 'people' && (
            <>
              <Text quiet>{ctx.t('household.people.escortHelp')}</Text>
              {children.length > 1 && <Text>{ctx.t('household.people.escortManyChildren')}</Text>}
              {children.map((child) => (
                <fieldset key={child.id} className="flex flex-col gap-1">
                  <legend className="font-bold">
                    {ctx.t('household.people.escortFor', { name: child.name })}
                  </legend>
                  {child.clubEscort === undefined && (
                    <Text quiet>{ctx.t('household.people.escortUnsetNow')}</Text>
                  )}
                  {(Object.keys(ESCORT_RULES) as (keyof typeof ESCORT_RULES)[]).map((key) => (
                    <label key={key} className="flex min-h-11 items-center gap-2">
                      <input
                        type="radio"
                        name={`escort-${child.id}`}
                        checked={sameEscort(child.clubEscort, ESCORT_RULES[key])}
                        onChange={() =>
                          change((h) => {
                            const member = h.members.find((m) => m.id === child.id);
                            if (member) member.clubEscort = { ...ESCORT_RULES[key] };
                          })
                        }
                      />
                      {ctx.t(`household.people.escortRule.${key}`)}
                    </label>
                  ))}
                </fieldset>
              ))}
            </>
          )}
          <Text quiet>{ctx.t('household.people.used')}</Text>
          {mode === undefined && children.length > 0 && (
            <Row>
              <Button kind="secondary" onClick={() => edit('people')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.week.label')}</Label>
          {mode !== 'week' &&
            withRoutines.map((m) => {
              const days = household.routines
                .filter((d) => d.memberId === m.id)
                .sort((a, b) => a.weekday - b.weekday);
              // 一週間の区間は長いので、人ごとに畳む（場所と店・取れる手まで、すぐ届くように）。
              return (
                <details key={m.id} className="flex flex-col gap-1">
                  <summary className="min-h-11 cursor-pointer py-2 font-bold">
                    {ctx.t('household.week.summary', { name: m.name, count: days.length })}
                  </summary>
                  {days.map((d) => (
                    <Text key={d.weekday}>
                      {weekdayName(ctx, d.weekday)}：
                      {d.segments.map((s) => segmentText(ctx, s)).join('・')}
                    </Text>
                  ))}
                </details>
              );
            })}
          {mode === 'week' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-2">
                {withRoutines.map((m) => (
                  <Button
                    key={m.id}
                    kind={m.id === editor ? 'primary' : 'secondary'}
                    onClick={() => setMemberId(m.id)}
                  >
                    {m.name}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setWeekday(d)}
                    aria-pressed={d === weekday}
                    className={`min-h-11 min-w-11 rounded-xl border-[1.5px] px-2 font-bold ${d === weekday ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
                  >
                    {weekdayName(ctx, d)}
                  </button>
                ))}
              </div>
              {!day && <Text quiet>{ctx.t('household.week.noDay')}</Text>}
              {day?.segments.map((segment, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 区間には ID が無く、画面は並びを替えない（時刻は直すたびに替わるので鍵にしない）
                  key={index}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    type="time"
                    aria-label={ctx.t('household.week.start')}
                    className={input}
                    value={segment.start}
                    onChange={(e) =>
                      change((h) => {
                        const segments = h.routines.find(
                          (r) => r.memberId === editor && r.weekday === weekday,
                        )?.segments;
                        const s = segments?.[index];
                        if (!s) return;
                        // 前の区間とつながっていれば、前の区間の終わりも動かす（切れ目を作らない）。
                        const previous = segments?.[index - 1];
                        if (previous && previous.end === s.start) previous.end = e.target.value;
                        s.start = e.target.value;
                      })
                    }
                  />
                  <span>–</span>
                  <input
                    type="time"
                    aria-label={ctx.t('household.week.end')}
                    className={input}
                    value={segment.end}
                    onChange={(e) =>
                      change((h) => {
                        const segments = h.routines.find(
                          (r) => r.memberId === editor && r.weekday === weekday,
                        )?.segments;
                        const s = segments?.[index];
                        if (!s) return;
                        // 次の区間とつながっていれば、次の区間の始まりも動かす（切れ目を作らない）。
                        const following = segments?.[index + 1];
                        if (following && following.start === s.end)
                          following.start = e.target.value;
                        s.end = e.target.value;
                      })
                    }
                  />
                  {segment.kind === 'commute' ? (
                    <span>{ctx.t('household.week.kind.commute')}</span>
                  ) : (
                    <select
                      aria-label={ctx.t('household.week.kindLabel')}
                      className={input}
                      value={segment.kind}
                      onChange={(e) =>
                        change((h) => {
                          const s = h.routines.find(
                            (r) => r.memberId === editor && r.weekday === weekday,
                          )?.segments[index];
                          if (!s) return;
                          const kind = e.target.value as RoutineSegment['kind'];
                          const homes = h.places.filter((p) => p.kind === 'home').map((p) => p.id);
                          const atHomePlace = s.placeId !== undefined && homes.includes(s.placeId);
                          // 過ごし方と場所を食い違わせない：「家」は家の場所にし、外出・迎えは家の場所を
                          // 外す（家で仕事をするのは、そのまま）。
                          if (kind === 'home') {
                            const home = homes[0];
                            if (home) s.placeId = home;
                            else delete s.placeId;
                          } else if ((kind === 'away' || kind === 'pickup') && atHomePlace) {
                            delete s.placeId;
                          }
                          s.kind = kind;
                        })
                      }
                    >
                      {EDITABLE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {ctx.t(`household.week.kind.${k}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}
          <Text quiet>{ctx.t('household.week.used')}</Text>
          {mode === undefined && (
            <Row>
              <Button kind="secondary" onClick={() => edit('week')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
          {mode === undefined && <RecordedDays ctx={ctx} />}
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.places.label')}</Label>
          {household.places
            .filter((p) => p.kind !== 'store')
            .map((p) => (
              <Text key={p.id}>
                {ctx.t(`household.places.kind.${p.kind}`)}：{p.name}
              </Text>
            ))}
          {stores.map((p) => (
            <div key={p.id} className="flex flex-col gap-1">
              <Text>
                {ctx.t('household.places.kind.store')}：{p.name}
              </Text>
              {mode !== 'places' && <Text quiet>{hoursText(ctx, p)}</Text>}
              {mode !== 'places' && sourceText(ctx, p) && <Text quiet>{sourceText(ctx, p)}</Text>}
              {mode === 'places' &&
                (p.hours?.periods ?? []).map((period, index) => (
                  <div key={period.weekday} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-8">{weekdayName(ctx, period.weekday)}</span>
                    <input
                      type="time"
                      aria-label={ctx.t('household.places.open')}
                      className={input}
                      value={period.open}
                      onChange={(e) =>
                        change((h) => {
                          const target = h.places.find((x) => x.id === p.id)?.hours?.periods[index];
                          if (target) target.open = e.target.value;
                        })
                      }
                    />
                    <span>–</span>
                    <input
                      type="time"
                      aria-label={ctx.t('household.places.close')}
                      className={input}
                      value={period.close}
                      onChange={(e) =>
                        change((h) => {
                          const target = h.places.find((x) => x.id === p.id)?.hours?.periods[index];
                          if (target) target.close = e.target.value;
                        })
                      }
                    />
                  </div>
                ))}
            </div>
          ))}
          <Text quiet>{ctx.t('household.places.used')}</Text>
          {mode === undefined && stores.length > 0 && (
            <Row>
              <Button kind="secondary" onClick={() => edit('places')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.ways.label')}</Label>
          {household.careOptions.map((way) => (
            <div key={way.id} className="flex flex-col gap-1">
              <Title>{wayTitle(ctx, way)}</Title>
              {/* 家族が使えないとした手（戻さない。また使う時は新しく足す）。 */}
              {household.unusableCareOptionIds?.includes(way.id) && (
                <Text quiet>{ctx.t('household.ways.unusable')}</Text>
              )}
              {mode === 'ways' && (
                <UnusableToggle
                  ctx={ctx}
                  saved={ctx.household.unusableCareOptionIds?.includes(way.id) === true}
                  marked={household.unusableCareOptionIds?.includes(way.id) === true}
                  onChange={(marked) =>
                    change((h) => {
                      const rest = (h.unusableCareOptionIds ?? []).filter((id) => id !== way.id);
                      const next = marked ? [...rest, way.id] : rest;
                      if (next.length > 0) h.unusableCareOptionIds = next;
                      else delete h.unusableCareOptionIds;
                    })
                  }
                />
              )}
              {mode !== 'ways' && <Text>{deadlineText(ctx, way.deadline)}</Text>}
              {/* 決まった時間だけ見てもらえる手（学童の一日利用など）は、その時間を書く。 */}
              {typeof way.covers === 'object' && (
                <Text quiet>
                  {ctx.t('household.ways.covers', { from: way.covers.start, to: way.covers.end })}
                </Text>
              )}
              {mode === 'ways' && (
                <div className="flex flex-wrap items-center gap-2">
                  {way.deadline.type === 'daysBefore' ||
                  way.deadline.type === 'businessDaysBefore' ? (
                    <label className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={30}
                        className={`${input} w-20`}
                        value={way.deadline.days}
                        onChange={(e) =>
                          change((h) => {
                            const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                            const days = Number.parseInt(e.target.value, 10);
                            if (
                              (rule?.type === 'daysBefore' ||
                                rule?.type === 'businessDaysBefore') &&
                              days > 0
                            ) {
                              rule.days = days;
                            }
                          })
                        }
                      />
                      {ctx.t(
                        way.deadline.type === 'daysBefore'
                          ? 'household.ways.daysUnit'
                          : 'household.ways.businessDaysUnit',
                      )}
                    </label>
                  ) : way.deadline.type === 'weekdayOfPreviousWeek' ? (
                    <select
                      aria-label={ctx.t('household.ways.weekday')}
                      className={input}
                      value={way.deadline.weekday}
                      onChange={(e) =>
                        change((h) => {
                          const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                          if (rule?.type === 'weekdayOfPreviousWeek') {
                            rule.weekday = Number(e.target.value) as typeof rule.weekday;
                          }
                        })
                      }
                    >
                      {WEEKDAYS.map((d) => (
                        <option key={d} value={d}>
                          {ctx.t('household.ways.previousWeekDay', {
                            weekday: weekdayName(ctx, d),
                          })}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input
                    type="time"
                    aria-label={ctx.t('household.ways.at')}
                    className={input}
                    value={way.deadline.at}
                    onChange={(e) =>
                      change((h) => {
                        const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                        if (rule) rule.at = e.target.value;
                      })
                    }
                  />
                </div>
              )}
              {/* 学童に一日預ける手は、見てもらえる時間も直せる（入れ間違い・学童の時間が変わった時）。 */}
              {mode === 'ways' && way.kind === 'afterSchoolFullDay' && (
                <HoursEdit
                  ctx={ctx}
                  covers={way.covers}
                  onChange={(covers) =>
                    change((h) => {
                      const option = h.careOptions.find((o) => o.id === way.id);
                      if (option) option.covers = covers;
                    })
                  }
                />
              )}
              <Text quiet>{stepsText(ctx, way)}</Text>
              {costText(ctx, way) && <Text quiet>{costText(ctx, way)}</Text>}
            </div>
          ))}
          <Text quiet>{ctx.t('household.ways.used')}</Text>
          {mode === undefined && (
            <Row>
              <Button kind="secondary" onClick={() => edit('ways')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        {mode === undefined && <WaysCard ctx={ctx} />}

        {mode !== undefined && (
          <Card tone="accent">
            <Label tone="accent">{ctx.t('household.preview.label')}</Label>
            {refused && <Text>{ctx.t(`household.refused.${refusedKey(refused)}`)}</Text>}
            {shown && lines.length === 0 && <Text>{ctx.t('household.preview.none')}</Text>}
            {shown && lines.map((line) => <Text key={line}>{line}</Text>)}
            <Row>
              {shown ? (
                <Button onClick={() => void save()} disabled={busy}>
                  {ctx.t('household.save')}
                </Button>
              ) : (
                <Button
                  onClick={() => void look()}
                  disabled={
                    busy || !ctx.previewHousehold || (draft !== undefined && !hoursReady(draft))
                  }
                >
                  {ctx.t('household.look')}
                </Button>
              )}
              <Button kind="secondary" onClick={stop} disabled={busy}>
                {ctx.t('household.cancel')}
              </Button>
            </Row>
          </Card>
        )}
      </Main>
    </>
  );
}

/** サーバーが直しを断った理由の符号を、画面の言葉の鍵にする（知らない物は一つにまとめる）。 */
function refusedKey(reason: string): string {
  return [
    'householdInvalid',
    'routineGap',
    'routineDayMissing',
    'routinePlace',
    'routineExceptionMember',
    'hoursOvernight',
    'membersLocked',
    'placesLocked',
    'careOptionsLocked',
    'nameTaken',
    'unavailable',
  ].includes(reason)
    ? reason
    : 'other';
}
