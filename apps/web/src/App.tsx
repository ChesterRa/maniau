// 画面の外枠：どちらの家庭か（デモ・家族）、知らせ、画面の切り替え、下のタブ。デモでは段・使う人・
// 言葉・やり直すを選べる。家族の家庭では、使う人はログインの身元で決まり、言葉だけを選ぶ。
// 計画と「きょう」の札はサーバーが作る。ここは受け取った見せる物を画面に渡し、命令を送るだけ。
import { formatDateTime, type Member, toEpochMinutes } from '@maniau/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Notice,
  type Reading,
  type ServerView,
  useDemoSession,
  useFamilySession,
  useMode,
} from './family';
import { formatDayTime } from './format';
import { isUiLanguage, rememberedLanguage, rememberLanguage, type UiLanguage } from './i18n';
import { usePush } from './push';
import {
  AskScreen,
  type Ctx,
  DecideScreen,
  type Route,
  SourcesScreen,
  TodayScreen,
  WeekScreen,
} from './screens';
import { TabBar } from './ui';

const FIRST_STAGE = 'arrived';
const FRAME = 'mx-auto flex min-h-dvh max-w-md flex-col';

export function App() {
  const { t } = useTranslation();
  const { mode, recheck } = useMode();
  if (mode.kind === 'demo') return <DemoApp />;
  // 身元が替わったら確かめ直す。確かめる間は読み込み中で、前の人の画面は捨てる（作り直す）。
  if (mode.kind === 'family') {
    return (
      <FamilyApp
        key={mode.memberId}
        memberId={mode.memberId}
        {...(mode.pushKey ? { pushKey: mode.pushKey } : {})}
        onSwitched={recheck}
      />
    );
  }
  const key =
    mode.kind === 'loading' ? 'loading' : mode.kind === 'denied' ? 'error.denied' : 'error.load';
  return (
    <div className={FRAME}>
      <p className={`px-5 py-4 ${mode.kind === 'loading' ? 'text-sub' : 'text-warn'}`}>{t(key)}</p>
    </div>
  );
}

/** 使う人が選んだ言葉にする（人ごとに覚える）。 */
function useMemberLanguage(me: Member | undefined) {
  const { i18n } = useTranslation();
  useEffect(() => {
    if (!me) return;
    const fallback = isUiLanguage(me.uiLanguage) ? me.uiLanguage : 'ja';
    void i18n.changeLanguage(rememberedLanguage(me.id, fallback));
  }, [me, i18n]);
  const lang: UiLanguage = isUiLanguage(i18n.language) ? i18n.language : 'ja';
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const chooseLanguage = (next: UiLanguage) => {
    if (me) rememberLanguage(me.id, next);
    void i18n.changeLanguage(next);
  };
  return { lang, chooseLanguage };
}

/** 画面の本体（家庭の種類によらない）：知らせ、読み込みの状態、画面、下のタブ。 */
/**
 * 前から有る読み取り（録った・手で書いた）に、家族が入れて、いま読んだ物を足す。確かめてほしい文は、
 * どれもサーバーの見せる物から取る。
 */
function withLive(
  known: Reading[],
  fromView: { sourceId: string; model: string; check: string[]; checkAll: boolean }[],
): Reading[] {
  const checkOf = (sourceId: string) => {
    const read = fromView.find((r) => r.sourceId === sourceId);
    return read ? { check: read.check, checkAll: read.checkAll } : {};
  };
  const live = fromView
    .filter((r) => !known.some((k) => k.sourceId === r.sourceId))
    .map((r) => ({ sourceId: r.sourceId, origin: 'live' as const, model: r.model }));
  return [...known, ...live].map((r) => ({ ...r, ...checkOf(r.sourceId) }));
}

