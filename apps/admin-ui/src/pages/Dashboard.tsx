import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  postForm,
  type ArtifactRow,
  type DailyRow,
  type Overview,
} from "../api";
import {
  BarChart,
  CopyButton,
  Shell,
  Skeleton,
  ago,
  dateLabel,
  fillDays,
  formatBytes,
  formatNumber,
} from "../ui";

const GATE_LEVELS = ["public", "email", "verified_email", "allowlist"];

export default function Dashboard() {
  const { data, isPending } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
  });
  const [params, setParams] = useSearchParams();
  const openId = params.get("open") || "";
  const openArtifact =
    (openId && data?.artifacts.find((a) => a.id === openId)) || null;
  const closeSheet = () => {
    params.delete("open");
    setParams(params, { replace: true });
  };

  if (isPending || !data) {
    return (
      <Shell>
        <section className="headline">
          <div>
            <p className="eyebrow">Publisher admin</p>
            <h1>Artifacts</h1>
            <Skeleton style={{ height: 14, width: 180 }} />
          </div>
          <Skeleton style={{ height: 64, width: 420 }} />
        </section>
        <Skeleton style={{ height: 60, marginTop: 24 }} />
        <Skeleton style={{ height: 160, marginTop: 22 }} />
        <Skeleton style={{ height: 300, marginTop: 28 }} />
      </Shell>
    );
  }

  const hasArtifacts = data.artifacts.length > 0;
  return (
    <Shell me={data.me}>
      <section className="headline">
        <div>
          <p className="eyebrow">Publisher admin</p>
          <h1>Artifacts</h1>
          <p className="muted">
            {data.me.email || data.me.name || data.me.sub}
          </p>
        </div>
        {hasArtifacts ? <Metrics data={data} /> : null}
      </section>
      {hasArtifacts ? (
        <>
          <ConnectStrip data={data} />
          <ActivityChart daily={data.daily} />
          <ArtifactTable
            artifacts={data.artifacts}
            daily={data.daily}
            openId={openId}
            onOpen={(id) => setParams({ open: id })}
          />
        </>
      ) : (
        <Onboarding docsUrl={data.site.docsUrl} />
      )}
      {data.recent.length ? (
        <section className="activity">
          <p className="eyebrow">Recent activity</p>
          <h2>Latest views</h2>
          <ul className="activity-feed">
            {data.recent.slice(0, 18).map((view, i) => (
              <li key={i}>
                <span>
                  <strong>{view.email}</strong>
                  <small>{view.title || view.url_key || view.slug}</small>
                </span>
                <time>{ago(view.ts)}</time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {openArtifact ? (
        <ArtifactSheet artifact={openArtifact} onClose={closeSheet} />
      ) : null}
    </Shell>
  );
}

function Metrics({ data }: { data: Overview }) {
  return (
    <div className="metrics">
      <div>
        <strong>{formatNumber(data.artifacts.length)}</strong>
        <span>Artifacts</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.views)}</strong>
        <span>Views</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.viewers)}</strong>
        <span>Viewers</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.views7d)}</strong>
        <span>Views · 7d</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.feedback)}</strong>
        <span>Comments</span>
      </div>
    </div>
  );
}

function ConnectStrip({ data }: { data: Overview }) {
  return (
    <section className="connect-strip" aria-label="Register a new agent">
      <div>
        <strong>Register a new agent</strong>
        <span className="muted">
          Start with the visible setup prompt. OAuth MCP clients can also
          connect at <code>{data.site.mcpUrl}</code>; device codes are a
          fallback.
        </span>
      </div>
      <div className="strip-actions">
        <Link className="button small" to="/admin/connect">
          View setup prompt
        </Link>
        <Link
          className="button small ghost"
          to="/admin/connect#device-approval"
        >
          Approve device code
        </Link>
        <a className="button small ghost" href={data.site.docsUrl}>
          Docs
        </a>
      </div>
    </section>
  );
}

function ActivityChart({ daily }: { daily: DailyRow[] }) {
  const days = useMemo(() => fillDays(daily, 30), [daily]);
  const total = days.reduce((sum, d) => sum + d.n, 0);
  return (
    <section className="activity-viz" aria-label="Views over the last 30 days">
      <div className="viz-head">
        <p className="eyebrow">Activity</p>
        <span className="muted">
          {formatNumber(total)} views · last 30 days
        </span>
      </div>
      <BarChart days={days} height={96} />
    </section>
  );
}

