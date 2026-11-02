// 試験の fetch：呼び出しを溜め、試験が順に返事をする（遅らせる・中身だけ遅らせる・途切れさせる）。
import { act } from 'react';

export interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  done: boolean;
  /** 返事を返す。gate を渡すと、中身（json）を読み終えるのを gate まで遅らせる。 */
  respond: (status: number, payload: unknown, gate?: Promise<void>) => void;
  /** 通信が途切れた。 */
  drop: () => void;
}

export function installFetch(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        done: false,
        respond: (status, payload, gate) => {
          call.done = true;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
              await gate;
              return payload;
            },
          } as Response);
        },
        drop: () => {
          call.done = true;
          reject(new TypeError('Failed to fetch'));
        },
      };
      calls.push(call);
    })) as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return calls;
}

/** まだ返事をしていない呼び出しのうち、合う物の最後（一つも無ければ投げる）。 */
export function take(calls: Call[], match: (c: Call) => boolean): Call {
  const found = calls.filter((c) => !c.done && match(c)).at(-1);
  if (!found) throw new Error('待っている呼び出しが無い');
  return found;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** fn の後、溜まった約束と描画を済ませる。 */
export async function step(fn: () => void = () => {}) {
  await act(async () => {
    fn();
    await settle();
  });
}
