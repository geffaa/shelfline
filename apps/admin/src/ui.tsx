import { type ReactNode } from "react";
import { Chip } from "@shelfline/ui";
import { flagLabel } from "./lib/format";

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return <div className="ph"><div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>{actions && <div className="toolbar">{actions}</div>}</div>;
}
export function Panel({ title, right, children, flush, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return <section className={`panel ${className ?? ""}`}>{(title || right) && <header><h2>{title}</h2>{right}</header>}{flush ? children : <div className="pb">{children}</div>}</section>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) { return <div className="empty"><h3>{title}</h3>{children && <p style={{ margin: 0 }}>{children}</p>}{action}</div>; }
export function Skeleton({ rows = 4 }: { rows?: number }) { return <div className="pb stack" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div className="skeleton" key={i} style={{ width: `${90 - i * 9}%` }} />)}</div>; }
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) { return <div className="callout danger" role="alert"><div><b>Something went wrong.</b> {(error as Error)?.message ?? "Please try again."}</div>{retry && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={retry}>Retry</button>}</div>; }
export const FlagChips = ({ flags }: { flags: string[] }) => <span className="pill-row">{flags.map((f) => <Chip key={f} tone="warn">{flagLabel(f)}</Chip>)}</span>;
export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) { return <div className="field-in"><label htmlFor={id}>{label}</label>{children}{hint && <span className="muted" style={{ fontSize: 12.5 }}>{hint}</span>}</div>; }
export function TextInput({ id, value, onChange, ...p }: { id: string; value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "id">) { return <div className="input"><input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...p} /></div>; }
