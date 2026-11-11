import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(" ");

export function Button({ variant = "secondary", size, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "lg" }) {
  return <button type="button" {...p} className={cx("btn", variant === "primary" && "primary", variant === "ghost" && "ghost", size, p.disabled && "disabled", className)} />;
}
export function Chip({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info" | "volt"; children: ReactNode }) { return <span className={cx("chip", tone)}>{children}</span>; }
export function Callout({ tone = "warn", children, icon }: { tone?: "warn" | "danger" | "info"; children: ReactNode; icon?: ReactNode }) {
  return <div className={cx("callout", tone === "danger" && "danger", tone === "info" && "info")} role={tone === "danger" ? "alert" : "status"}>{icon}<div>{children}</div></div>;
}

/** Quantity stepper: 44px targets, bounds respected, announced as a group. */
export function Stepper({ value, onChange, min = 0, max = 999, label = "Quantity", decrementIcon, incrementIcon }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label?: string; decrementIcon: ReactNode; incrementIcon: ReactNode }) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>{decrementIcon}</button>
      <span className="v" aria-live="polite">{value}</span>
      <button type="button" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>{incrementIcon}</button>
    </span>
  );
}

/** Single choice from a few options (radiogroup). Arrow keys move the choice; only the selected option is in the tab order. */
export function Segmented<T extends string>({ options, value, onChange, label, size }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; size?: "lg" }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);
  const move = (to: number) => { const n = (to + options.length) % options.length; onChange(options[n]!.value); refs.current[n]?.focus(); };
  return (
    <div className={cx("seg", size)} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value || (idx < 0 && i === 0) ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i + 1); } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i - 1); } }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}><span className="track" />{children}</button>;
}
export function Checkbox({ checked, onChange, children, checkIcon }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; checkIcon: ReactNode }) {
  return <button type="button" role="checkbox" aria-checked={checked} className="check" onClick={() => onChange(!checked)}><span className="box">{checked && checkIcon}</span>{children}</button>;
}

