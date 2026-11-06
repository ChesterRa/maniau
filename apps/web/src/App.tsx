// 画面の外枠：どちらの家庭か（デモ・家族）、知らせ、画面の切り替え、下のタブ。デモでは段・使う人・
// 言葉・やり直すを選べる。家族の家庭では、使う人はログインの身元で決まり、言葉だけを選ぶ。
// 計画と「きょう」の札はサーバーが作る。ここは受け取った見せる物を画面に渡し、命令を送るだけ。
import { formatDateTime, type Member, toEpochMinutes } from '@maniau/core';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DemoNotifications } from './demo-notify';
import { FactsScreen } from './facts';
import {
  type Notice,
  type Reading,
  type ServerView,
  type TrialKind,
  useFamilySession,
  useMode,
  useTrialSession,
} from './family';
import { formatDayTime } from './format';
import { HouseholdScreen } from './household';
import {
  isUiLanguage,
  rememberDeviceLanguage,
  rememberedLanguage,
  rememberLanguage,
  type UiLanguage,
} from './i18n';
import { MemberDayScreen } from './member-day';
import { NeedFixScreen, NeedScreen, StateNeedScreen } from './need';
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
import { StartScreen } from './start';
import { TabBar } from './ui';
import { ideaDraft, WayIdeasScreen } from './way-ideas';
import { WayScreen } from './ways';
import { WhatIfScreen } from './what-if';
import { WhenScreen } from './when';

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
        canRead={mode.canRead === true}
        canHear={mode.canHear === true}
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

/**
 * 使う人が選んだ言葉にする（人ごとに覚える）。デモ（keep）では、まだ言葉を選んでいない大人に替えても、今の言葉の
 * ままにし、その人の分としては覚えない。英語で見ている人が、案内どおりに大人や場面を替えても、日本語に戻さない。
 * 空から始めた試用（見本の家族・名前だけの家族）の人ごとの言葉は、その試用（scope）の中だけで覚える：別の試用は、
 * 同じ ID の大人でも別の家族なので、前の試用で選んだ言葉で、初めの画面で選んだ言葉を上書きしない。用意した場面は、
 * 場面を替えても同じ家族なので、今までどおり大人ごとに覚える（scope なし）。
 */
function useMemberLanguage(me: Member | undefined, keep = false, scope?: string) {
  const { i18n } = useTranslation();
  const key = me && (keep && scope !== undefined ? `${scope}.${me.id}` : me.id);
  useEffect(() => {
    if (!me || key === undefined) return;
    const own = isUiLanguage(me.uiLanguage) ? me.uiLanguage : 'ja';
    const current = isUiLanguage(i18n.language) ? i18n.language : 'ja';
    void i18n.changeLanguage(rememberedLanguage(key, keep ? current : own));
  }, [me, key, i18n, keep]);
  const lang: UiLanguage = isUiLanguage(i18n.language) ? i18n.language : 'ja';
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const chooseLanguage = (next: UiLanguage) => {
    if (key !== undefined) rememberLanguage(key, next);
    // デモでは、端末の言葉としても覚える（初めの画面で選んだ言葉を、開き直した後も使う）。
    if (keep) rememberDeviceLanguage(next);
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
  /** 画面で地図を描く鍵（地図のあるデモだけ）。 */
  mapsKey?: string;
  /** 駅の近くの店を探せるか（地図のあるデモだけ）。探す言葉の案を Claude に聞けるか。 */
  canSearchStores?: boolean;
  canSuggestStores?: boolean;
  hasRecordedSurvey?: boolean;
  canSurvey?: boolean;
  /** 家族の試しの家庭か（読む欄に「架空の文だけ」と、上限の戻る時刻を出す）。 */
  trial?: boolean;
  /** 空から始めた試用（架空の内容だけ）。 */
  fictional?: boolean;
  /** 名前だけの家族から始めた試用（見本の家族で見られる物を示す）。 */
  ownTrial?: boolean;
  lang: UiLanguage;
  route: Route;
  onRoute: (route: Route) => void;
  onRestart?: () => void;
  /** 空から始めた試用だけ：例のお知らせ（架空）と、それを足す口。 */
  example?: { title: string; add: () => Promise<boolean> };
  /** 名前だけの試用だけ：家の場所を入れる口。 */
  home?: Ctx['home'];
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
          ...(props.canRead ? { read: live.read, wayIdeas: live.wayIdeas } : {}),
          ...(props.canRead && props.canPhoto ? { transcribe: live.transcribe } : {}),
          ...(props.canHear ? { hear: live.hear, confirm: live.confirm } : {}),
          ...(props.mapsKey || props.canSearchStores
            ? {
                maps: {
                  ...(props.mapsKey ? { key: props.mapsKey } : {}),
                  walk: live.walk,
                  ...(props.canSearchStores ? { search: live.searchStores } : {}),
                  ...(props.canSuggestStores ? { kinds: live.storeKinds } : {}),
                },
              }
            : {}),
          ...(props.hasRecordedSurvey || props.canSurvey
            ? {
                survey: {
                  run: live.survey,
                  recorded: props.hasRecordedSurvey === true,
                  live: props.canSurvey === true,
                },
              }
            : {}),
          ...(props.trial ? { trialInput: true as const } : {}),
          ...(props.fictional ? { fictional: true as const } : {}),
          ...(props.ownTrial ? { ownTrial: true as const } : {}),
          ...(props.home ? { home: props.home } : {}),
          ...(props.example ? { example: props.example } : {}),
          preview: live.preview,
          previewHousehold: live.previewHousehold,
          previewChange: live.previewChange,
          refresh: live.refresh,
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
          active={
            route.name === 'week'
              ? 'week'
              : route.name === 'household' || route.name === 'way'
                ? 'household'
                : 'today'
          }
          labels={{
            today: t('nav.today'),
            snap: t('nav.snap'),
            week: t('nav.week'),
            household: t('nav.household'),
          }}
          onToday={() => go({ name: 'today' })}
          onSnap={() => go({ name: 'sources' })}
          onWeek={() => go({ name: 'week' })}
          onHousehold={() => go({ name: 'household' })}
        />
      )}
    </>
  );
}

