// 声で欄に入れる：ブラウザの音声認識（あれば）で発話を文字にし、欄の今の文字の後ろに足す。話の間で少し黙っても
// 止めず、「止める」を押すか、しばらく黙るまで聞く。送らない・記録しない（送るのは、家族が文字を確かめて押した時
// だけ）。声はこのアプリに届かない（受け取るのは、認識した文字だけ）。
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
  /** 人の声が聞こえ始めた・やんだ（届かないブラウザもある。ほかの知らせとの順は決まっていない）。 */
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
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

/** 黙っている時間がこれを超えたら、聞くのを止める（マイクを開けたままにしない）。 */
export const SILENCE_MS = 8000;
/** 認識を始め直せなかった時に、もう一度だけ試すまでの間。 */
const RETRY_MS = 250;

/**
 * 一回の聞き取り（「話す」から止まるまで）。認識は発話ごとに終わるので、同じ物を始め直して続けて聞く（続けて聞く
 * 形は、iOS の Safari で文字が重なることがある）。latest は今の発話の文字、heard はこの聞き取りで文字を渡したか、
 * speaking は声が聞こえている間（その間は黙っている時間を数えない）。done の後に届いた知らせは使わない（取り消した
 * 後・失敗の後・画面を離れた後）。
 */
type Session = {
  recognition: Recognition;
  latest: string;
  heard: boolean;
  speaking: boolean;
  stopping: boolean;
  quiet: boolean;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** 黙っている時間を数えるのをやめる。 */
function disarm(s: Session) {
  clearTimeout(s.timer);
  s.timer = undefined;
}

/**
 * 押しボタンと、聞いている間・失敗の一行と、押す前に読める注記。onHeard には聞き取った文字だけを、一つの発話に
 * 一度だけ、発話が終わるたびに渡す（欄の今の文字に足すのは呼ぶ側。聞き始めた時の文字で上書きしない）。
 * disabled になったら（送る・読むを押した等）、今の発話を捨てる（押した時の文字で送る）。画面を離れた時も捨てる。
 * send は、その欄の送る押しボタンの名前（注記に使う）。
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
    disarm(s);
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
      disarm(s);
      session.current = undefined;
      s.recognition.abort();
    },
    [],
  );

  const finish = (s: Session) => {
    s.done = true;
    disarm(s);
    if (session.current === s) session.current = undefined;
    setListening(false);
    setInterim('');
  };
  /**
   * 黙っている時間を数え直す。超えたら止める（止まった時に、何も聞こえていなければそう出す）。声が聞こえている間は
   * 数えない（話し始めてから文字が返るまでに止めない）。
   */
  const wait = (s: Session) => {
    disarm(s);
    if (s.speaking) return;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (s.done) return;
      s.stopping = true;
      s.quiet = true;
      s.recognition.stop();
    }, SILENCE_MS);
  };
  /** 発話が終わった後、同じ認識を始め直す。始められなければ少し待って一度だけ試し、だめなら止める。 */
  const again = (s: Session) => {
    try {
      s.recognition.start();
    } catch {
      setTimeout(() => {
        if (s.done) return;
        // 待つ間に「止める」を押した・黙っている時間が過ぎた：始め直さずに止める。
        if (s.stopping) {
          finish(s);
          return;
        }
        try {
          s.recognition.start();
        } catch {
          finish(s);
        }
      }, RETRY_MS);
    }
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
    const s: Session = {
      recognition,
      latest: '',
      heard: false,
      speaking: false,
      stopping: false,
      quiet: false,
      done: false,
    };
    recognition.lang = ctx.lang === 'ja' ? 'ja-JP' : 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (s.done) return;
      s.latest = Array.from(event.results, (result) => result[0]?.transcript ?? '').join('');
      setInterim(s.latest);
      wait(s);
    };
    recognition.onspeechstart = () => {
      if (s.done) return;
      s.speaking = true;
      disarm(s);
    };
    recognition.onspeechend = () => {
      if (s.done) return;
      s.speaking = false;
      wait(s);
    };
    recognition.onerror = (event) => {
      if (s.done) return;
      // 声が無かった：止めていなければ聞き続け（終わりで始め直す）、止めていれば終わりで止まる。
      if (event.error === 'no-speech') return;
      // ほかの失敗では止める。今の発話の途中の文字は欄に入れない（前の発話の文字は、もう欄にある）。ブラウザが
      // 取り消した時は、失敗とは出さない（こちらが取り消す時は、先に done にしている）。
      finish(s);
      if (event.error === 'aborted') return;
      setError(ERRORS[event.error] ?? 'other');
    };
    recognition.onend = () => {
      if (s.done) return;
      const said = s.latest;
      const spoke = said.trim().length > 0 || s.speaking;
      s.latest = '';
      s.speaking = false;
      setInterim('');
      if (said.trim().length > 0) {
        s.heard = true;
        heardRef.current(said);
      }
      if (!s.stopping) {
        // 声か文字のあった発話は、その終わりから数え直す（声のやんだ知らせが無いブラウザでも）。何も聞こえずに
        // 終わった時（no-speech）は数え直さない（声の無いまま終わりと始め直しを繰り返しても、止まるように）。
        if (spoke || s.timer === undefined) wait(s);
        again(s);
        return;
      }
      finish(s);
      // 黙っていて止まり、一度も聞き取れなかった時だけ、そう出す（押して止めた時は出さない）。
      if (s.quiet && !s.heard) setError('noSpeech');
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
      return;
    }
    wait(s);
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
