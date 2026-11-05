// 声で欄に入れる：ブラウザの音声認識（あれば）で一回の発話を文字にし、欄の今の文字の後ろに足す。送らない・記録
// しない（送るのは、家族が文字を確かめて押した時だけ）。声はこのアプリに届かない（受け取るのは、認識した文字だけ）。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Ctx } from './screens';
import { Text } from './ui';

/** ブラウザの音声認識（SpeechRecognition・webkitSpeechRecognition）の、使う所だけの形。 */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
  const g = globalThis as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

type VoiceError = 'notAllowed' | 'unavailable' | 'network' | 'noSpeech' | 'noMic' | 'other';
const ERRORS: Record<string, VoiceError> = {
  'not-allowed': 'notAllowed',
  'service-not-allowed': 'unavailable',
  'language-not-supported': 'unavailable',
  network: 'network',
  'no-speech': 'noSpeech',
  'audio-capture': 'noMic',
};

/**
 * 欄の今の文字の後ろに、聞き取った文字を足す（前の文字は消さない。間に空白を一つ）。長くなっても切らない（欄の側
 * で長すぎることを示し、家族が消す）。
 */
export function appendHeard(before: string, heard: string): string {
  const add = heard.trim();
  if (add.length === 0) return before;
  return before.length === 0 || /\s$/.test(before) ? `${before}${add}` : `${before} ${add}`;
}

/** 一回の聞き取り。done の後に届いた知らせは使わない（取り消した後・失敗の後・画面を離れた後）。 */
type Session = { recognition: Recognition; latest: string; stopping: boolean; done: boolean };

/**
 * 押しボタンと、聞いている間・失敗の一行と、押す前に読める注記。onHeard には聞き取った文字だけを、一回の発話に
 * 一度だけ渡す（欄の今の文字に足すのは呼ぶ側。聞き始めた時の文字で上書きしない）。disabled になったら（送る・
 * 読むを押した等）、聞いている物を捨てる（押した時の文字で送る）。画面を離れた時も捨てる。send は、その欄の送る
 * 押しボタンの名前（注記に使う）。
 */
export function useVoice({
  ctx,
  onHeard,
  disabled,
  send,
}: {
  ctx: Ctx;
  onHeard: (heard: string) => void;
  disabled: boolean;
  send: string;
}): { supported: boolean; button?: ReactNode; status?: ReactNode; note: ReactNode } {
  const Recognition = recognitionClass();
  const session = useRef<Session | undefined>(undefined);
  const heardRef = useRef(onHeard);
  heardRef.current = onHeard;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<VoiceError>();

  useEffect(() => {
    if (!disabled) return;
    const s = session.current;
    if (!s) return;
    s.done = true;
    session.current = undefined;
    s.recognition.abort();
    setListening(false);
    setInterim('');
  }, [disabled]);
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.done = true;
      session.current = undefined;
      s.recognition.abort();
    },
    [],
  );

  const finish = (s: Session) => {
    s.done = true;
    if (session.current === s) session.current = undefined;
    setListening(false);
    setInterim('');
  };
  const start = () => {
    if (!Recognition || session.current || disabled) return;
    let recognition: Recognition;
    try {
      recognition = new Recognition();
    } catch {
      setError('other');
      return;
    }
    const s: Session = { recognition, latest: '', stopping: false, done: false };
    recognition.lang = ctx.lang === 'ja' ? 'ja-JP' : 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (s.done) return;
      s.latest = Array.from(event.results, (result) => result[0]?.transcript ?? '').join('');
      setInterim(s.latest);
    };
    recognition.onerror = (event) => {
      if (s.done) return;
      finish(s);
      // 止めた・押して止めた後に声が無かった、は失敗として出さない。失敗の時の途中の文字は欄に入れない。
      if (event.error === 'aborted' || (s.stopping && event.error === 'no-speech')) return;
      setError(ERRORS[event.error] ?? 'other');
    };
    recognition.onend = () => {
      if (s.done) return;
      finish(s);
      if (s.latest.trim().length > 0) heardRef.current(s.latest);
    };
    session.current = s;
    setError(undefined);
    setInterim('');
    setListening(true);
    try {
      recognition.start();
    } catch {
      finish(s);
      setError('other');
    }
  };
  const stop = () => {
    const s = session.current;
    if (!s) return;
    s.stopping = true;
    s.recognition.stop();
  };

  if (!Recognition)
    return { supported: false, note: <Text quiet>{ctx.t('voice.keyboard', { send })}</Text> };
  return {
    supported: true,
    button: (
      <button
        type="button"
        onClick={listening ? stop : start}
        disabled={disabled}
        className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border-[1.5px] px-3 font-bold disabled:opacity-50 ${listening ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white text-ink active:bg-paper'}`}
      >
        <MicIcon />
        {ctx.t(listening ? 'voice.stop' : 'voice.start')}
      </button>
    ),
    status: listening ? (
      <div className="flex flex-col gap-0.5" aria-live="polite">
        <Text>
          {interim ? ctx.t('voice.hearing', { text: interim }) : ctx.t('voice.listening')}
        </Text>
        <Text quiet>{ctx.t('voice.notSent', { send })}</Text>
      </div>
    ) : error ? (
      <Text>{ctx.t(`voice.error.${error}`)}</Text>
    ) : undefined,
    note: <Text quiet>{ctx.t('voice.about')}</Text>,
  };
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
