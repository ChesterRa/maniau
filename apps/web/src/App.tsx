// 首の画面「今週」の骨組み。計画の計算（エンジン）は次の段で入れる。
import type { Household, Member } from '@maniau/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUiLanguage, rememberedLanguage, rememberLanguage, type UiLanguage } from './i18n';

// デモの時計の初期値：お知らせが届いた夜（docs/plan/02-product.md §8）。
const DEMO_NOW = '2026-11-25T19:30+09:00';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; household: Household };

export function App() {
  const { t, i18n } = useTranslation();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [memberId, setMemberId] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo/household')
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<Household>;
      })
      .then((household) => {
        if (!cancelled) setLoad({ state: 'ready', household });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const household = load.state === 'ready' ? load.household : undefined;
  const adults = useMemo(
    () => household?.members.filter((m) => m.kind === 'adult') ?? [],
    [household],
  );
  const current = adults.find((m) => m.id === memberId) ?? adults[0];

  // 使う人を替えたら、その人が選んだ言葉にする。
  useEffect(() => {
    if (!current) return;
    const fallback = isUiLanguage(current.uiLanguage) ? current.uiLanguage : 'ja';
    void i18n.changeLanguage(rememberedLanguage(current.id, fallback));
  }, [current, i18n]);

  const language: UiLanguage = isUiLanguage(i18n.language) ? i18n.language : 'ja';
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const chooseLanguage = (next: UiLanguage) => {
    if (current) rememberLanguage(current.id, next);
    void i18n.changeLanguage(next);
  };

  const clock = useMemo(() => {
    const format = new Intl.DateTimeFormat(language, {
      timeZone: household?.timeZone ?? 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return format.format(new Date(DEMO_NOW));
  }, [language, household?.timeZone]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="flex flex-col gap-3 px-4 pt-5 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">{t('app.name')}</h1>
            <p className="text-xs text-muted">{t('app.tagline')}</p>
          </div>
          <span className="rounded-full border-[1.5px] border-dashed border-urgent bg-white px-2.5 py-1 text-xs whitespace-nowrap text-urgent">
            {t('clock.demo', { time: clock })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Switcher
            label={t('adult.label')}
            options={adults.map((m) => ({ value: m.id, label: m.name }))}
            value={current?.id}
            onChange={setMemberId}
          />
          <Switcher
            label={t('language.label')}
            options={[
              { value: 'ja', label: t('language.ja') },
              { value: 'en', label: t('language.en') },
            ]}
            value={language}
            onChange={(v) => isUiLanguage(v) && chooseLanguage(v)}
          />
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-4 pb-4">
        {load.state === 'loading' && <p className="text-sm text-muted">{t('loading')}</p>}
        {load.state === 'error' && <p className="text-sm text-urgent">{t('error.load')}</p>}
        {household && (
          <>
            <section className="rounded-xl bg-urgent-soft p-4">
              <h2 className="text-xs font-bold text-urgent">{t('week.nextDecision')}</h2>
              <p className="mt-1 text-sm">{t('week.empty')}</p>
            </section>
            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-xs font-bold text-muted">{t('family.title')}</h2>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {household.members.map((m) => (
                  <MemberRow key={m.id} member={m} kindLabel={t(`family.kind.${m.kind}`)} />
                ))}
              </ul>
            </section>
          </>
        )}
      </main>

      <nav
        aria-label={t('nav.week')}
        className="sticky bottom-0 flex justify-around border-t border-line bg-white px-1 pt-1.5 pb-[max(env(safe-area-inset-bottom),1rem)]"
      >
        {(['week', 'overview', 'add', 'family'] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-current={key === 'week' ? 'page' : undefined}
            className={`min-h-11 min-w-16 text-xs ${key === 'week' ? 'font-bold text-accent' : 'text-muted'}`}
          >
            {t(`nav.${key}`)}
          </button>
        ))}
      </nav>
    </div>
  );
}

function MemberRow({ member, kindLabel }: { member: Member; kindLabel: string }) {
  return (
    <li className="flex justify-between">
      <span>{member.name}</span>
      <span className="text-muted">
        {kindLabel}
        {member.grade ? `・${member.grade}` : ''}
      </span>
    </li>
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
      <span className="text-xs text-muted">{props.label}</span>
      <div className="flex rounded-full border border-line bg-white p-0.5">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
            className={`min-h-9 rounded-full px-3 text-xs ${o.value === props.value ? 'bg-ink text-white' : 'text-ink'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