function weekViews(daily: DailyRow[], artifactId: string): number {
  const cutoff = new Date(Date.now() - 7 * 86400_000)
    .toISOString()
    .slice(0, 10);
  return daily
    .filter((row) => row.artifact_id === artifactId && row.day >= cutoff)
    .reduce((sum, row) => sum + row.n, 0);
}

function ArtifactTable({
  artifacts,
  daily,
  openId,
  onOpen,
}: {
  artifacts: ArtifactRow[];
  daily: DailyRow[];
  openId: string;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = artifacts.filter(
    (a) =>
      !q ||
      `${a.title} ${a.url_key} ${a.gate_level} ${a.status}`
        .toLowerCase()
        .includes(q),
  );
  return (
    <section className="artifacts" aria-label="Artifacts">
      <div className="art-toolbar">
        <h2>
          Artifacts{" "}
          <span className="pill">{formatNumber(artifacts.length)}</span>
        </h2>
        <input
          type="search"
          placeholder="Search title, slug, gate…"
          aria-label="Search artifacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="art-table">
        <div className="art-head">
          <span>Artifact</span>
          <span className="art-gate">Gate</span>
          <span className="num">Views</span>
          <span className="num art-7d">7d</span>
          <span className="num art-fb">Comments</span>
          <span className="art-date">Updated</span>
        </div>
        {rows.map((artifact) => {
          const views7 = weekViews(daily, artifact.id);
          return (
            <button
              type="button"
              key={artifact.id}
              className={`art-tr${openId === artifact.id ? " active" : ""}`}
              onClick={() => onOpen(artifact.id)}
            >
              <span className="art-name">
                <strong>{artifact.title}</strong>
                <small>{artifact.path}</small>
              </span>
              <span className="art-gate">
                <span className="pill">{artifact.gate_level}</span>
                {artifact.status === "suspended" || artifact.org_suspended ? (
                  <span className="pill danger">Suspended</span>
                ) : null}
              </span>
              <span className="num">{formatNumber(artifact.total_views)}</span>
              <span className="num art-7d">
                {views7 ? formatNumber(views7) : "—"}
              </span>
              <span className="num art-fb">
                {formatNumber(artifact.comment_count)}
                {artifact.open_comments ? (
                  <em> ({formatNumber(artifact.open_comments)} open)</em>
                ) : null}
              </span>
              <span className="art-date">{ago(artifact.updated_at)}</span>
            </button>
          );
        })}
        {!rows.length ? (
          <p className="mini art-none">No artifacts match this search.</p>
        ) : null}
      </div>
    </section>
  );
}

function Onboarding({ docsUrl }: { docsUrl: string }) {
  return (
    <div className="onboard">
      <p className="eyebrow">First artifact</p>
      <h2>Connect an agent and publish something.</h2>
      <ol>
        <li>
          <strong>Connect an agent</strong>Open the visible setup prompt and
          paste it into your agent. It carries a scoped publish token, so the
          agent can publish here immediately.
        </li>
        <li>
          <strong>Ask for an artifact</strong>"Publish this prototype with an
          email gate." The agent gets back a stable link.
        </li>
        <li>
          <strong>Share and review</strong>Send the link around; views and
          comments land back here and in your agent's API.
        </li>
      </ol>
      <div className="actions">
        <Link className="button" to="/admin/connect">
          View setup prompt
        </Link>
        <a className="button ghost" href={docsUrl}>
          Read the docs
        </a>
      </div>
    </div>
  );
}

function ArtifactSheet({
  artifact,
  onClose,
}: {
  artifact: ArtifactRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: detail, isPending } = useQuery({
    queryKey: ["artifact-detail", artifact.id],
    queryFn: () => api.artifactDetail(artifact.id),
  });
  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
  });
  const daily = (overview?.daily || []).filter(
    (row) => row.artifact_id === artifact.id,
  );
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({
      queryKey: ["artifact-detail", artifact.id],
    });
  };
  const gateMutation = useMutation({
    mutationFn: (gate: string) =>
      postForm("/admin/artifact/access", {
        artifact_key: artifact.url_key,
        gate_level: gate,
      }),
    onSettled: invalidate,
  });
  const [gate, setGate] = useState(artifact.gate_level);
  const [preview, setPreview] = useState({
    title: artifact.title,
    description: artifact.description || "",
  });
  useEffect(() => {
    setPreview({
      title: artifact.title,
      description: artifact.description || "",
    });
  }, [artifact.id, artifact.title, artifact.description]);
  const previewMutation = useMutation({
    mutationFn: () =>
      postForm("/admin/artifact/preview", {
        artifact_key: artifact.url_key,
        title: preview.title,
        description: preview.description,
      }),
    onSettled: invalidate,
  });
  const [allowlist, setAllowlist] = useState(artifact.allowlist_lines);
  const allowlistMutation = useMutation({
    mutationFn: () =>
      postForm("/admin/artifact/access", {
        artifact_key: artifact.url_key,
        gate_level: "allowlist",
        allowlist_lines: allowlist,
      }),
    onSettled: invalidate,
  });
  const [share, setShare] = useState({ email: "", label: "", days: "" });
  const shareMutation = useMutation({
    mutationFn: () =>
      postForm("/admin/artifact/share-link", {
        artifact_key: artifact.url_key,
        recipient_email: share.email,
        recipient_label: share.label,
        expires_days: share.days,
      }),
    onSuccess: () => setShare({ email: "", label: "", days: "" }),
    onSettled: invalidate,
  });
  const revokeShare = useMutation({
    mutationFn: (id: string) =>
      postForm("/admin/artifact/share-link/revoke", { id }),
    onSettled: invalidate,
  });
  // Play the exit animation before unmounting.
  const [leaving, setLeaving] = useState(false);
  const requestClose = () => {
    setLeaving(true);
    setTimeout(onClose, 170);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const recentViews = (overview?.recent || [])
    .filter((view) => view.artifact_id === artifact.id)
    .slice(0, 8);
  const unavailable =
    artifact.status === "suspended"
      ? "This artifact is suspended"
      : artifact.org_suspended
        ? "This workspace is suspended"
        : "";

  return (
    <>
      <button
        className={`sheet-scrim${leaving ? " leaving" : ""}`}
        aria-label="Close details"
        onClick={requestClose}
      />
      <aside
        className={`sheet${leaving ? " leaving" : ""}`}
        role="dialog"
        aria-label={`${artifact.title} details`}
      >
        <header className="sheet-head">
          <div>
            <h2>{artifact.title}</h2>
            <code>{artifact.path}</code>
          </div>
          <button
            type="button"
            className="sheet-close"
            onClick={requestClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="sheet-body">
          {unavailable ? (
            <div className="moderation-notice" role="status">
              <strong>{unavailable}</strong>
              <span>
                Public serving is disabled, but owner metadata remains visible.
                Contact <a href="mailto:hello@iofold.com">hello@iofold.com</a>{" "}
                if you believe this is a mistake.
              </span>
            </div>
          ) : null}
          <div className="sheet-actions">
            <a
              className="button small"
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open artifact ↗
            </a>
            <div className="access-control">
              <label htmlFor={`artifact-access-${artifact.id}`}>Access</label>
              <div className="access">
                <select
                  id={`artifact-access-${artifact.id}`}
                  value={gate}
                  onChange={(e) => setGate(e.target.value)}
                >
                  {GATE_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="small"
                  disabled={gateMutation.isPending}
                  onClick={() => gateMutation.mutate(gate)}
                >
                  {gateMutation.isPending ? "Saving…" : "Update"}
                </button>
              </div>
            </div>
          </div>
          <h3>Link preview</h3>
          <section className="preview-editor">
            <a
              className="preview-card-link"
              href={artifact.preview_image_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open link-preview image"
            >
              <img
                src={artifact.preview_image_url}
                alt={`Link preview for ${artifact.title}`}
              />
            </a>
            <p className="preview-note">
              This title, summary, and image are public—even when access to the
              artifact is gated.
            </p>
            <form
              className="preview-form"
              onSubmit={(event) => {
                event.preventDefault();
                previewMutation.mutate();
              }}
            >
              <label>
                <span>Title</span>
                <input
                  required
                  maxLength={160}
                  value={preview.title}
                  onChange={(event) =>
                    setPreview({ ...preview, title: event.target.value })
                  }
                />
              </label>
              <label>
                <span>
                  Summary <small>{preview.description.length}/200</small>
                </span>
                <textarea
                  rows={4}
                  maxLength={200}
                  placeholder="A short, inviting description of this artifact."
                  value={preview.description}
                  onChange={(event) =>
                    setPreview({ ...preview, description: event.target.value })
                  }
                />
              </label>
              <button
                type="submit"
                disabled={previewMutation.isPending || !preview.title.trim()}
              >
                {previewMutation.isPending ? "Saving…" : "Save preview"}
              </button>
            </form>
          </section>
          <div className="sheet-stats">
            <div>
              <strong>{formatNumber(artifact.total_views)}</strong>
              <span>Views</span>
            </div>
            <div>
              <strong>{formatNumber(artifact.unique_viewers)}</strong>
              <span>Viewers</span>
            </div>
            <div>
              <strong>{formatNumber(artifact.comment_count)}</strong>
              <span>Comments</span>
            </div>
            <div>
              <strong>{formatBytes(artifact.total_size)}</strong>
              <span>{formatNumber(artifact.file_count)} files</span>
            </div>
          </div>
          <h3>Views · last 30 days</h3>
          {daily.length ? (
            <BarChart days={fillDays(daily, 30)} height={64} />
          ) : (
            <div className="empty small-empty">No views in this window.</div>
          )}
          <p className="mini">
            Last view {ago(artifact.last_view_ts)} · published{" "}
            {dateLabel(artifact.completed_at)}
          </p>
          {recentViews.length ? (
            <>
              <h3>Recent viewers</h3>
              <ul className="detail-list">
                {recentViews.map((view, i) => (
                  <li key={i}>
                    <span>
                      <strong>{view.email}</strong>
                    </span>
                    <time>{ago(view.ts)}</time>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>Share links</h3>
          {isPending ? (
            <Skeleton style={{ height: 46 }} />
          ) : detail?.shares.length ? (
            <ul className="detail-list links-list">
              {detail.shares.slice(0, 8).map((link) => (
                <li key={link.id}>
                  <span>
                    <strong>
                      {link.recipient_label ||
                        link.recipient_email ||
                        "Unlabeled link"}
                    </strong>
                    <small>
                      {formatNumber(link.view_count)} views · {link.state} ·{" "}
                      {link.url}
                    </small>
                  </span>
                  {link.state === "revoked" ? (
                    <span className="pill">Revoked</span>
                  ) : (
                    <button
                      type="button"
                      className="button small ghost danger"
                      onClick={() => revokeShare.mutate(link.id)}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty small-empty">No share links.</div>
          )}
          <form
            className="share-create"
            onSubmit={(e) => {
              e.preventDefault();
              shareMutation.mutate();
            }}
          >
            <input
              type="email"
              placeholder="email"
              value={share.email}
              onChange={(e) => setShare({ ...share, email: e.target.value })}
            />
            <input
              placeholder="label"
              value={share.label}
              onChange={(e) => setShare({ ...share, label: e.target.value })}
            />
            <input
              placeholder="days"
              inputMode="numeric"
              value={share.days}
              onChange={(e) => setShare({ ...share, days: e.target.value })}
            />
            <button type="submit" disabled={shareMutation.isPending}>
              {shareMutation.isPending ? "Creating…" : "Create link"}
            </button>
          </form>
          <h3>Comments</h3>
          {isPending ? (
            <Skeleton style={{ height: 46 }} />
          ) : detail?.comments.length ? (
            <ul className="detail-list">
              {detail.comments.slice(0, 8).map((comment) => (
                <li key={comment.id}>
                  <span>
                    <strong>{comment.email}</strong>
                    <small>{comment.body}</small>
                  </span>
                  <time>
                    {comment.resolved_at ? "resolved" : ago(comment.created_at)}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty small-empty">No comments yet.</div>
          )}
          <h3>Allowlist</h3>
          <form
            className="allowlist-form"
            onSubmit={(e) => {
              e.preventDefault();
              allowlistMutation.mutate();
            }}
          >
            <textarea
              rows={5}
              placeholder={"acme.com\njane@acme.com"}
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
            />
            <button type="submit" disabled={allowlistMutation.isPending}>
              {allowlistMutation.isPending ? "Saving…" : "Save allowlist"}
            </button>
          </form>
          <h3>Public URL</h3>
          <div className="copywrap">
            <CopyButton text={artifact.url} />
            <input readOnly value={artifact.url} />
          </div>
        </div>
      </aside>
    </>
  );
}
