// 画面とサーバー：見せる物を受け取り、画面の操作を命令で送る。計画はサーバーだけで作り、画面では
// エンジンを動かさない（02-foundation §7.1・§7.2）。家庭は二通り：見る人ごとのデモの家庭（ログイン
// なし。段と使う人を選ぶ）と、家族の家庭（Access でログインした大人。使う人は身元で決まる）。
// 返事の行き違い（遅れた返事・切り替え・途切れ）の扱いは、どちらも同じ（useServerView）。
import type { Command, DateTime, Household, PlanResult, Source, TodayCard } from '@maniau/core';
import type { LiveItem } from '@maniau/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Stage {
  id: string;
  now: string;
  /** その段で画面を見ている大人（最初に開く人）。 */
  viewer: string;
}

export interface Reading {
  sourceId: string;
  origin: 'recorded' | 'expected';
  model: string;
}

/** サーバーが、その大人のために作った見せる物（apps/server/src/views.ts と同じ形）。 */
export interface SessionView {
  throughSeq: number;
  now: DateTime;
  household: Household;
  plan: PlanResult;
  today: { main: TodayCard[]; quiet: TodayCard[] };
  sources: Source[];
  items: LiveItem[];
}

interface Session {
  sessionId: string;
  household: Household;
  readings: Reading[];
  stages: Stage[];
}

export type SendResult =
  | { status: 'ok' | 'noop' }
  | { status: 'conflict' | 'forbidden' | 'invalid' | 'failed'; reason?: string };

/**
 * 画面に出す知らせ。changed：見ていた物が古かった（新しい内容で見せ直した）。refused：その操作は
 * できなかった。expired：デモの家庭が古くなった。uncertain：返事が届かず、届いたか分からない
 * （送り直しは、同じ操作 ID で同じ操作として確かめる）。
 */
export type Notice = 'changed' | 'refused' | 'expired' | 'uncertain';

/**
 * 一つの操作（画面の一回の押下）。送り直す時も、同じ家庭・同じ大人・同じ ID・同じ中身で送る
 * （使う人を替えた後に、前の人の操作を今の人として送らない）。epoch は送った時の画面の代。
 */
interface Operation {
  epoch: number;
  where: Where;
  operationId: string;
  command: Command;
}

/** 見せる物を読み、命令を送る先。 */
export type Where =
  | { kind: 'demo'; sessionId: string; memberId: string }
  | { kind: 'family'; memberId: string };

// 家族の家庭では、画面が見ている大人（as）を添える。今の身元と違えば、サーバーは家庭の物を返さない
// （別の画面でログインが替わった時、前の人の画面のまま次の人として読む・書くのを防ぐ）。
const viewUrl = (w: Where) =>
  w.kind === 'demo'
    ? `/api/demo/sessions/${w.sessionId}/view?member=${encodeURIComponent(w.memberId)}`
    : `/api/view?as=${encodeURIComponent(w.memberId)}`;
const commandUrl = (w: Where) =>
  w.kind === 'demo' ? `/api/demo/sessions/${w.sessionId}/commands` : '/api/commands';
// 家族の家庭では、操作する人をサーバーが身元から決める。as は比べるためだけ（権限には使わない）。
const commandBody = (w: Where, operationId: string, command: Command) =>
  w.kind === 'demo'
    ? { memberId: w.memberId, operationId, command }
    : { as: w.memberId, operationId, command };
/** 身元を確かめられない・家族の大人でない（家族の家庭だけ）。 */
const DENIED = new Set(['unauthenticated', 'notAMember']);

const json = { 'content-type': 'application/json' };
/** 命令の返事を待つ長さ。過ぎたら「届いたか分からない」にする（同じ ID で送り直せる）。 */
const COMMAND_TIMEOUT_MS = 20_000;

/** 操作 ID（同じ操作の送り直しを見分ける。§7.3 の 4）。 */
function operationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** 見せる物と、それを読んだ画面の代（別の人・前の代の物を、今の画面に出さないため）。 */
interface Shown {
  epoch: number;
  view: SessionView;
}

/**
 * 画面の代：家庭（段・やり直し）か使う人が替わるたびに増える。A→B→A と戻っても、前の A の代とは
 * 別にする（名前が同じでも、替える前に送った物の返事を、今の画面に使わない）。
 */
interface Current {
  key: string | undefined;
  memberId: string | undefined;
  epoch: number;
}

/**
 * 見せる物を読み、命令を送る（デモと家族の家庭で共通）。where が替わる（家庭・使う人）たびに代を
 * 進め、前の代の返事を使わない。同じ代では、通し番号の古い見せる物で新しい物を上書きしない。
 */
