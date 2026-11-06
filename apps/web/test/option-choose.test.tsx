// 案の札は見るだけ。「選んだら」の返事を待ち、選ぶボタンでだけ、見た結果を添えて命令する。
import type { ChoicePreview, Command } from '@maniau/core';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Ctx, DecideScreen, optionTitle } from '../src/screens';
import { ctxFor } from './ctx';
import { step } from './fake-fetch';

// 見本を Node で読んでから、小さな画面を作る。
const browser = new Window({ url: 'http://localhost/' });
const globals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'MouseEvent',
] as const;
const previous = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globals) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: browser[key] ?? browser,
  });
}
const { createRoot } = await import('react-dom/client');
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});

const CARE = 'arr:childCare:n1:i6:c';
const OPTION = 'opt:arr:childCare:n1:i6:c:opt-gakudo';
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

function preview(seen?: string): ChoicePreview {
  return {
    arrangementKey: CARE,
    optionKey: OPTION,
    current: false,
    steps: [
      {
        taskKey: 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:write',
        titleKey: 'task.gakudoForm.write',
        titleParams: {},
        assigneeId: 'b',
        external: false,
      },
    ],
    cancels: [],
    conflicts: [],
    moved: [],
    assigneeId: 'b',
    ...(seen ? { seen } : {}),
  };
}

function chooseButton(ctx: Ctx): HTMLButtonElement {
  const label = ctx.t('decide.goNamed', { option: ctx.t('option.afterSchoolFullDay.title') });
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`選ぶボタンが無い：${label}`);
  return found;
}

describe('取れる手を選ぶ', () => {
  it('札を触っても選ばず、返事が来た後だけ、見た結果を添えて選ぶ', async () => {
    const pending: ((value: ChoicePreview[] | undefined) => void)[] = [];
    const commands: Command[] = [];
    const base = ctxFor('arrived', 'b', 'ja');
    const ctx: Ctx = {
      ...base,
      preview: () => new Promise((resolve) => pending.push(resolve)),
      send: async (command) => {
        commands.push(command);
        return { status: 'ok' };
      },
    };
    await step(() => root.render(<DecideScreen ctx={ctx} arrangementKey={CARE} />));
    expect(chooseButton(ctx).disabled).toBe(true);
    await step(() => chooseButton(ctx).click());
    expect(commands).toEqual([]);

    await step(() => pending[0]?.([preview('seen-1')]));
    const button = chooseButton(ctx);
    expect(button.disabled).toBe(false);
    const card = button.parentElement;
    if (!card) throw new Error('札が無い');
    expect(card.textContent).toContain('選んだら');
    expect(card.querySelector('button button')).toBeNull();
    // 札そのものや時計の絵には、選ぶ動作を付けない。
    await step(() => card.click());
    const svg = card.querySelector('svg');
    await step(() => svg?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(commands).toEqual([]);
    await step(() => button.click());
    expect(commands).toEqual([
      expect.objectContaining({ type: 'chooseOption', optionKey: OPTION, seen: 'seen-1' }),
    ]);
  });

  it('見た結果が無い時と、見た後に変わった時は選ばず、新しい結果を待つ', async () => {
    const pending: ((value: ChoicePreview[] | undefined) => void)[] = [];
    const commands: Command[] = [];
    const went: unknown[] = [];
    const base = ctxFor('arrived', 'b', 'ja');
    const ctx: Ctx = {
      ...base,
      preview: () => new Promise((resolve) => pending.push(resolve)),
      send: async (command) => {
        commands.push(command);
        return commands.length === 1 ? { status: 'conflict' } : { status: 'ok' };
      },
      go: (route) => went.push(route),
    };
    await step(() => root.render(<DecideScreen ctx={ctx} arrangementKey={CARE} />));
    await step(() => pending[0]?.([preview()]));
    expect(chooseButton(ctx).disabled).toBe(true);
    expect(host.textContent).toContain(ctx.t('decide.waiting.missing'));

    // 見た内容を付けた返事が来た後、選択が衝突したら、もう一度読む。
    await step(() =>
      root.render(
        <DecideScreen
          ctx={{ ...ctx, plan: { ...ctx.plan, throughSeq: ctx.plan.throughSeq + 1 } }}
          arrangementKey={CARE}
        />,
      ),
    );
    await step(() => pending[1]?.([preview('seen-old')]));
    await step(() => chooseButton(ctx).click());
    expect(commands).toHaveLength(1);
    expect(went).toEqual([]);
    expect(chooseButton(ctx).disabled).toBe(true);
    await step(() => pending[2]?.([preview('seen-new')]));
    await step(() => chooseButton(ctx).click());
    expect(commands.at(-1)).toMatchObject({
      type: 'chooseOption',
      optionKey: OPTION,
      seen: 'seen-new',
    });
    expect(went).toHaveLength(1);
  });

  it('すでに進めている手には選ぶボタンを出さない', async () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const arrangement = ctx.plan.arrangements.find((a) => a.key === CARE);
    const current = arrangement?.options.find((o) => o.key === arrangement.chosenOptionKey);
    if (!current) throw new Error('進めている手が無い');
    await step(() => root.render(<DecideScreen ctx={ctx} arrangementKey={CARE} />));
    const label = ctx.t('decide.goNamed', { option: optionTitle(ctx, current) });
    expect(
      [...host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === label),
    ).toBe(false);
    expect(host.textContent).toContain(ctx.t('decide.current'));
  });
});