/** Select with a listbox popover: Enter/Space/ArrowDown open, arrows move, Home/End jump, Enter picks, Escape closes, typing jumps to a match. */
export function Select<T extends string>({ options, value, onChange, label, placeholder = "Choose…", chevron }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; label: string; placeholder?: string; chevron?: ReactNode }) {
  const [open, setOpen] = useState(false); const [active, setActive] = useState(0);
  const id = useId(); const root = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null); const typed = useRef({ s: "", t: 0 });
  const selected = options.findIndex((o) => o.value === value);
  useEffect(() => { if (!open) return; const off = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", off); return () => document.removeEventListener("pointerdown", off); }, [open]);
  const show = () => { setActive(Math.max(0, selected)); setOpen(true); };
  const pick = (i: number) => { onChange(options[i]!.value); setOpen(false); btn.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) { if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); show(); } return; }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); } else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) { const now = Date.now(); typed.current.s = now - typed.current.t > 700 ? e.key : typed.current.s + e.key; typed.current.t = now; const m = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.s.toLowerCase())); if (m >= 0) setActive(m); }
  };
  return (
    <div className="select-wrap" ref={root}>
      <button ref={btn} type="button" role="combobox" className="select" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        <span>{selected >= 0 ? options[selected]!.label : <span className="muted">{placeholder}</span>}</span>{chevron}
      </button>
      {open && (
        <ul className="listbox" role="listbox" id={`${id}-list`} aria-label={label}>
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={i === selected} className={i === active ? "active" : undefined} onPointerEnter={() => setActive(i)} onClick={() => pick(i)}>{o.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PinDots({ length, filled, label = "PIN" }: { length: number; filled: number; label?: string }) {
  return <div className="pinrow" role="img" aria-label={`${label}: ${filled} of ${length} digits entered`}>{Array.from({ length }, (_, i) => <span key={i} className={i < filled ? "f" : undefined} />)}</div>;
}

/** Number pad. Also listens to the hardware keyboard while mounted, so a USB/Bluetooth keyboard works on a Mac mini till. */
export function Keypad({ onDigit, onBackspace, onSubmit, submitLabel = "Confirm", backspaceIcon, submitIcon, disabled, listen = true, extra }: { onDigit: (d: string) => void; onBackspace: () => void; onSubmit?: () => void; submitLabel?: string; backspaceIcon: ReactNode; submitIcon: ReactNode; disabled?: boolean; listen?: boolean; extra?: string }) {
  const cb = useRef({ onDigit, onBackspace, onSubmit, disabled }); cb.current = { onDigit, onBackspace, onSubmit, disabled };
  useEffect(() => {
    if (!listen) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (cb.current.disabled) return;
      if (/^[0-9]$/.test(e.key)) cb.current.onDigit(e.key); else if (e.key === "Backspace") cb.current.onBackspace(); else if (e.key === "Enter") cb.current.onSubmit?.(); else if (extra && e.key === extra) cb.current.onDigit(extra);
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [listen, extra]);
  return (
    <div className="keypad wide" role="group" aria-label="Number pad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} type="button" disabled={disabled} onClick={() => onDigit(d)}>{d}</button>)}
      <button type="button" aria-label="Backspace" disabled={disabled} onClick={onBackspace}>{backspaceIcon}</button>
      <button type="button" disabled={disabled} onClick={() => onDigit("0")}>0</button>
      <button type="button" aria-label={submitLabel} disabled={disabled || !onSubmit} style={{ background: "var(--volt)" }} onClick={onSubmit}>{submitIcon}</button>
    </div>
  );
}

// ---------------------------------------------------------------- DatePicker (custom popover calendar; no native date input)
const pad = (n: number) => String(n).padStart(2, "0");
export const toYmd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const fromYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, d!)); };
const addDays = (s: string, n: number) => { const d = fromYmd(s); d.setUTCDate(d.getUTCDate() + n); return toYmd(d); };
const addMonths = (s: string, n: number) => { const d = fromYmd(s); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return toYmd(d); };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const formatYmd = (s: string) => { const d = fromYmd(s); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}`; };

/** Date picker. Value is a YYYY-MM-DD string (a business date, no time zone). Arrow keys move by day/week, PageUp/PageDown by month, Home/End to week edges, Enter picks, Escape closes. */
export function DatePicker({ value, onChange, label, today, min, max, icon, prevIcon, nextIcon }: { value: string; onChange: (v: string) => void; label: string; today: string; min?: string; max?: string; icon?: ReactNode; prevIcon: ReactNode; nextIcon: ReactNode }) {
  const [open, setOpen] = useState(false); const [focus, setFocus] = useState(value); const root = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null); const grid = useRef<HTMLDivElement>(null); const id = useId();
  useEffect(() => { if (!open) return; const off = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", off); return () => document.removeEventListener("pointerdown", off); }, [open]);
  useEffect(() => { if (open) grid.current?.querySelector<HTMLButtonElement>(`[data-d="${focus}"]`)?.focus(); }, [open, focus]);
  const disabled = (d: string) => (!!min && d < min) || (!!max && d > max);
  const clamp = (d: string) => (min && d < min ? min : max && d > max ? max : d);
  const go = (d: string) => setFocus(clamp(d));          // moving past the allowed range stops at its edge
  const pick = (d: string) => { if (disabled(d)) return; onChange(d); setOpen(false); btn.current?.focus(); };
  const first = fromYmd(focus); first.setUTCDate(1); const lead = (first.getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setUTCDate(1 - lead + i); return toYmd(d); });
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key; const m: Record<string, () => void> = { ArrowLeft: () => go(addDays(focus, -1)), ArrowRight: () => go(addDays(focus, 1)), ArrowUp: () => go(addDays(focus, -7)), ArrowDown: () => go(addDays(focus, 7)), PageUp: () => go(addMonths(focus, -1)), PageDown: () => go(addMonths(focus, 1)),
      Home: () => go(addDays(focus, -((fromYmd(focus).getUTCDay() + 6) % 7))), End: () => go(addDays(focus, 6 - ((fromYmd(focus).getUTCDay() + 6) % 7))), Escape: () => { setOpen(false); btn.current?.focus(); } };
    if (m[k]) { e.preventDefault(); m[k]!(); }
  };
  return (
    <div className="select-wrap" ref={root}>
      <button ref={btn} type="button" className="select" aria-label={`${label}: ${formatYmd(value)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-cal`} onClick={() => { setFocus(value); setOpen((o) => !o); }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>{icon}{formatYmd(value)}</span>
      </button>
      {open && (
        <div className="cal" role="dialog" aria-label={`Choose ${label.toLowerCase()}`} id={`${id}-cal`} style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, marginTop: 4 }} onKeyDown={onKey}>
          <header><button type="button" className="btn ghost sm" aria-label="Previous month" onClick={() => go(addMonths(focus, -1))}>{prevIcon}</button><span aria-live="polite">{MONTHS[fromYmd(focus).getUTCMonth()]} {fromYmd(focus).getUTCFullYear()}</span><button type="button" className="btn ghost sm" aria-label="Next month" onClick={() => go(addMonths(focus, 1))}>{nextIcon}</button></header>
          <div role="grid" aria-label={`${MONTHS[fromYmd(focus).getUTCMonth()]} ${fromYmd(focus).getUTCFullYear()}`} ref={grid}>
            <div role="row" style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>{DOW.map((d) => <span role="columnheader" key={d} style={{ textAlign: "center", fontSize: 12, color: "var(--ink-3)", fontWeight: 600, padding: "4px 0" }}>{d}</span>)}</div>
            {Array.from({ length: 6 }, (_, w) => <div role="row" key={w} style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>{cells.slice(w * 7, w * 7 + 7).map((d) => {
              const out = fromYmd(d).getUTCMonth() !== fromYmd(focus).getUTCMonth();
              return <span role="gridcell" key={d} aria-selected={d === value}><button type="button" data-d={d} tabIndex={d === focus ? 0 : -1} disabled={disabled(d)} aria-label={formatYmd(d)} className={d === value ? "sel" : d === today ? "today" : out ? "out" : undefined} onClick={() => pick(d)}
                style={{ width: 38, height: 38, borderRadius: "50%", display: "grid", placeItems: "center", margin: "auto", fontFamily: "var(--f-mono)", fontSize: 13 }}>{fromYmd(d).getUTCDate()}</button></span>; })}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Drop zone for files: drag in or press to choose. The file input is hidden and driven by the button, so there is no native control on screen. */
export function DropZone({ onFiles, accept, label, hint, icon }: { onFiles: (f: File[]) => void; accept?: string; label: string; hint?: string; icon?: ReactNode }) {
  const [over, setOver] = useState(false); const input = useRef<HTMLInputElement>(null);
  return (
    <div className="drop" style={over ? { borderColor: "var(--ink)", background: "var(--volt-soft)" } : undefined}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}>
      {icon}<b>{label}</b>{hint && <span>{hint}</span>}
      <button type="button" className="btn" onClick={() => input.current?.click()}>Choose a file</button>
      <input ref={input} type="file" accept={accept} hidden aria-hidden tabIndex={-1} onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
  );
}