/**
 * デモ：空から始める試用（名前だけの家族・見本の家族）と、用意した場面（審査で場面を見る）。初めの画面で始め方を
 * 選ぶ。同じ端末で開き直すと、同じデモに戻る。試用では、デモの操作（時計・使う人・言葉）を畳んでおく。
 */
function DemoApp() {
  const { t } = useTranslation();
  const [memberId, setMemberId] = useState<string>();
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const [controls, setControls] = useState(false);
  const demo = useTrialSession(memberId);
  const { session, view } = demo;

  // 始めた・開き直したデモで、画面を見る大人を開く（場面にはその場面の人。替えられる）。
  useEffect(() => {
    if (!session) {
      setMemberId(undefined);
      return;
    }
    const adults = session.household.members.filter((m) => m.kind === 'adult' && m.active);
    const viewer = session.stages.find((s) => s.id === session.stage)?.viewer;
    setMemberId(viewer && adults.some((m) => m.id === viewer) ? viewer : adults[0]?.id);
  }, [session]);

  const household = view?.household ?? session?.household;
  const adults = useMemo(
    () => household?.members.filter((m) => m.kind === 'adult' && m.active) ?? [],
    [household],
  );
  const me = adults.find((m) => m.id === memberId);
  const { lang, chooseLanguage } = useMemberLanguage(
    me,
    true,
    session?.trial ? session.sessionId : undefined,
  );
  const languages = (
    <Switcher
      label={t('language.label')}
      options={[
        { value: 'ja', label: '日本語' },
        { value: 'en', label: 'English' },
      ]}
      value={lang}
      onChange={(v) => isUiLanguage(v) && chooseLanguage(v)}
    />
  );
  const begin = (input: Parameters<typeof demo.start>[0]) => {
    setRoute({ name: 'today' });
    setControls(false);
    void demo.start(input);
  };
  const leave = () => {
    demo.leave();
    setRoute({ name: 'today' });
    setControls(false);
  };

  if (!session) {
    return (
      <div className={FRAME}>
        <StartScreen
          phase={demo.phase}
          expired={demo.expired}
          onStart={begin}
          language={languages}
        />
      </div>
    );
  }
  const stage = session.stage ?? FIRST_STAGE;
  const clock = view ? formatDayTime(view.now, lang, view.household.timeZone) : undefined;
  const onAdvance = view
    ? (minutes: number) => {
        // 時計を進めたら、押した後の一行（「送ったと記録しました」など）は消す（日が変わっても出たままにしない）。
        setRoute((current) =>
          current.name === 'today' && current.done !== undefined ? { name: 'today' } : current,
        );
        void demo.send({
          type: 'advanceClock',
          to: formatDateTime(toEpochMinutes(view.now) + minutes, view.household.timeZone),
        });
      }
    : undefined;
  const people = adults.map((m) => ({ value: m.id, label: m.name }));
  const onMember = (next: string) => {
    setMemberId(next);
    setRoute({ name: 'today' });
  };
  // 知らせの候補は「きょう」の画面だけに出す（試しの計算の画面で、今の計画の候補を並べない）。
  const notifications = view && route.name === 'today' && (
    <DemoNotifications preview={view.notificationPreview} household={view.household} lang={lang} />
  );
  return (
    <div className={FRAME}>
      {session.trial ? (
        <TrialBar
          kind={session.trial}
          clock={clock}
          open={controls}
          onToggle={() => setControls((open) => !open)}
        >
          <ClockButtons onAdvance={onAdvance} />
          {view && session.example && session.exampleChange && (
            <ExampleChange
              change={session.exampleChange}
              firstId={session.example.sourceId}
              sourceIds={view.sources.map((s) => s.id)}
              now={view.now}
              timeZone={view.household.timeZone}
              lang={lang}
              onAdd={() => demo.addExample('change')}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {people.length > 1 && (
              <Switcher
                label={t('adult.label')}
                options={people}
                value={memberId}
                onChange={onMember}
              />
            )}
            {languages}
          </div>
          <div className="flex flex-wrap gap-x-4">
            <button type="button" onClick={leave} className="min-h-9 text-accent underline">
              {t('trial.leave')}
            </button>
            <button
              type="button"
              onClick={() => begin({ stage: FIRST_STAGE })}
              className="min-h-9 text-accent underline"
            >
              {t('trial.scenes')}
            </button>
          </div>
          {notifications}
        </TrialBar>
      ) : (
        <DemoBar
          stages={session.stages.map((s) => s.id)}
          stage={stage}
          onStage={(next) => begin({ stage: next })}
          adults={people}
          member={memberId}
          onMember={onMember}
          lang={lang}
          onLang={chooseLanguage}
          clock={clock}
          onAdvance={onAdvance}
          onRestart={() => begin({ stage })}
          onLeave={leave}
          notifications={notifications}
        />
      )}
      <Body
        live={demo}
        me={me}
        readings={session.readings}
        canRead={session.canRead === true}
        canHear={session.canHear === true}
        canPhoto={session.canPhoto === true}
        {...(session.mapsKey ? { mapsKey: session.mapsKey } : {})}
        canSearchStores={session.canSearchStores === true}
        canSuggestStores={session.canSuggestStores === true}
        hasRecordedSurvey={session.hasRecordedSurvey === true}
        canSurvey={session.canSurvey === true}
        lang={lang}
        route={route}
        onRoute={setRoute}
        onRestart={session.trial ? leave : () => begin({ stage })}
        fictional={session.trial !== undefined}
        ownTrial={session.trial === 'own'}
        {...(session.trial && session.example
          ? { example: { title: session.example.title, add: demo.addExample } }
          : {})}
        {...(session.trial === 'own'
          ? {
              home: {
                set: demo.setHome,
                confirm: demo.confirmHome,
                maps: session.canSearchStores === true,
              },
            }
          : {})}
      />
    </div>
  );
}

/** 試用の帯：試用であること、どの家族か、デモの時計。デモの操作は「操作」を押した時だけ出す。 */
function TrialBar(props: {
  kind: TrialKind;
  clock: string | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 rounded-2xl border-[1.5px] border-dashed border-warn/60 bg-card px-3 py-1.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded bg-warn-soft px-1.5 font-bold text-warn">
            {t('trial.badge')}
          </span>
          {/* 日時は試用の時計（今の本当の日時ではない）。狭い画面でも切らずに、名前の下の行に出す。 */}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{t(`trial.${props.kind}`)}</span>
            {props.clock && (
              <span className="text-sub">{t('trial.clockAt', { time: props.clock })}</span>
            )}
          </span>
        </span>
        <button
          type="button"
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="min-h-9 shrink-0 text-accent underline"
        >
          {t(props.open ? 'trial.close' : 'trial.controls')}
        </button>
      </div>
      {props.open && (
        <div className="flex flex-col gap-2 border-t border-line pt-2">{props.children}</div>
      )}
    </div>
  );
}

/** デモの時計を進める（分）。戻せない。決め時の前後で札と知らせがどう変わるかを見るため。 */
/**
 * 例のお知らせの続き（架空の延期の連絡）を足す所（試用の操作の中）。一通目の例を入れた試用だけに出し、足した後は
 * 出さない。試用の時計が届いた時より前は、いつから足せるかだけを書く（時計は動かさない。上の「+1日」で進める）。
 * 録った読み取りで足し、Claude には送らない。
 */
function ExampleChange(props: {
  change: { sourceId: string; title: string; at: string };
  firstId: string;
  sourceIds: string[];
  now: string;
  timeZone: string;
  lang: UiLanguage;
  onAdd: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);
  const { change } = props;
  if (!props.sourceIds.includes(props.firstId) || props.sourceIds.includes(change.sourceId)) {
    return null;
  }
  if (toEpochMinutes(props.now) < toEpochMinutes(change.at)) {
    return (
      <p className="text-sub">
        {t('trial.change.later', {
          title: change.title,
          when: formatDayTime(change.at, props.lang, props.timeZone),
        })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={adding}
        onClick={() => {
          setAdding(true);
          setFailed(false);
          void props.onAdd().then((ok) => {
            setAdding(false);
            if (!ok) setFailed(true);
          });
        }}
        className="min-h-11 self-start rounded-xl border-[1.5px] border-btn-line bg-white px-3 text-left font-bold text-accent"
      >
        {t('trial.change.add', { title: change.title })}
      </button>
      <span className="text-sub">{t(failed ? 'trial.change.failed' : 'trial.change.note')}</span>
    </div>
  );
}

function ClockButtons({ onAdvance }: { onAdvance: ((minutes: number) => void) | undefined }) {
  const { t } = useTranslation();
  if (!onAdvance) return null;
  return (
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
          onClick={() => onAdvance(minutes)}
          className="min-h-9 rounded-lg border border-line bg-card px-3 font-bold"
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

/** 家族の家庭：ログインした大人の画面。使う人は替えず、言葉だけを選ぶ。 */
function FamilyApp({
  memberId,
  pushKey,
  canRead,
  canHear,
  onSwitched,
}: {
  memberId: string;
  pushKey?: string;
  /** お知らせ・一言を Claude で読めるか（試しの家庭で、読み取りの鍵があるサーバーだけ）。 */
  canRead: boolean;
  canHear: boolean;
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
      <Body
        live={live}
        me={me}
        readings={[]}
        canRead={canRead}
        canHear={canHear}
        trial={canRead || canHear}
        lang={lang}
        route={route}
        onRoute={setRoute}
      />
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
      return <TodayScreen ctx={ctx} {...(route.done ? { done: route.done } : {})} />;
    case 'decide':
      return <DecideScreen ctx={ctx} arrangementKey={route.key} />;
    case 'facts':
      return <FactsScreen ctx={ctx} requirementKey={route.key} />;
    case 'need':
      return <NeedScreen ctx={ctx} arrangementKey={route.key} />;
    case 'when':
      return <WhenScreen ctx={ctx} requirementKey={route.key} />;
    case 'stateNeed':
      return <StateNeedScreen ctx={ctx} />;
    case 'needFix':
      return <NeedFixScreen ctx={ctx} itemId={route.itemId} />;
    case 'ask':
      return <AskScreen ctx={ctx} taskKey={route.taskKey} />;
    case 'week':
      return <WeekScreen ctx={ctx} />;
    case 'household':
      return <HouseholdScreen ctx={ctx} />;
    case 'way': {
      const idea =
        route.idea !== undefined && route.from && !route.wayId
          ? ideaDraft(ctx, route.from, route.idea)
          : undefined;
      const copy = route.copy;
      return (
        <WayScreen
          key={`${route.wayId ?? ''}|${route.from ?? ''}|${route.idea ?? ''}|${copy ? `${copy.wayId}|${copy.resourceId}|${copy.insteadOf}` : ''}`}
          ctx={ctx}
          {...(route.wayId ? { wayId: route.wayId } : {})}
          {...(route.from ? { from: route.from } : {})}
          {...(idea ? { idea } : {})}
          {...(copy && !route.wayId ? { copy } : {})}
        />
      );
    }
    case 'wayIdeas':
      return <WayIdeasScreen ctx={ctx} arrangementKey={route.key} />;
    case 'whatIf':
      return <WhatIfScreen ctx={ctx} requestId={route.requestId} />;
    case 'memberDay':
      return <MemberDayScreen key={JSON.stringify(route)} ctx={ctx} route={route} />;
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
  /** 初めの画面へ戻る（この場面を閉じる）。 */
  onLeave?: () => void;
  /** この時刻の知らせの候補（demo-notify.tsx。無ければ何も出さない）。 */
  notifications?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 rounded-2xl border-[1.5px] border-dashed border-warn/60 bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-warn">
          {props.clock ? t('demo.clock', { time: props.clock }) : t('demo.label')}
        </span>
        <span className="flex gap-x-3">
          <button type="button" onClick={props.onRestart} className="min-h-9 text-accent underline">
            {t('demo.restart')}
          </button>
          {props.onLeave && (
            <button type="button" onClick={props.onLeave} className="min-h-9 text-accent underline">
              {t('demo.leave')}
            </button>
          )}
        </span>
      </div>
      <ClockButtons onAdvance={props.onAdvance} />
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
      {/* 場面ごとの見どころ（初めて見る人が、どこを見ればよいか分かるように）。用意した状態の説明で、操作や
          時計を進めると変わるので、「場面のはじめ」と示す。 */}
      {props.stages.includes(props.stage) && (
        <p className="leading-snug text-sub">
          <span className="me-1.5 rounded bg-warn-soft px-1 font-bold text-warn">
            {t('demo.guideLead')}
          </span>
          {t(`demo.guide.${props.stage}`)}
        </p>
      )}
      {props.notifications}
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
