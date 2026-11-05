// 初めの画面：何をするアプリか、試用であること、始め方（名前だけの家族か、見本の家族か）。用意した場面は、
// 審査で場面を見るための入口として小さく出す。名前だけの家族には、見本の家族の成員を混ぜない。
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TrialStartInput } from './family';
import { Button, ICON, Icon } from './ui';

/** 名前の長さの上限（サーバーと同じ）。 */
const NAME_MAX = 20;

export function StartScreen(props: {
  phase: 'checking' | 'none' | 'starting' | 'ready' | 'failed';
  /** 前の試用が、時間が経って消えていた。 */
  expired: boolean;
  onStart: (input: TrialStartInput) => void;
  /** 言葉の切り替え（初めの画面から選べるように）。 */
  language: ReactNode;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'welcome' | 'family'>('welcome');
  const busy = props.phase === 'starting' || props.phase === 'checking';
  const status = props.expired ? (
    <p role="status" className="rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-warn">
      {t('start.expired')}
    </p>
  ) : props.phase === 'failed' ? (
    <p role="alert" className="rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-warn">
      {t('start.failed')}
    </p>
  ) : null;
  if (step === 'family') {
    return (
      <FamilyStep
        busy={busy}
        status={status}
        onBack={() => setStep('welcome')}
        onStart={(adults, child) => props.onStart({ start: 'own', adults, child })}
      />
    );
  }
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 pt-8 pb-8">
      <div className="flex items-center justify-between gap-3">
        <span className="font-round text-xl font-bold">{t('app.name')}</span>
        {props.language}
      </div>
      <div className="flex flex-col gap-3">
        <h1 className="font-round text-[28px] leading-snug font-bold text-balance">
          {t('start.headline')}
        </h1>
        <p className="text-base leading-relaxed">{t('start.body')}</p>
      </div>
      <ol className="flex flex-col gap-2.5">
        {(['input', 'decide', 'follow'] as const).map((key, index) => (
          <li
            key={key}
            className="flex items-start gap-3 rounded-2xl border border-line bg-card px-4 py-3"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft font-bold text-accent">
              {index + 1}
            </span>
            <span className="flex flex-col">
              <span className="font-bold">{t(`start.steps.${key}`)}</span>
              <span className="text-[15px] text-sub">{t(`start.steps.${key}Sub`)}</span>
            </span>
          </li>
        ))}
      </ol>
      {status}
      <div className="mt-auto flex flex-col gap-3">
        <Button onClick={() => setStep('family')} disabled={busy}>
          {t('start.begin')}
        </Button>
        <Button kind="secondary" onClick={() => props.onStart({ start: 'sample' })} disabled={busy}>
          {t('start.sample')}
        </Button>
        <p className="text-center text-[13px] text-sub">{t('start.note')}</p>
        <button
          type="button"
          onClick={() => props.onStart({ stage: 'arrived' })}
          disabled={busy}
          className="min-h-10 self-center text-[15px] text-accent underline disabled:opacity-50"
        >
          {t('start.stages')}
        </button>
      </div>
    </main>
  );
}

/**
 * 家族の呼び名だけを聞く（あなた・もう一人の大人・子ども一人）。最初の版は子一人の学校・園のお知らせを扱うので、子は
 * 始める時に聞く（後から足す道は無い）。同じ呼び名は画面で見分けられないので、始めさせない。働き方や頼める人は、
 * 要る時に聞く。
 */
function FamilyStep(props: {
  busy: boolean;
  status: ReactNode;
  onBack: () => void;
  onStart: (adults: string[], child: string) => void;
}) {
  const { t } = useTranslation();
  const [adult, setAdult] = useState('');
  const [partner, setPartner] = useState('');
  const [child, setChild] = useState('');
  const me = adult.trim();
  const names = [me, partner.trim(), child.trim()].filter((n) => n.length > 0);
  const same = new Set(names).size !== names.length;
  return (
    <main className="flex flex-1 flex-col gap-5 px-5 pt-4 pb-8">
      <button
        type="button"
        onClick={props.onBack}
        className="-ml-1.5 inline-flex min-h-10 items-center gap-0.5 self-start font-bold text-accent"
      >
        <Icon path={ICON.back} size={22} />
        {t('start.family.back')}
      </button>
      <h1 className="font-round text-[26px] leading-snug font-bold text-balance">
        {t('start.family.title')}
      </h1>
      <NameField
        label={t('start.family.adult')}
        placeholder={t('start.family.adultPlaceholder')}
        value={adult}
        onChange={setAdult}
      />
      <NameField
        label={t('start.family.partner')}
        placeholder={t('start.family.partnerPlaceholder')}
        value={partner}
        onChange={setPartner}
      />
      <NameField
        label={t('start.family.child')}
        placeholder={t('start.family.childPlaceholder')}
        value={child}
        onChange={setChild}
      />
      <p className="text-[15px] leading-relaxed text-sub">{t('start.family.note')}</p>
      {same && (
        <p role="status" className="rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-warn">
          {t('start.family.sameName')}
        </p>
      )}
      {props.status}
      <div className="mt-auto">
        <Button
          onClick={() =>
            props.onStart([me, ...(partner.trim() ? [partner.trim()] : [])], child.trim())
          }
          disabled={props.busy || me.length === 0 || child.trim().length === 0 || same}
        >
          {t('start.family.next')}
        </Button>
      </div>
    </main>
  );
}

function NameField(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-bold">{props.label}</span>
      <input
        type="text"
        value={props.value}
        maxLength={NAME_MAX}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="min-h-12 rounded-xl border border-line bg-card px-3 text-lg"
      />
    </label>
  );
}
