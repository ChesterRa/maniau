// 画面の部品。大きな字、押しやすいボタン（高さ 54px）、カードごとにボタンは一つ（二択だけ二つ）。
import type { ReactNode } from 'react';

export function Header(props: {
  title: string;
  eyebrow?: string;
  back?: { label: string; onClick: () => void };
  right?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-5 pt-4 pb-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {props.back && (
          <button
            type="button"
            onClick={props.back.onClick}
            className="-ml-1.5 inline-flex min-h-10 items-center gap-0.5 self-start font-bold text-accent"
          >
            <Icon path={ICON.back} size={22} />
            {props.back.label}
          </button>
        )}
        {props.eyebrow && <span className="text-[15px] text-sub">{props.eyebrow}</span>}
        <h1 className="font-round text-[27px] leading-snug font-bold text-balance">
          {props.title}
        </h1>
      </div>
      {props.right}
    </header>
  );
}

export function Main({ children }: { children: ReactNode }) {
  return <main className="flex flex-1 flex-col gap-3 px-4 pt-1.5 pb-6">{children}</main>;
}

type Tone = 'plain' | 'bag' | 'accent' | 'warn';
const tones: Record<Tone, string> = {
  plain: 'bg-card border-line',
  bag: 'bg-bag border-bag-line',
  accent: 'bg-accent-soft border-accent-line',
  warn: 'bg-card border-line',
};

export function Card(props: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <section
      className={`flex flex-col gap-2.5 rounded-[20px] border p-4 ${tones[props.tone ?? 'plain']} ${props.className ?? ''}`}
    >
      {props.children}
    </section>
  );
}

export function Label({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'warn' | 'accent' | 'sub' | 'bag';
}) {
  const color = { warn: 'text-warn', accent: 'text-accent', sub: 'text-sub', bag: 'text-bag-ink' }[
    tone
  ];
  return <span className={`text-sm font-bold tracking-wide ${color}`}>{children}</span>;
}

export function Title({ children }: { children: ReactNode }) {
  return <h2 className="font-round text-[21px] leading-snug font-bold text-balance">{children}</h2>;
}

export function Text({ children, quiet }: { children: ReactNode; quiet?: boolean }) {
  return <p className={quiet ? 'text-[15px] text-sub' : 'text-base'}>{children}</p>;
}

export function Button(props: {
  children: ReactNode;
  onClick: () => void;
  kind?: 'primary' | 'secondary';
  className?: string;
  /** 押せない（待っている間など）。 */
  disabled?: boolean;
}) {
  const look =
    props.kind === 'secondary'
      ? 'bg-white text-ink border-[1.5px] border-btn-line active:bg-paper'
      : 'bg-accent text-white active:bg-accent-dark';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex min-h-[54px] flex-1 items-center justify-center gap-2 rounded-2xl px-3.5 font-round text-lg font-bold disabled:opacity-50 ${look} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

/**
 * ボタンの並び。狭い画面では、文字を一字ずつ折らずに、ボタンを次の行へ送る（ボタンは最小の幅を持ち、
 * 行ごとに広がる）。
 */
export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2.5 [&>button]:min-w-[7rem]">{children}</div>;
}

export function MoreLink(props: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex min-h-10 items-center gap-0.5 self-start font-bold text-accent"
    >
      {props.children}
      <Icon path={ICON.chevron} size={18} />
    </button>
  );
}

export function Quote(props: { children: ReactNode; cite?: string }) {
  return (
    <blockquote className="flex flex-col gap-1 rounded-xl bg-bag px-3 py-2.5">
      <span className="text-base leading-relaxed">{props.children}</span>
      {props.cite && <span className="text-[13px] text-bag-ink">{props.cite}</span>}
    </blockquote>
  );
}

export function Pair(props: { left: ReactNode; right: ReactNode; last?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-3 py-1.5 ${props.last ? '' : 'border-b border-line'}`}
    >
      <span className="text-[17px]">{props.left}</span>
      <span className="text-right text-[15px] text-sub">{props.right}</span>
    </div>
  );
}

export const ICON = {
  back: '<path d="M15 5l-7 7 7 7"></path>',
  chevron: '<path d="M9 5l7 7-7 7"></path>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
  home: '<path d="M4 11.5L12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"></path>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15" rx="3"></rect><path d="M3.5 10h17M8 3v4M16 3v4"></path>',
  camera:
    '<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z"></path><circle cx="12" cy="13.5" r="3.6"></circle>',
  clock: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
  message:
    '<path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.5 3.5V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"></path>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"></path><path d="M10 20.5a2 2 0 0 0 4 0"></path>',
} as const;

export function Icon({
  path,
  size = 24,
  width = 2,
}: {
  path: string;
  size?: number;
  width?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 定数のアイコンの線だけ
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

export function TabBar(props: {
  active: 'today' | 'week';
  labels: { today: string; snap: string; week: string };
  onToday: () => void;
  onSnap: () => void;
  onWeek: () => void;
}) {
  const item = (key: 'today' | 'week', icon: string, label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-current={props.active === key ? 'page' : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 pt-2.5 text-[13px] ${props.active === key ? 'font-bold text-accent' : 'text-sub'}`}
    >
      <Icon path={icon} size={26} />
      {label}
    </button>
  );
  return (
    <nav className="sticky bottom-0 flex items-start border-t border-line bg-white px-3 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
      {item('today', ICON.home, props.labels.today, props.onToday)}
      <button
        type="button"
        onClick={props.onSnap}
        className="flex flex-1 flex-col items-center gap-1 text-[13px] font-bold text-ink"
      >
        <span className="-mt-6 flex size-16 items-center justify-center rounded-full border-4 border-white bg-accent text-white shadow-[0_4px_12px_rgba(30,107,85,0.3)]">
          <Icon path={ICON.camera} size={30} />
        </span>
        {props.labels.snap}
      </button>
      {item('week', ICON.calendar, props.labels.week, props.onWeek)}
    </nav>
  );
}
