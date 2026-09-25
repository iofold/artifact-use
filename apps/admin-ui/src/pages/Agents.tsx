import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  api,
  type EventClient,
  type EventError,
  type EventFailure,
  type EventTool,
} from "../api";
import {
  Shell,
  Skeleton,
  ago,
  dateLabel,
  formatNumber,
  formatRate,
} from "../ui";

// The mcp_events table arrived with the 2026-09-25 deploy; calls before that
// were never recorded, so an empty page is not the same as an idle agent.
const EVENTS_SINCE = "2026-09-25";
const MAX_FAILURES = 50;

// Plain-language hints for the error codes an operator can act on here.
const ERROR_HINTS: Record<string, string> = {
  token_expired: "The agent's token reached its expiry — mint a new one.",
  token_revoked: "The agent's token was revoked — mint a new one.",
};

export function useAgentEvents() {
  return useQuery({ queryKey: ["events"], queryFn: api.events });
}

function isoTime(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toISOString() : "";
}

function millis(value: number | null | undefined): string {
  return value == null ? "—" : `${formatNumber(Math.round(value))} ms`;
}

function failedTitle(failures: number, calls: number): string {
  return `${formatNumber(failures)} of ${formatNumber(calls)} calls failed`;
}

export default function Agents() {
  const { data, isPending, error } = useAgentEvents();

  if (error) {
    return (
      <Shell>
        <section className="headline">
          <div>
            <p className="eyebrow">Agent activity</p>
            <h1>Agents</h1>
          </div>
        </section>
        <div className="empty error-box agents-empty" role="alert">
          <strong>Could not load agent activity.</strong>
          <span>{error.message}</span>
        </div>
      </Shell>
    );
  }
  if (isPending || !data) {
    return (
      <Shell>
        <section className="headline">
          <div>
            <p className="eyebrow">Agent activity</p>
            <h1>Agents</h1>
            <Skeleton style={{ height: 14, width: 260 }} />
          </div>
          <Skeleton style={{ height: 64, width: 320 }} />
        </section>
        <Skeleton style={{ height: 180, marginTop: 26 }} />
        <Skeleton style={{ height: 180, marginTop: 26 }} />
        <Skeleton style={{ height: 220, marginTop: 26 }} />
      </Shell>
    );
  }

  const calls = data.clients.reduce((sum, row) => sum + row.calls, 0);
  const failures = data.clients.reduce((sum, row) => sum + row.failures, 0);
  const clientCount = data.clients.length;

  return (
    <Shell>
      <section className="headline">
        <div>
          <p className="eyebrow">Agent activity</p>
          <h1>Agents</h1>
          <p className="muted">
            {formatNumber(calls)} MCP {calls === 1 ? "call" : "calls"} ·{" "}
            <span title={failedTitle(failures, calls)}>
              {formatRate(failures, calls)} failed
            </span>{" "}
            · {formatNumber(clientCount)}{" "}
            {clientCount === 1 ? "client" : "clients"} · last 7 days, since{" "}
            {dateLabel(data.since)}
            {data.superAdmin
              ? " · includes calls that reached no workspace (super admin)"
              : ""}
          </p>
        </div>
        <div className="metrics">
          <div>
            <strong>{formatNumber(calls)}</strong>
            <span>Calls · 7d</span>
          </div>
          <div>
            <strong title={failedTitle(failures, calls)}>
              {formatRate(failures, calls)}
            </strong>
            <span>Failure rate</span>
          </div>
          <div>
            <strong>{formatNumber(clientCount)}</strong>
            <span>Clients</span>
          </div>
        </div>
      </section>
      {calls === 0 ? (
        <div className="empty agents-empty">
          <strong>No agent calls in the last 7 days.</strong>
          <span>
            Events have been recorded since {EVENTS_SINCE}; calls made before
            that date do not appear here. Connect an agent from{" "}
            <Link to="/admin/connect">Connect an agent</Link> and its calls will
            show up within a few seconds.
          </span>
        </div>
      ) : null}
      <ClientsTable clients={data.clients} superAdmin={data.superAdmin} />
      <div className="agents-grid">
        <ToolsTable tools={data.tools} />
        <ErrorCodes errors={data.errors} />
      </div>
      <RecentFailures failures={data.recentFailures} />
    </Shell>
  );
}

