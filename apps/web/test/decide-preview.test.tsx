// @vitest-environment happy-dom
// 決める画面の「選んだら」を読む：今の計画の分を読み終えるまでと、読めなかった時は選べない状態を返し、
// もう一度読める。計画が進めば、読み終えるまで前の分を使わない。
import type { ChoicePreview } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useChoicePreviews } from '../src/screens';
import { step } from './fake-fetch';

const care = 'arr:childCare:n1:i6:c';
const gakudo = 'opt:arr:childCare:n1:i6:c:opt-gakudo';

const shown: ChoicePreview = {
  arrangementKey: care,
  optionKey: gakudo,
  current: false,
  steps: [],
  cancels: [],
  conflicts: [],
  moved: [],
  assigneeId: 'a',
  issues: [],
  seen: 'seen-1',
};

function Probe(props: {
  preview: (arrangementKey: string) => Promise<ChoicePreview[] | undefined>;
  throughSeq: number;
  onState: (state: ReturnType<typeof useChoicePreviews>) => void;
}) {
  const state = useChoicePreviews(props.preview, care, props.throughSeq);
  props.onState(state);
  return null;
}

it('読み終えるまでは loading、読めたら ready、計画が進めば読み終えるまで前の分を使わない', async () => {
  const pending: ((list: ChoicePreview[] | undefined) => void)[] = [];
  const preview = () =>
    new Promise<ChoicePreview[] | undefined>((resolve) => {
      pending.push(resolve);
    });
  let state: ReturnType<typeof useChoicePreviews> | undefined;
  const root = createRoot(document.createElement('div'));
  const render = (throughSeq: number) =>
    root.render(
      <Probe
        preview={preview}
        throughSeq={throughSeq}
        onState={(s) => {
          state = s;
        }}
      />,
    );
  await step(() => render(7));
  expect(state?.reading).toBe('loading');
  expect(state?.previews).toBeUndefined();
  await step(() => pending[0]?.([shown]));
  expect(state?.reading).toBe('ready');
  expect(state?.previews?.get(gakudo)?.seen).toBe('seen-1');
  // 計画が進んだ：新しい分を読み終えるまで、前の分（seen-1）を選ぶのに使わない。
  await step(() => render(8));
  expect(state?.reading).toBe('loading');
  expect(state?.previews).toBeUndefined();
  await step(() => pending[1]?.([{ ...shown, seen: 'seen-2' }]));
  expect(state?.previews?.get(gakudo)?.seen).toBe('seen-2');
  await step(() => root.unmount());
});

it('読めなかった時は failed で、もう一度読める', async () => {
  let calls = 0;
  const preview = async () => {
    calls += 1;
    return calls === 1 ? undefined : [shown];
  };
  let state: ReturnType<typeof useChoicePreviews> | undefined;
  const root = createRoot(document.createElement('div'));
  await step(() =>
    root.render(
      <Probe
        preview={preview}
        throughSeq={7}
        onState={(s) => {
          state = s;
        }}
      />,
    ),
  );
  expect(state?.reading).toBe('failed');
  await step(() => state?.reread());
  expect(calls).toBe(2);
  expect(state?.reading).toBe('ready');
  await step(() => root.unmount());
});

function Off(props: { onState: (state: ReturnType<typeof useChoicePreviews>) => void }) {
  props.onState(useChoicePreviews(undefined, care, 7));
  return null;
}

it('読む手立ての無い画面では off（前のとおり選べる）', async () => {
  let state: ReturnType<typeof useChoicePreviews> | undefined;
  const root = createRoot(document.createElement('div'));
  await step(() =>
    root.render(
      <Off
        onState={(s) => {
          state = s;
        }}
      />,
    ),
  );
  expect(state?.reading).toBe('off');
  await step(() => root.unmount());
});
