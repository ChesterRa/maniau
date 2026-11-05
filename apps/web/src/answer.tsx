// 答えるリンクの頁（家の外の人：祖母・近所の人・コーチ）。リンクの断片の鍵を、そのタブだけの sessionStorage に移して
// 断片を消し、その鍵（Authorization: Bearer）で候補に答える。見せるのは、その人が答えるのに要る物だけ（サーバーが
// 削った物）。家族の計画・ほかの人の名前と答えは、ここに来ない。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDay } from './format';
import i18n, { isUiLanguage, type UiLanguage } from './i18n';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text, Title } from './ui';

const STORE = 'maniau.answerToken';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FRAME = 'mx-auto flex min-h-dvh max-w-md flex-col';
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

interface AnswerView {
  what: string;
  place?: string;
  name: string;
  language?: UiLanguage;
  candidates: {
    id: string;
    rev: number;
    date: string;
    startTime: string;
    endTime: string;
    answer?: 'yes' | 'maybe' | 'no';
    note?: string;
    seenSeq: number;
  }[];
}
type Answer = 'yes' | 'maybe' | 'no' | 'withdrawn';
type State =
  | { kind: 'loading' }
  | { kind: 'noToken' | 'invalid' | 'tooMany' | 'failed' }
  | { kind: 'ok'; view: AnswerView };

/**
 * 断片から鍵を取る：鍵の形なら、このタブの sessionStorage に移して断片を消す（履歴と共有に鍵を残さない）。断片が
 * 無ければ、このタブに置いた鍵。鍵の形でない断片は、置いた鍵も捨てる（前の人の鍵で答え続けない）。
 */
