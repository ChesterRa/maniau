// 画面の外枠：デモの操作（段・使う人・言葉・やり直す）、知らせ、画面の切り替え、下のタブ。
// 計画と「きょう」の札はサーバーが作る。ここは受け取った見せる物を画面に渡し、命令を送るだけ。
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Notice, useDemoSession } from './family';
import { formatDayTime } from './format';
import { isUiLanguage, rememberedLanguage, rememberLanguage, type UiLanguage } from './i18n';
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

export function App() {
  const { t, i18n } = useTranslation();
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

  // 使う人を替えたら、その人が選んだ言葉にする。
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
  const go = (next: Route) => {
    demo.clearNotice();
    setRoute(next);
    window.scrollTo({ top: 0 });
  };
  const switchStage = (next: string) => {
    setStage(next);
    setRoute({ name: 'today' });
  };
  const switchMember = (next: string) => {
    setMemberId(next);
    setRoute({ name: 'today' });
  };

  const ctx: Ctx | undefined =
    view && me && session
      ? {
          plan: view.plan,
          household: view.household,
          today: view.today,
          items: view.items,
          sources: new Map(view.sources.map((s) => [s.id, s])),
          readings: session.readings,
          me,
          lang,
          tz: view.household.timeZone,
          now: view.now,
          t,
          outbound: (lng) => i18n.getFixedT(lng),
          send: demo.send,
          go,
        }
      : undefined;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <DemoBar
        stages={session?.stages.map((s) => s.id) ?? [FIRST_STAGE]}
        stage={stage}
        onStage={switchStage}
        adults={adults.map((m) => ({ value: m.id, label: m.name }))}
        member={memberId}
        onMember={switchMember}
        lang={lang}
        onLang={chooseLanguage}
        clock={view ? formatDayTime(view.now, lang, view.household.timeZone) : undefined}
        onRestart={() => {
          demo.restart();
          setRoute({ name: 'today' });
        }}
      />
      {demo.notice && (
        <NoticeBanner
          notice={demo.notice}
          onClose={demo.notice === 'uncertain' ? demo.discard : demo.clearNotice}
          onRestart={demo.restart}
          onRetry={() => void demo.retry()}
        />
      )}
      {demo.failed && <p className="px-5 py-4 text-warn">{t('error.load')}</p>}
      {!demo.failed && !ctx && <p className="px-5 py-4 text-sub">{t('loading')}</p>}
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
    </div>
  );
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
  onRestart: () => void;
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
      {props.notice === 'expired' ? (
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
function DemoBar(props: {
  stages: string[];
  stage: string;
  onStage: (stage: string) => void;
  adults: { value: string; label: string }[];
  member: string | undefined;
  onMember: (id: string) => void;
  lang: UiLanguage;
  onLang: (lang: UiLanguage) => void;
  clock: string | undefined;
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
