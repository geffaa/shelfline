"use client";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface Choice<T extends string> { value: T; label: ReactNode; sub?: ReactNode; disabled?: boolean }
/** A single choice from a few tiles (a radio group with arrow-key movement). The browser's own radio buttons and drop-downs are not used. */
export function Tiles<T extends string>({ label, value, onChange, options, columns }: { label: string; value: T | null; onChange: (v: T) => void; options: Choice<T>[]; columns?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = options.filter((o) => !o.disabled);
  const move = (e: KeyboardEvent, dir: 1 | -1) => { e.preventDefault(); const i = enabled.findIndex((o) => o.value === value); const next = enabled[(i + dir + enabled.length) % enabled.length]; if (next) { onChange(next.value); ref.current?.querySelector<HTMLElement>(`[data-v="${next.value}"]`)?.focus(); } };
  return (
    <div role="radiogroup" aria-label={label} ref={ref} className="tiles" style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((o) => {
        const on = o.value === value; const tabbable = on || (value === null && o === enabled[0]);
        return <button key={o.value} type="button" role="radio" aria-checked={on} aria-disabled={o.disabled || undefined} data-v={o.value} tabIndex={tabbable ? 0 : -1} className={`tile${on ? " on" : ""}${o.disabled ? " off" : ""}`}
          onClick={() => !o.disabled && onChange(o.value)} onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowDown") move(e, 1); else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(e, -1); else if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!o.disabled) onChange(o.value); } }}>
          <span className="t1">{o.label}</span>{o.sub && <span className="t2">{o.sub}</span>}</button>;
      })}
    </div>
  );
}
export function Stepper({ label, value, min = 1, max = 20, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (n: number) => void }) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span className="v" aria-live="polite">{value}</span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}