export function useServerView(where: Where | undefined) {
  const [shown, setShown] = useState<Shown>();
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  // ログインの身元が、画面の大人と替わった（家族の家庭だけ）。画面は身元を確かめ直す。
  const [switched, setSwitched] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [reload, setReload] = useState(0);
  // 返事を待っている操作の代（同じ代の二度押しを止める。替えた後の人の操作は止めない）。
  const busy = useRef<number | undefined>(undefined);
  // 届いたか分からない操作。新しい操作を送る前に、これを同じ ID で確かめる。
  const pending = useRef<Operation | undefined>(undefined);
  const current = useRef<Current>({ key: undefined, memberId: undefined, epoch: 0 });

  // 効果の依存は文字だけにする（where の物は描画ごとに作り直される）。
  const kind = where?.kind;
  const sessionId = where?.kind === 'demo' ? where.sessionId : undefined;
  const memberId = where?.memberId;
  const key = kind === undefined ? undefined : `${kind}:${sessionId ?? ''}`;
  // 替わったら、すぐ（描画の中で）代を進める。遅れて届く返事は、どの await の後でも代で確かめる。
  if (current.current.key !== key || current.current.memberId !== memberId) {
    current.current = { key, memberId, epoch: current.current.epoch + 1 };
  }
  const epoch = current.current.epoch;
  const isCurrent = useCallback((at: number) => current.current.epoch === at, []);
  // 見せる物を替える。同じ代の中では、通し番号の古い物で新しい物を上書きしない（遅れて届いた
  // 読み直しが、後の命令の返事を消さないように）。
  const show = useCallback((at: number, view: SessionView) => {
    setShown((previous) =>
      previous && previous.epoch === at && previous.view.throughSeq > view.throughSeq
        ? previous
        : { epoch: at, view },
    );
    // 読めたので、前に読めなかった知らせは消す。
    setFailed(false);
  }, []);

  // 代が替わったら、前の代の届いたか分からない操作と知らせは手放す（今の人には関係しない）。
  useEffect(() => {
    void epoch;
    pending.current = undefined;
    setNotice(undefined);
  }, [epoch]);
  // 使う人を替えたら（届いたか分からない時も）、その人の見せる物を読み直す。
  useEffect(() => {
    void reload;
    if (!kind || !memberId) return;
    if (kind === 'demo' && !sessionId) return;
    const target: Where =
      kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
    const at = current.current.epoch;
    let cancelled = false;
    const usable = () => !cancelled && isCurrent(at);
    fetch(viewUrl(target))
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (usable()) setDenied(true);
          return;
        }
        if (response.status === 409 && target.kind === 'family') {
          if (usable()) setSwitched(true);
          return;
        }
        if (response.status === 404 && target.kind === 'demo') {
          if (usable()) setNotice('expired');
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as SessionView;
        if (usable()) show(at, next);
      })
      .catch(() => {
        if (usable()) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, sessionId, memberId, reload, isCurrent, show]);

  const deliver = useCallback(
    async (operation: Operation): Promise<SendResult> => {
      const { epoch: at, where: target, operationId, command } = operation;
      // 待つ間（中身を読む間も）に、段・やり直し・使う人が替わっていたら（替えて戻った時も）、この
      // 返事は使わず、前の画面の続き（移る等）もさせない。今の画面は読み直す。
      const stale = (): SendResult => {
        setReload((n) => n + 1);
        return { status: 'failed', reason: 'stale' };
      };
      // 二度押しで、同じ操作を別の操作として送らない。
      if (busy.current === at) return { status: 'failed', reason: 'busy' };
      busy.current = at;
      try {
        const response = await fetch(commandUrl(target), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(commandBody(target, operationId, command)),
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        });
        if (response.status === 404 && target.kind === 'demo') {
          if (pending.current?.operationId === operationId) pending.current = undefined;
          if (!isCurrent(at)) return stale();
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        const body = (await response.json()) as
          | { result: SendResult & { throughSeq: number }; view: SessionView }
          | { error: string };
        // 返事が届いたので、この操作の結果は分かった。
        if (pending.current?.operationId === operationId) pending.current = undefined;
        if (!isCurrent(at)) return stale();
        if (!('result' in body)) {
          if (DENIED.has(body.error)) setDenied(true);
          else if (body.error === 'identityChanged') setSwitched(true);
          else setNotice('refused');
          return { status: 'invalid', reason: body.error };
        }
        // 断られても、返った新しい見せる物で見せ直す。
        show(at, body.view);
        const { status } = body.result;
        if (status === 'conflict') setNotice('changed');
        else if (status === 'forbidden' || status === 'invalid') setNotice('refused');
        else setNotice(undefined);
        return body.result;
      } catch {
        // 返事が届かなかった（待ちすぎも含む）。サーバーが受け付けたかもしれないので「送れなかった」
        // とは言わない。同じ操作を取っておき、送り直しは同じ ID で行う（別の操作として二度書かない）。
        // 代が替わっていたら、前の人の操作は取っておかない（今の人として送らない）。
        if (!isCurrent(at)) return stale();
        setReload((n) => n + 1);
        pending.current = operation;
        setNotice('uncertain');
        return { status: 'failed', reason: 'uncertain' };
      } finally {
        if (busy.current === at) busy.current = undefined;
      }
    },
    [isCurrent, show],
  );

  const send = useCallback(
    (command: Command): Promise<SendResult> => {
      const now = current.current;
      // 前の描画の押下（今の人と違う人のまま）を、今の人の操作として送らない。
      if (!kind || !memberId || now.key !== key || now.memberId !== memberId) {
        return Promise.resolve({ status: 'failed', reason: 'stale' });
      }
      if (kind === 'demo' && !sessionId) return Promise.resolve({ status: 'failed' });
      // 届いたか分からない操作が残っていれば、先にそれを確かめてもらう。
      if (pending.current) {
        setNotice('uncertain');
        return Promise.resolve({ status: 'failed', reason: 'uncertain' });
      }
      const target: Where =
        kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
      return deliver({ epoch: now.epoch, where: target, operationId: operationId(), command });
    },
    [deliver, kind, key, sessionId, memberId],
  );

  // 今の代の見せる物だけを返す（替えた直後は、読み終えるまで何も見せない）。家族の大人でなく
  // なった（外された）と分かったら、前に読んだ物も見せない。
  const view = shown && shown.epoch === epoch && !denied && !switched ? shown.view : undefined;

  return {
    view,
    failed,
    /** 身元を確かめられない・家族の大人でない（家族の家庭だけ）。 */
    denied,
    /** ログインの身元が、画面の大人と替わった（家族の家庭だけ。身元を確かめ直す）。 */
    switched,
    notice,
    clearNotice: () => setNotice(undefined),
    send,
    /** 届いたか分からない操作を、同じ家庭・同じ大人・同じ ID・同じ代で送り直す。 */
    retry: () => {
      const operation = pending.current;
      return operation && isCurrent(operation.epoch)
        ? deliver(operation)
        : Promise.resolve(undefined);
    },
    /** 届いたか分からない操作を、送り直さずに手放す（次の押下は別の操作になる）。 */
    discard: () => {
      pending.current = undefined;
      setNotice(undefined);
    },
  };
}