function takeToken(): string | undefined {
  const fragment = window.location.hash.slice(1);
  if (fragment !== '') window.history.replaceState(null, '', window.location.pathname);
  try {
    if (TOKEN.test(fragment)) sessionStorage.setItem(STORE, fragment);
    else if (fragment !== '') sessionStorage.removeItem(STORE);
  } catch {
    // 置けなくても、この読み込みの間は使う。
  }
  if (TOKEN.test(fragment)) return fragment;
  if (fragment !== '') return undefined;
  try {
    const kept = sessionStorage.getItem(STORE);
    return kept && TOKEN.test(kept) ? kept : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 頁の外枠：同じタブで別のリンクを開くと、断片だけが替わる（読み込み直さない）。断片が替わるたびに鍵を取り直し、
 * 頁を作り直す（前の人の画面・入力・送りかけを残さない。遅れて届いた前の人の返事は、作り直した頁に当てない）。
 */
export function AnswerRoot() {
  const [slot, setSlot] = useState(() => ({ token: takeToken(), generation: 0 }));
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.slice(1) === '') return;
      setSlot((current) => ({ token: takeToken(), generation: current.generation + 1 }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <AnswerPage key={slot.generation} token={slot.token} />;
}

export function AnswerPage({ token }: { token: string | undefined }) {
  // 言葉を替えるのは、ただ一つの i18n（フックの返す物に依ると、言葉を替えるたびに読み直しが回る）。
  const { t, i18n: active } = useTranslation();
  const [state, setState] = useState<State>(token ? { kind: 'loading' } : { kind: 'noToken' });
  // 作り直した後（別のリンクを開いた後）に届いた、この頁の返事は使わない。
  const mounted = useRef(true);
  useEffect(() => {
    // 開発の StrictMode は、作って・捨てて・また作る。作るたびに戻す。
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // 届いたか分からない送り（同じ中身の送り直しは、同じ操作 ID で同じ操作として確かめる）。
  const pending = useRef<{ body: string; operationId: string } | undefined>(undefined);
  const chosenLanguage = useRef(false);
  const lang: UiLanguage = isUiLanguage(active.language) ? active.language : 'ja';

  useEffect(() => {
    // リンクの鍵を、ほかのサイトへの Referer に出さない（断片は送られないが、念のため）。
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  // 端末の言葉で始める。家族が決めた、その人に出す言葉が届けば、それに替える（本人が選べば、それを守る）。
  useEffect(() => {
    void i18n.changeLanguage(navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en');
  }, []);

  const show = useCallback((view: AnswerView) => {
    if (!mounted.current) return;
    if (!chosenLanguage.current && view.language) {
      chosenLanguage.current = true;
      void i18n.changeLanguage(view.language);
    }
    setState({ kind: 'ok', view });
  }, []);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/answer', {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!live) return;
        if (response.status === 401) return setState({ kind: 'invalid' });
        if (response.status === 429) return setState({ kind: 'tooMany' });
        if (!response.ok) return setState({ kind: 'failed' });
        show(((await response.json()) as { view: AnswerView }).view);
      } catch {
        if (live) setState({ kind: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [token, show]);

  const send = async (candidate: AnswerView['candidates'][number], answer: Answer) => {
    if (!token || busy) return;
    const note = answer === 'maybe' ? (notes[candidate.id] ?? candidate.note ?? '').trim() : '';
    const fields = {
      candidateId: candidate.id,
      rev: candidate.rev,
      seenSeq: candidate.seenSeq,
      answer,
      ...(note ? { note } : {}),
    };
    const body = JSON.stringify(fields);
    const operationId =
      pending.current?.body === body ? pending.current.operationId : crypto.randomUUID();
    pending.current = { body, operationId };
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch('/api/answer', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId, ...fields }),
        cache: 'no-store',
      });
      if (!mounted.current) return;
      // サーバーの途中の失敗（5xx）は、受け付けた後かもしれない：届いたか分からない時と同じに扱い、同じ答えの
      // 送り直しは同じ操作 ID で確かめる。数の上限（429）も、前の分からない送りが書かれたかは言えないので、取っておく。
      if (response.status >= 500) {
        setMessage(t('answerPage.uncertain'));
        return;
      }
      if (response.status === 429) {
        setMessage(t('answerPage.tooMany'));
        return;
      }
      pending.current = undefined;
      if (response.status === 401) setState({ kind: 'invalid' });
      else if (response.status === 409) {
        const refused = (await response.json()) as { error: string; view: AnswerView };
        show(refused.view);
        setMessage(
          t(
            refused.error === 'candidateChanged'
              ? 'answerPage.changed.candidate'
              : 'answerPage.changed.answer',
          ),
        );
      } else if (!response.ok) setMessage(t('answerPage.failed'));
      else {
        show(((await response.json()) as { view: AnswerView }).view);
        setMessage(t('answerPage.saved'));
      }
    } catch {
      // 返事が届かなかった：受け付けたかもしれないので「送れなかった」とは言わない。
      if (mounted.current) setMessage(t('answerPage.uncertain'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const languages = (
    <div className="flex gap-3 text-sm">
      {(['ja', 'en'] as const).map((code) => (
        <button
          key={code}
          type="button"
          className={`min-h-10 font-bold ${code === lang ? 'text-ink' : 'text-accent'}`}
          aria-pressed={code === lang}
          onClick={() => {
            chosenLanguage.current = true;
            void i18n.changeLanguage(code);
          }}
        >
          {t(`answerPage.lang.${code}`)}
        </button>
      ))}
    </div>
  );

  if (state.kind !== 'ok') {
    return (
      <div className={FRAME}>
        <Header title={t('answerPage.title')} right={languages} />
        <Main>
          <Card tone={state.kind === 'loading' ? 'plain' : 'warn'}>
            <Text>{t(`answerPage.state.${state.kind}`)}</Text>
          </Card>
        </Main>
      </div>
    );
  }
  const { view } = state;
  return (
    <div className={FRAME}>
      <Header
        eyebrow={t('answerPage.to', { name: view.name })}
        title={view.what}
        right={languages}
      />
      <Main>
        <Text>{t('answerPage.intro')}</Text>
        {view.place && <Text>{t('answerPage.place', { place: view.place })}</Text>}
        {message && (
          <Card tone="accent">
            <Text>{message}</Text>
          </Card>
        )}
        {view.candidates.map((c) => (
          <Card key={`${c.id}:${c.rev}`}>
            <Label tone="sub">
              {c.answer === 'maybe' && c.note
                ? t('answerPage.current.maybeWith', { note: c.note })
                : t(`answerPage.current.${c.answer ?? 'none'}`)}
            </Label>
            <Title>
              {t('answerPage.slot', {
                day: formatDay(c.date, lang, 'UTC'),
                from: c.startTime,
                to: c.endTime,
              })}
            </Title>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-bold text-sub">{t('answerPage.maybeNote')}</span>
              <input
                className={input}
                maxLength={140}
                value={notes[c.id] ?? c.note ?? ''}
                onChange={(e) => setNotes((all) => ({ ...all, [c.id]: e.target.value }))}
              />
            </label>
            <Row>
              {(['yes', 'maybe', 'no'] as const).map((answer) => (
                <Button
                  key={answer}
                  kind={c.answer === answer ? 'primary' : 'secondary'}
                  onClick={() => void send(c, answer)}
                  disabled={busy}
                >
                  {t(`answerPage.answer.${answer}`)}
                </Button>
              ))}
            </Row>
            {c.answer && (
              <MoreLink onClick={() => void send(c, 'withdrawn')}>
                {t('answerPage.withdraw')}
              </MoreLink>
            )}
          </Card>
        ))}
        <Text quiet>{t('answerPage.warning')}</Text>
      </Main>
    </div>
  );
}
