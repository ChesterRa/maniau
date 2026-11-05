// @vitest-environment happy-dom
// 家の情報を直す時の「見る → 記録する」：見る答えは、最後に頼んだ物の答えだけを使う。後から頼んだ物の答えが先に
// 届いても、前の頼みの遅れた答えで上書きしない（中身が違う時も、計画が進んで同じ中身を見直した時も）。
import type { Command, Household, HouseholdPreview } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../src/screens';
import { useHouseholdSave } from '../src/ways';
import { step } from './fake-fetch';

const A = { id: 'h', note: 'A' } as unknown as Household;
const B = { id: 'h', note: 'B' } as unknown as Household;

/** 頼んだ順に答えを止めておき、試験が好きな順で返す。n 回目の答えは、見た要約 S-n と計画の番号 6+n。 */
function materials() {
  const releases: (() => void)[] = [];
  const sent: Command[] = [];
  let calls = 0;
  const ctx = {
    previewHousehold: async () => {
      const n = ++calls;
      await new Promise<void>((resolve) => releases.push(resolve));
      const preview = { seen: `S-${n}`, throughSeq: 6 + n } as unknown as HouseholdPreview;
      return { preview };
    },
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
  } as unknown as Ctx;
  return { ctx, releases, sent };
}

let flow: ReturnType<typeof useHouseholdSave> | undefined;
function Probe({ ctx }: { ctx: Ctx }) {
  flow = useHouseholdSave(ctx);
  return null;
}
const current = () => {
  if (!flow) throw new Error('まだ描いていない');
  return flow;
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  flow = undefined;
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

it('後から頼んだ物の答えが先に届いても、前の頼みの遅れた答えで上書きしない', async () => {
  const { ctx, releases, sent } = materials();
  await step(() => root.render(<Probe ctx={ctx} />));
  await step(() => void current().look(A));
  await step(() => void current().look(B));
  await step(() => releases[1]?.());
  await step(() => releases[0]?.());
  expect(current().shownFor(B)).toMatchObject({ seen: 'S-2' });
  expect(current().shownFor(A)).toBeUndefined();
  expect(current().busy).toBe(false);
  await step(() => void current().save(B));
  expect(sent).toEqual([
    { type: 'updateHousehold', household: B, seen: { throughSeq: 8, changes: 'S-2' } },
  ]);
});

it('同じ中身を見直した時も、前の頼みの遅れた答えを使わない（計画が進んだ後の見直し）', async () => {
  const { ctx, releases, sent } = materials();
  await step(() => root.render(<Probe ctx={ctx} />));
  await step(() => void current().look(A));
  await step(() => void current().look(A));
  await step(() => releases[1]?.());
  await step(() => releases[0]?.());
  expect(current().shownFor(A)).toMatchObject({ seen: 'S-2', throughSeq: 8 });
  await step(() => void current().save(A));
  expect(sent).toEqual([
    { type: 'updateHousehold', household: A, seen: { throughSeq: 8, changes: 'S-2' } },
  ]);
});

it('前の頼みの答えだけが届いている間は「計算しています」のまま（前の答えを見せない）', async () => {
  const { ctx, releases } = materials();
  await step(() => root.render(<Probe ctx={ctx} />));
  await step(() => void current().look(A));
  await step(() => void current().look(B));
  await step(() => releases[0]?.());
  expect(current().shownFor(A)).toBeUndefined();
  expect(current().shownFor(B)).toBeUndefined();
  expect(current().busy).toBe(true);
  await step(() => releases[1]?.());
  expect(current().shownFor(B)).toMatchObject({ seen: 'S-2' });
  expect(current().busy).toBe(false);
});