function ClientsTable({
  clients,
  superAdmin,
}: {
  clients: EventClient[];
  superAdmin: boolean;
}) {
  return (
    <section className="agents-section" aria-label="Clients">
      <h2>Clients</h2>
      <p className="mini section-note">
        Each harness that called the MCP endpoint, by the client name it
        announced on initialize.
      </p>
      {clients.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Version</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th className="num">Avg</th>
                {superAdmin ? (
                  <th
                    className="num"
                    title="Calls that carried no valid workspace credential: expired tokens, OAuth retry loops"
                  >
                    Unauth.
                  </th>
                ) : null}
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((row) => (
                <tr key={row.client}>
                  <td>
                    <strong>{row.client}</strong>
                  </td>
                  <td>{row.version ? <code>{row.version}</code> : "—"}</td>
                  <td className="num">{formatNumber(row.calls)}</td>
                  <td
                    className={`num${row.failures ? " fail" : ""}`}
                    title={failedTitle(row.failures, row.calls)}
                  >
                    {formatRate(row.failures, row.calls)}
                  </td>
                  <td className="num">{millis(row.avg_ms)}</td>
                  {superAdmin ? (
                    <td className="num">
                      {row.unauthenticated
                        ? formatNumber(row.unauthenticated)
                        : "—"}
                    </td>
                  ) : null}
                  <td className="when">
                    <time
                      dateTime={isoTime(row.last_seen)}
                      title={isoTime(row.last_seen)}
                    >
                      {ago(row.last_seen)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty small-empty">No clients in this window.</div>
      )}
    </section>
  );
}

function ToolsTable({ tools }: { tools: EventTool[] }) {
  return (
    <section className="agents-section" aria-label="Tools">
      <h2>Tools</h2>
      <p className="mini section-note">
        What the agents asked for. Rows without a tool are protocol calls
        (initialize, tools/list) recorded by method.
      </p>
      {tools.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th className="num">Avg</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((row) => (
                <tr key={`${row.tool}:${row.action || ""}`}>
                  <td>
                    <code>{row.tool}</code>
                    {row.action ? <small>{row.action}</small> : null}
                  </td>
                  <td className="num">{formatNumber(row.calls)}</td>
                  <td
                    className={`num${row.failures ? " fail" : ""}`}
                    title={failedTitle(row.failures, row.calls)}
                  >
                    {formatRate(row.failures, row.calls)}
                  </td>
                  <td className="num">{millis(row.avg_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty small-empty">No tool calls in this window.</div>
      )}
    </section>
  );
}

function ErrorCodes({ errors }: { errors: EventError[] }) {
  return (
    <section className="agents-section" aria-label="Error codes">
      <h2>Error codes</h2>
      <p className="mini section-note">
        Failed calls in the last 7 days, by the error code returned.
      </p>
      {errors.length ? (
        <ul className="code-list">
          {errors.map((row) => {
            const hint = ERROR_HINTS[row.error_code];
            return (
              <li key={row.error_code}>
                <span>
                  <code>{row.error_code}</code>
                  {hint ? (
                    <small>
                      {hint} <Link to="/admin/connect">Connect an agent</Link>
                    </small>
                  ) : null}
                </span>
                <span className="num">{formatNumber(row.n)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty small-empty">No failures in this window.</div>
      )}
    </section>
  );
}

function RecentFailures({ failures }: { failures: EventFailure[] }) {
  const rows = failures.slice(0, MAX_FAILURES);
  return (
    <section className="agents-section" aria-label="Recent failures">
      <h2>Recent failures</h2>
      <p className="mini section-note">
        The latest {MAX_FAILURES} failed calls, newest first.
      </p>
      {rows.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Client</th>
                <th>Tool</th>
                <th className="num">Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.ts}-${i}`}>
                  <td className="when">
                    <time dateTime={isoTime(row.ts)} title={isoTime(row.ts)}>
                      {ago(row.ts)}
                    </time>
                  </td>
                  <td>
                    {row.client || "unknown"}
                    {row.client_version || row.auth_kind ? (
                      <small>
                        {[row.client_version, row.auth_kind]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <code>{row.tool || row.method}</code>
                    {row.action ? <small>{row.action}</small> : null}
                  </td>
                  <td className="num">{row.status ?? "—"}</td>
                  <td>
                    <code className="fail">{row.error_code || "unknown"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty small-empty">
          No failed calls in the last 7 days. Events have been recorded since{" "}
          {EVENTS_SINCE}, so earlier failures do not appear here.
        </div>
      )}
    </section>
  );
}
