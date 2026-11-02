// デモの家庭（ログインの無い、架空の家族）。見る人ごとに、段の事象から作った家庭をメモリに置く。
// 一人の操作が、別の人の見るデモを変えないようにする。古い物から捨てる。
import { randomUUID } from 'node:crypto';
import type { Command, DateTime } from '@maniau/core';
import { type CommandResult, runCommand } from './commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from './demo';
import { memoryStore } from './store';
import { type View, viewFor } from './views';

const MAX_SESSIONS = 200;
const TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  now: DateTime;
  touched: number;
}

export function demoSessions(clock: () => number = Date.now) {
  const store = memoryStore();
  const sessions = new Map<string, Session>();

  const sweep = () => {
    const now = clock();
    for (const [id, session] of sessions) {
      if (now - session.touched > TTL_MS) {
        sessions.delete(id);
        store.drop(id);
      }
    }
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
      store.drop(oldest[0]);
    }
  };

  // 期限を過ぎたデモは、作る時の掃除を待たずに、触った時にも捨てる。
  const touch = (id: string) => {
    const session = sessions.get(id);
    if (!session) return undefined;
    if (clock() - session.touched > TTL_MS) {
      sessions.delete(id);
      store.drop(id);
      return undefined;
    }
    session.touched = clock();
    return session;
  };

  return {
    /** 段から新しいデモの家庭を作る。 */
    create(stage: DemoStageId): string {
      sweep();
      const id = randomUUID();
      const now = DEMO_STAGES.find((s) => s.id === stage)?.now;
      if (!now) throw new Error(`デモの段が無い：${stage}`);
      store.create(id, demoEvents(stage));
      sessions.set(id, { now, touched: clock() });
      return id;
    },
    async view(id: string, memberId: string): Promise<View | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      return store.withHousehold(id, (log) => viewFor(log.events(), memberId, session.now));
    },
    async command(
      id: string,
      memberId: string,
      operationId: string,
      command: Command,
    ): Promise<{ result: CommandResult; view: View } | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      // 時計を進めたデモの時刻は、命令の処理が家庭を押さえた中で事象から決める（ここで先に読まない）。
      const result = await runCommand(
        store,
        id,
        { memberId, operationId, now: session.now, demo: true },
        command,
      );
      const view = await store.withHousehold(id, (log) =>
        viewFor(log.events(), memberId, session.now),
      );
      return { result, view };
    },
  };
}