function Body(props: {
  live: ServerView;
  me: Member | undefined;
  readings: Reading[];
  /** お知らせの文を入れて読めるか（デモで、読み取りの鍵があるサーバーだけ）。 */
  canRead?: boolean;
  canHear?: boolean;
  /** お知らせの写真・PDF を書き起こせるか（同じく）。 */
  canPhoto?: boolean;
  lang: UiLanguage;
  route: Route;
  onRoute: (route: Route) => void;
  onRestart?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { live, me, lang, route } = props;
  const { view } = live;
  const go = (next: Route) => {
    live.clearNotice();
    props.onRoute(next);
    window.scrollTo({ top: 0 });
  };
  const ctx: Ctx | undefined =
    view && me
      ? {
          plan: view.plan,
          household: view.household,
          today: view.today,
          ...(view.changes ? { changes: view.changes } : {}),
          items: view.items,
          sources: new Map(view.sources.map((s) => [s.id, s])),
          readings: withLive(props.readings, view.readings ?? []),
          ...(props.canRead ? { read: live.read } : {}),
          ...(props.canRead && props.canPhoto ? { transcribe: live.transcribe } : {}),
          ...(props.canHear ? { hear: live.hear, confirm: live.confirm } : {}),
          me,
          lang,
          tz: view.household.timeZone,
          now: view.now,
          t,
          outbound: (lng) => i18n.getFixedT(lng),
          send: live.send,
          go,
        }
      : undefined;
  return (
    <>
      {live.notice && (
        <NoticeBanner
          notice={live.notice}
          onClose={live.notice === 'uncertain' ? live.discard : live.clearNotice}
          {...(props.onRestart ? { onRestart: props.onRestart } : {})}
          onRetry={() => void live.retry()}
        />
      )}
      {live.denied && <p className="px-5 py-4 text-warn">{t('error.denied')}</p>}
      {live.failed && <p className="px-5 py-4 text-warn">{t('error.load')}</p>}
      {!live.failed && !live.denied && !ctx && <p className="px-5 py-4 text-sub">{t('loading')}</p>}
      {ctx && <Screen ctx={ctx} route={route} />}
      {ctx && (
        <TabBar
          active={route.name === 'week' ? 'week' : 'today'}
          labels={{ today: t('nav.today'), snap: t('nav.snap'), week: t('nav.week') }}
          onToday={() => go({ name: 'today' })}
          onSnap={() => go({ name: 'sources' })}
          onWeek={() => go({ name: 'week' })}
        />
      )}
    </>
  );
}

/** デモ：見る人ごとのデモの家庭（架空の家族）。段・使う人・言葉を選び、やり直せる。 */
function DemoApp() {
  const [stage, setStage] = useState(FIRST_STAGE);
  const [memberId, setMemberId] = useState<string>();
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const demo = useDemoSession(stage, memberId);
  const { session, view } = demo;

  // 段が替わったら、その段で画面を見ている大人を開く（替えられる）。
  useEffect(() => {
    if (!session) return;
    const viewer = session.stages.find((s) => s.id === stage)?.viewer;
    const adults = session.household.members.filter((m) => m.kind === 'adult' && m.active);
    setMemberId((current) =>
      viewer && adults.some((m) => m.id === viewer) ? viewer : (current ?? adults[0]?.id),
    );
  }, [session, stage]);

  const household = view?.household ?? session?.household;
  const adults = useMemo(
    () => household?.members.filter((m) => m.kind === 'adult' && m.active) ?? [],
    [household],
  );
  const me = adults.find((m) => m.id === memberId);
  const { lang, chooseLanguage } = useMemberLanguage(me);
  const restart = () => {
    demo.restart();
    setRoute({ name: 'today' });
  };

  return (
    <div className={FRAME}>
      <DemoBar
        stages={session?.stages.map((s) => s.id) ?? [FIRST_STAGE]}
        stage={stage}
        onStage={(next) => {
          setStage(next);
          setRoute({ name: 'today' });
        }}
        adults={adults.map((m) => ({ value: m.id, label: m.name }))}
        member={memberId}
        onMember={(next) => {
          setMemberId(next);
          setRoute({ name: 'today' });
        }}
        lang={lang}
        onLang={chooseLanguage}
        clock={view ? formatDayTime(view.now, lang, view.household.timeZone) : undefined}
        onAdvance={
          view
            ? (minutes) =>
                void demo.send({
                  type: 'advanceClock',
                  to: formatDateTime(toEpochMinutes(view.now) + minutes, view.household.timeZone),
                })
            : undefined
        }
        onRestart={restart}
      />
      <Body
        live={demo}
        me={me}
        readings={session?.readings ?? []}
        canRead={session?.canRead === true}
        canHear={session?.canHear === true}
        canPhoto={session?.canPhoto === true}
        lang={lang}
        route={route}
        onRoute={setRoute}
        onRestart={restart}
      />
    </div>
  );
}

/** 家族の家庭：ログインした大人の画面。使う人は替えず、言葉だけを選ぶ。 */
function FamilyApp({
  memberId,
  pushKey,
  onSwitched,
}: {
  memberId: string;
  pushKey?: string;
  onSwitched: () => void;
}) {
  const { t } = useTranslation();
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const live = useFamilySession(memberId);
  useEffect(() => {
    if (live.switched) onSwitched();
  }, [live.switched, onSwitched]);
  const me = live.view?.household.members.find(
    (m) => m.id === memberId && m.kind === 'adult' && m.active,
  );
  const { lang, chooseLanguage } = useMemberLanguage(me);
  return (
    <div className={FRAME}>
      <div className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-sm">
        <span className="font-bold">{me?.name ?? ''}</span>
        <PushControl memberId={memberId} pushKey={pushKey} lang={lang} onSwitched={onSwitched} />
        <Switcher
          label={t('language.label')}
          options={[
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
          ]}
          value={lang}
          onChange={(v) => isUiLanguage(v) && chooseLanguage(v)}
        />
      </div>
      <Body live={live} me={me} readings={[]} lang={lang} route={route} onRoute={setRoute} />
    </div>
  );
}

/** この端末で知らせを受け取るか（家族の家庭だけ。デモには知らせが無い）。 */
function PushControl({
  memberId,
  pushKey,
  lang,
  onSwitched,
}: {
  memberId: string;
  pushKey: string | undefined;
  lang: UiLanguage;
  onSwitched: () => void;
}) {
  const { t } = useTranslation();
  const push = usePush(memberId, pushKey, lang, { onSwitched });
  const button = 'rounded-full border border-btn-line bg-card px-3 py-1 text-xs';
  switch (push.state) {
    case 'off':
      return (
        <button type="button" className={button} onClick={push.enable}>
          {t('push.enable')}
        </button>
      );
    case 'on':
      return (
        <button type="button" className={button} onClick={push.disable}>
          {t('push.on')}
        </button>
      );
    case 'failed':
      return (
        <button type="button" className={button} onClick={push.enable}>
          {t('push.failed')}
        </button>
      );
    case 'working':
      return <span className="text-xs text-sub">{t('push.working')}</span>;
    case 'needsInstall':
      return <span className="text-xs text-sub">{t('push.install')}</span>;
    case 'denied':
      return <span className="text-xs text-sub">{t('push.denied')}</span>;
    default:
      return null;
  }
}

function Screen({ ctx, route }: { ctx: Ctx; route: Route }) {
  switch (route.name) {
    case 'today':
      return <TodayScreen ctx={ctx} />;
    case 'decide':
      return <DecideScreen ctx={ctx} arrangementKey={route.key} />;
    case 'ask':
      return <AskScreen ctx={ctx} taskKey={route.taskKey} />;
    case 'week':
      return <WeekScreen ctx={ctx} />;
    case 'sources':
      return (
        <SourcesScreen
          ctx={ctx}
          {...(route.sourceId ? { sourceId: route.sourceId } : {})}
          {...(route.highlight ? { highlight: route.highlight } : {})}
        />
      );
  }
}

/** 断られた・古かった・送れなかった時の知らせ。内容が変わった時は、新しい内容で見せ直してある。 */
function NoticeBanner(props: {
  notice: Notice;
  onClose: () => void;
  /** デモだけ（古くなったデモの家庭を作り直す）。 */
  onRestart?: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const action = 'min-h-11 font-bold text-accent';
  return (
    <div
      role="status"
      className="mx-4 mt-2 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-2xl border border-bag-line bg-bag px-4 py-3"
    >
      <p className="min-w-0 flex-1 basis-60 text-base">{t(`notice.${props.notice}`)}</p>
      {props.notice === 'expired' && props.onRestart ? (
        <button type="button" onClick={props.onRestart} className={action}>
          {t('demo.restart')}
        </button>
      ) : (
        <span className="flex gap-3">
          {props.notice === 'uncertain' && (
            <button type="button" onClick={props.onRetry} className={action}>
              {t('notice.retry')}
            </button>
          )}
          <button type="button" onClick={props.onClose} className={action}>
            {t('notice.close')}
          </button>
        </span>
      )}
    </div>
  );
}

/** デモの操作。実在の家族の画面には出さない。 */
export function DemoBar(props: {
  stages: string[];
  stage: string;
  onStage: (stage: string) => void;
  adults: { value: string; label: string }[];
  member: string | undefined;
  onMember: (id: string) => void;
  lang: UiLanguage;
  onLang: (lang: UiLanguage) => void;
  clock: string | undefined;
  /** デモの時計を進める（分）。戻せない。決め時の前後で札と知らせがどう変わるかを見るため。 */
  onAdvance: ((minutes: number) => void) | undefined;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 rounded-2xl border-[1.5px] border-dashed border-warn/60 bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-warn">
          {props.clock ? t('demo.clock', { time: props.clock }) : t('demo.label')}
        </span>
        <button type="button" onClick={props.onRestart} className="min-h-9 text-accent underline">
          {t('demo.restart')}
        </button>
      </div>
      {props.onAdvance && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sub">{t('demo.advance')}</span>
          {(
            [
              [60, 'demo.plusHour'],
              [24 * 60, 'demo.plusDay'],
            ] as const
          ).map(([minutes, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => props.onAdvance?.(minutes)}
              className="min-h-9 rounded-lg border border-line bg-card px-3 font-bold"
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* 狭い画面でも、場面の長い名前で枠の外へはみ出さない（選ぶ物は端末のまま）。 */}
        <label className="flex min-w-0 max-w-full items-center gap-1">
          <span className="shrink-0 text-sub">{t('demo.stage')}</span>
          <select
            value={props.stage}
            onChange={(e) => props.onStage(e.target.value)}
            className="min-h-9 min-w-0 max-w-full flex-1 truncate rounded-lg border border-line bg-card px-2"
          >
            {props.stages.map((id) => (
              <option key={id} value={id}>
                {t(`demo.stages.${id}`)}
              </option>
            ))}
          </select>
        </label>
        <Switcher
          label={t('adult.label')}
          options={props.adults}
          value={props.member}
          onChange={props.onMember}
        />
        <Switcher
          label={t('language.label')}
          options={[
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
          ]}
          value={props.lang}
          onChange={(v) => isUiLanguage(v) && props.onLang(v)}
        />
      </div>
    </div>
  );
}

function Switcher(props: {
  label: string;
  options: { value: string; label: string }[];
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{props.label}</legend>
      <span className="text-sub">{props.label}</span>
      <div className="flex rounded-full border border-line bg-card p-0.5">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
            className={`min-h-9 rounded-full px-3 ${o.value === props.value ? 'bg-ink text-white' : 'text-ink'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
