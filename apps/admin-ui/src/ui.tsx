import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router-dom";
import { api, type Me } from "./api";

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="#0b5d52" />
      <circle cx="22" cy="10.5" r="5" fill="#d8ff4a" />
      <rect x="7" y="17" width="12" height="2.6" rx="1.3" fill="#fffdf7" />
      <rect x="7" y="22" width="17" height="2.6" rx="1.3" fill="#fffdf7" />
    </svg>
  );
}

// The active workspace, presented as the first nav item. With a single
// membership it is a quiet label; with more it becomes a dropdown that
// switches workspaces in place.
function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ["workspace-context"],
    queryFn: api.workspaceContext,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!data) return null;
  const active = data.workspaces.find((w) => w.active);
  const name =
    active?.org_name ||
    active?.org_slug ||
    `${data.active_org_id.slice(0, 14)}…`;
  if (data.workspaces.length < 2) {
    return (
      <span className="ws-nav ws-nav-static" title={data.active_org_id}>
        {name}
      </span>
    );
  }
  return (
    <div className="ws-menu" ref={rootRef}>
      <button
        type="button"
        className={`ws-nav${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={data.active_org_id}
        onClick={() => setOpen((value) => !value)}
      >
        {name}
        <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="currentColor" />
        </svg>
      </button>
      {open ? (
        <div className="ws-menu-panel" role="menu">
          {data.workspaces.map((workspace) =>
            workspace.switch_url ? (
              <a
                key={workspace.org_id}
                role="menuitem"
                href={workspace.switch_url}
                title={workspace.org_id}
              >
                {workspace.org_name || workspace.org_id}
                {workspace.org_slug ? (
                  <small>{workspace.org_slug}</small>
                ) : null}
              </a>
            ) : (
              <span
                key={workspace.org_id}
                className="ws-menu-current"
                title={workspace.org_id}
              >
                {workspace.org_name || workspace.org_id}
                <small>Current workspace</small>
              </span>
            ),
          )}
          <Link
            to="/admin/team#workspaces"
            onClick={() => setOpen(false)}
            className="ws-menu-manage"
          >
            Manage workspaces
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Shell({ me, children }: { me?: Me; children: ReactNode }) {
  return (
    <>
      <header className="top">
        <a className="brand" href="/">
          <Logo />
          Artifact Use
        </a>
        <nav>
          <WorkspaceMenu />
          <span className="nav-rule" aria-hidden="true" />
          {me?.superAdmin ? (
            <NavLink to="/admin/super">Super Admin</NavLink>
          ) : null}
          <NavLink to="/admin" end>
            Admin
          </NavLink>
          <NavLink to="/admin/connect">Connect an agent</NavLink>
          <NavLink to="/admin/team">Team</NavLink>
          <a href="/logout">Sign out</a>
        </nav>
      </header>
      <main className="admin">{children}</main>
    </>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  className = "copy-lite",
  icon = false,
}: {
  text: string;
  label?: string;
  className?: string;
  icon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${className}${copied ? " copied" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {!copied && icon ? (
        <svg
          className="copy-icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="8" height="9" rx="1.5" />
          <path d="M10.5 11.5v.5A1.5 1.5 0 0 1 9 13.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h2" />
        </svg>
      ) : null}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CopyBlock({
  text,
  rows,
  label,
  id,
}: {
  text: string;
  rows?: number;
  label?: string;
  id?: string;
}) {
  return (
    <div>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className="copywrap">
        <CopyButton text={text} />
        {rows ? (
          <textarea id={id} readOnly rows={rows} value={text} />
        ) : (
          <input id={id} readOnly value={text} />
        )}
      </div>
    </div>
  );
}

export function Skeleton({ style }: { style?: React.CSSProperties }) {
  return <div className="skel" style={style} />;
}

const NUM = new Intl.NumberFormat("en-US");
export function formatNumber(value: number | null | undefined): string {
  return NUM.format(Number(value || 0));
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function shortDate(day: string): string {
  const month = Number(day.slice(5, 7));
  return `${MONTHS[month - 1] || ""} ${Number(day.slice(8, 10))}`;
}

export type ChartDay = { day: string; n: number };

// Daily bar chart with y-axis ticks, x-axis date labels, and a hover tooltip.
// Expects a continuous day series (fill missing days with 0 before passing).
export function BarChart({
  days,
  height = 96,
  unit = "views",
}: {
  days: ChartDay[];
  height?: number;
  unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.n));
  const mid = Math.ceil(max / 2);
  // Label roughly weekly, always including the first and last day.
  const step = Math.max(1, Math.floor((days.length - 1) / 4));
  const xTicks = days
    .map((d, i) => ({ ...d, i }))
    .filter(
      ({ i }) =>
        i === 0 ||
        i === days.length - 1 ||
        (i % step === 0 && i <= days.length - step / 2),
    );
  const hovered = hover === null ? null : days[hover];
  return (
    <div className="chartwrap">
      <div className="chart-y" style={{ height }}>
        <span>{formatNumber(max)}</span>
        <span>{formatNumber(mid)}</span>
        <span>0</span>
      </div>
      <div className="chart-plot">
        <div className="gridline" style={{ top: 0 }} />
        <div
          className="gridline"
          style={{ top: `${100 - (mid / max) * 100}%` }}
        />
        <div
          className="chart"
          style={{ height }}
          onMouseLeave={() => setHover(null)}
        >
          {days.map((d, i) => (
            <span
              key={d.day}
              className={`${d.n ? "" : "zero"}${hover === i ? " hovered" : ""}`}
              style={{
                height: `${d.n ? Math.max(4, Math.round((d.n / max) * 100)) : 2}%`,
              }}
              onMouseEnter={() => setHover(i)}
              aria-label={`${shortDate(d.day)}: ${formatNumber(d.n)} ${unit}`}
            />
          ))}
        </div>
        {hovered ? (
          <div
            className="chart-tip"
            style={{
              left: `${Math.min(92, Math.max(8, ((hover! + 0.5) / days.length) * 100))}%`,
            }}
          >
            <strong>{formatNumber(hovered.n)}</strong> {unit} ·{" "}
            {shortDate(hovered.day)}
          </div>
        ) : null}
        <div className="chart-x">
          {xTicks.map(({ day, i }) => (
            <span
              key={day}
              style={{ left: `${((i + 0.5) / days.length) * 100}%` }}
            >
              {shortDate(day)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--)
    out.push(new Date(now - i * 86400_000).toISOString().slice(0, 10));
  return out;
}

export function fillDays(
  rows: { day: string; n: number }[],
  n: number,
): ChartDay[] {
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) || 0) + row.n);
  return lastNDays(n).map((day) => ({ day, n: byDay.get(day) || 0 }));
}

export function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function dateLabel(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