export type ServerView = ReturnType<typeof useServerView>;

/** デモの家庭：段を替えるか、やり直すと、新しいデモの家庭をサーバーに作る。 */
export function useDemoSession(stage: string, memberId: string | undefined) {
  const [session, setSession] = useState<Session>();
  const [sessionFailed, setSessionFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    void generation;
    let cancelled = false;
    setSessionFailed(false);
    setSession(undefined);
    fetch('/api/demo/sessions', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ stage }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<Session>;
      })
      .then((made) => {
        if (!cancelled) setSession(made);
      })
      .catch(() => {
        if (!cancelled) setSessionFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [stage, generation]);

  const live = useServerView(
    session && memberId ? { kind: 'demo', sessionId: session.sessionId, memberId } : undefined,
  );
  return {
    ...live,
    session,
    failed: sessionFailed || live.failed,
    restart: () => setGeneration((g) => g + 1),
  };
}

/** 家族の家庭（ログインした大人。使う人は身元で決まり、替えない）。 */
export function useFamilySession(memberId: string) {
  return useServerView({ kind: 'family', memberId });
}

/** どちらの家庭を見せるか（サーバーに聞く）。家族の家庭の無いサーバーは、デモだけ。 */
export type Mode =
  | { kind: 'loading' }
  | { kind: 'demo' }
  /** pushKey：知らせの登録に使う公開鍵（サーバーに知らせが無ければ無い）。 */
  | { kind: 'family'; memberId: string; pushKey?: string }
  | { kind: 'denied' }
  | { kind: 'failed' };

/** どちらの家庭か。recheck で、ログインの身元を確かめ直す（替わった時）。 */
export function useMode(): { mode: Mode; recheck: () => void } {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void version;
    let cancelled = false;
    setMode({ kind: 'loading' });
    fetch('/api/me')
      .then(async (response): Promise<Mode> => {
        if (response.status === 401 || response.status === 403) return { kind: 'denied' };
        if (!response.ok) throw new Error(String(response.status));
        const me = (await response.json()) as
          | { mode: 'demo' }
          | { mode: 'family'; memberId: string; pushKey?: string };
        if (me.mode !== 'family') return { kind: 'demo' };
        return {
          kind: 'family',
          memberId: me.memberId,
          ...(typeof me.pushKey === 'string' ? { pushKey: me.pushKey } : {}),
        };
      })
      .then((next) => {
        if (!cancelled) setMode(next);
      })
      .catch(() => {
        if (!cancelled) setMode({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [version]);
  // 知らせから、前から開いていた画面に戻った：ログインが替わった後かもしれないので確かめ直す。
  useEffect(() => {
    const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    if (!container) return;
    const listen = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === 'maniau:opened') {
        setVersion((v) => v + 1);
      }
    };
    container.addEventListener('message', listen);
    return () => container.removeEventListener('message', listen);
  }, []);
  return { mode, recheck: () => setVersion((v) => v + 1) };
}
