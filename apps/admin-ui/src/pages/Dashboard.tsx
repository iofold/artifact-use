import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  api,
  postForm,
  type ArtifactRow,
  type ArtifactVersion,
  type DailyRow,
  type Me,
  type Overview,
  type RecentView,
} from "../api";
import { SharePanel } from "../share";
import {
  BarChart,
  Shell,
  Skeleton,
  ago,
  dateLabel,
  fillDays,
  formatBytes,
  formatNumber,
} from "../ui";

// The name your comments show viewers: the one you set, else your email's
// prefix. Shared with the widget's "Commenting as" line.
function CommentName({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.setDisplayName(value.trim()),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  if (!me.email || !me.display_name) return null;
  const prefix = me.email.split("@")[0] || "";
  if (!editing)
    return (
      <p className="muted comment-name">
        Comments show you as <strong>{me.display_name}</strong> ·{" "}
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setValue(me.display_name_set ? me.display_name || "" : "");
            setEditing(true);
          }}
        >
          Change
        </button>
      </p>
    );
  return (
    <form
      className="comment-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label htmlFor="comment-name">Your name on comments</label>
      <div>
        <input
          id="comment-name"
          value={value}
          placeholder={prefix}
          maxLength={60}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          className="button small"
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
      <p className="mini">
        {save.isError
          ? "Names are up to 60 characters and can't contain @."
          : `Leave it empty to show ${prefix}.`}
      </p>
    </form>
  );
}

// How a recorded view identified itself: proven, vouched for by a link,
// anonymous on a public artifact, or typed into the plain email gate. A
// non-human kind (a coding agent, or headless / scripted automation) is
// shown before the identity: it is not a person looking.
function ViewerBadge({
  view,
}: {
  view: Pick<RecentView, "verified" | "via_link" | "kind" | "source">;
}) {
  const kind =
    view.kind === "agent" ? (
      <span className="pill kind-agent">agent</span>
    ) : view.kind === "automation" ? (
      <span className="pill kind-automation">automation</span>
    ) : null;
  const identity = view.verified ? (
    <span className="pill ok">verified</span>
  ) : view.via_link ? (
    <span className="pill">via link</span>
  ) : view.source === "public" ? (
    <span className="pill public">public</span>
  ) : (
    <span className="pill self-reported">self-reported</span>
  );
  return (
    <>
      {kind}
      {kind ? " " : null}
      {identity}
    </>
  );
}

// Public views asked nothing of the viewer; the row holds an IP hash, which
// is not a name.
function viewerName(view: Pick<RecentView, "email" | "source">): string {
  if (view.source === "public" || view.email.startsWith("public:"))
    return "Anonymous visitor";
  return view.email;
}

type ViewSeries = "people" | "agents";

// People are the headline; the agents series (coding agents plus
// automation) is one click away so it is never mistaken for an audience.
function SeriesToggle({
  series,
  onChange,
}: {
  series: ViewSeries;
  onChange: (series: ViewSeries) => void;
}) {
  return (
    <span className="viz-toggle" role="group" aria-label="Chart series">
      {(["people", "agents"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={series === value}
          onClick={() => onChange(value)}
        >
          {value}
        </button>
      ))}
    </span>
  );
}

function seriesRows(daily: DailyRow[], series: ViewSeries) {
  return daily.map((row) => ({ day: row.day, n: row[series] }));
}

type SortKey = "title" | "views" | "views7" | "comments" | "published";

// Natural first-click direction per column: text ascends, numbers and
// recency descend. Clicking the active column flips it.
const SORT_DIRS: Record<SortKey, 1 | -1> = {
  title: 1,
  views: -1,
  views7: -1,
  comments: -1,
  published: -1,
};

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
          <CommentName me={data.me} />
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
                  <strong>
                    {viewerName(view)} <ViewerBadge view={view} />
                  </strong>
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
        <strong>{formatNumber(data.totals.views_people)}</strong>
        <span>Views · people</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.unique_people)}</strong>
        <span>People</span>
      </div>
      <div>
        <strong>{formatNumber(data.totals.views7d_people)}</strong>
        <span>People · 7d</span>
      </div>
      <div
        className="metric-agents"
        title="Coding agents, headless browsers, scripts and link unfurlers. Never counted as people."
      >
        <strong>{formatNumber(data.totals.views_agents)}</strong>
        <span>Agent reads</span>
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
  const [series, setSeries] = useState<ViewSeries>("people");
  const days = useMemo(
    () => fillDays(seriesRows(daily, series), 30),
    [daily, series],
  );
  const total = days.reduce((sum, d) => sum + d.n, 0);
  const unit = series === "people" ? "views by people" : "agent reads";
  return (
    <section className="activity-viz" aria-label="Views over the last 30 days">
      <div className="viz-head">
        <p className="eyebrow">Activity</p>
        <span className="muted viz-meta">
          {formatNumber(total)} {unit} · last 30 days
          <SeriesToggle series={series} onChange={setSeries} />
        </span>
      </div>
      <BarChart days={days} height={96} unit={unit} />
    </section>
  );
}

// Views by people in the last seven days, per artifact.
function weekViewsByArtifact(daily: DailyRow[]): Map<string, number> {
  const cutoff = new Date(Date.now() - 7 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const views = new Map<string, number>();
  for (const row of daily)
    if (row.day >= cutoff)
      views.set(
        row.artifact_id,
        (views.get(row.artifact_id) || 0) + row.people,
      );
  return views;
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      className={`art-sort${className ? ` ${className}` : ""}${active ? " active" : ""}`}
      aria-label={`Sort by ${label}`}
      aria-pressed={active}
      onClick={() => onSort(k)}
    >
      {label}
      {active ? <i aria-hidden="true">{sort.dir === -1 ? "↓" : "↑"}</i> : null}
    </button>
  );
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
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "published",
    dir: -1,
  });
  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: SORT_DIRS[key] },
    );
  const views7 = useMemo(() => weekViewsByArtifact(daily), [daily]);
  const q = query.trim().toLowerCase();
  const compare = (a: ArtifactRow, b: ArtifactRow): number => {
    switch (sort.key) {
      case "title":
        return a.title.localeCompare(b.title);
      case "views":
        return a.views_people - b.views_people;
      case "views7":
        return (views7.get(a.id) || 0) - (views7.get(b.id) || 0);
      case "comments":
        return a.comment_count - b.comment_count;
      case "published":
        return (a.completed_at || 0) - (b.completed_at || 0);
    }
  };
  const rows = artifacts
    .filter(
      (a) =>
        !q ||
        `${a.title} ${a.url_key} ${a.gate_level} ${a.status}`
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => sort.dir * compare(a, b) || b.updated_at - a.updated_at);
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
          <SortHeader
            label="Artifact"
            k="title"
            sort={sort}
            onSort={toggleSort}
          />
          <span className="art-gate">Gate</span>
          <SortHeader
            className="num"
            label="People"
            k="views"
            sort={sort}
            onSort={toggleSort}
          />
          <SortHeader
            className="num art-7d"
            label="7d"
            k="views7"
            sort={sort}
            onSort={toggleSort}
          />
          <SortHeader
            className="num art-fb"
            label="Comments"
            k="comments"
            sort={sort}
            onSort={toggleSort}
          />
          <SortHeader
            className="art-date"
            label="Published"
            k="published"
            sort={sort}
            onSort={toggleSort}
          />
        </div>
        {rows.map((artifact) => {
          const weekly = views7.get(artifact.id) || 0;
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
              <span
                className="num"
                title={
                  artifact.views_agents
                    ? `${formatNumber(artifact.views_people)} views by people; ${formatNumber(artifact.views_agents)} by agents or automation`
                    : undefined
                }
              >
                {formatNumber(artifact.views_people)}
                {artifact.views_agents ? (
                  <small className="split">
                    {" "}
                    +{formatNumber(artifact.views_agents)} agent
                  </small>
                ) : null}
              </span>
              <span className="num art-7d">
                {weekly ? formatNumber(weekly) : "—"}
              </span>
              <span className="num art-fb">
                {formatNumber(artifact.comment_count)}
                {artifact.open_comments ? (
                  <em> ({formatNumber(artifact.open_comments)} open)</em>
                ) : null}
              </span>
              <span className="art-date">
                {artifact.completed_at ? ago(artifact.completed_at) : "—"}
              </span>
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

// What a publish changed in files ("2 files modified", "3 files: 1 added,
// 2 modified"), for versions published without a note.
function changesLabel(changes: ArtifactVersion["changes"]): string {
  if (!changes) return "First version";
  const parts: [number, string][] = [
    [changes.added, "added"],
    [changes.changed, "modified"],
    [changes.removed, "removed"],
  ];
  const present = parts.filter(([n]) => n > 0);
  const total = present.reduce((sum, [n]) => sum + n, 0);
  const files = `${total} ${total === 1 ? "file" : "files"}`;
  if (!present.length) return "No file changes";
  if (present.length === 1) return `${files} ${present[0]![1]}`;
  return `${files}: ${present.map(([n, verb]) => `${n} ${verb}`).join(", ")}`;
}

// One published version: what changed (the publishing agent's note, or the
// file counts when it left none), when, whether the stable URL serves it, and
// the two things a publisher does with an old one — open it at its own URL
// or make it current again.
function VersionRow({
  version,
  promoting,
  onPromote,
}: {
  version: ArtifactVersion;
  promoting: boolean;
  onPromote: () => void;
}) {
  const when = version.completed_at || version.created_at;
  const detail = [
    `${dateLabel(when)} · ${ago(when)}`,
    version.change_note ? changesLabel(version.changes) : null,
    `${formatNumber(version.file_count)} ${version.file_count === 1 ? "file" : "files"}`,
    formatBytes(version.total_size),
    version.entrypoint !== "index.html" ? version.entrypoint : null,
    version.id,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <span>
        <strong className={version.change_note ? undefined : "version-auto"}>
          {version.change_note || changesLabel(version.changes)}
          {version.current ? <span className="pill ok">current</span> : null}
        </strong>
        <small>{detail}</small>
      </span>
      <span className="link-actions">
        <a
          className="button small ghost"
          href={version.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open ↗
        </a>
        {version.current ? null : (
          <button
            type="button"
            className="button small ghost"
            disabled={promoting}
            onClick={onPromote}
          >
            Make current
          </button>
        )}
      </span>
    </li>
  );
}

function VersionsPanel({
  artifact,
  onChanged,
}: {
  artifact: ArtifactRow;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ["artifact-versions", artifact.id],
    queryFn: () => api.artifactVersions(artifact.url_key),
  });
  const promote = useMutation({
    mutationFn: (versionId: string) =>
      api.promoteVersion(artifact.url_key, versionId),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["artifact-versions", artifact.id],
      });
      onChanged();
    },
  });
  return (
    <>
      <h3>Versions</h3>
      <p className="mini">
        Every publish is kept, with the publishing agent&apos;s note on what it
        changed. The stable URL serves the current version; making an older one
        current rolls back without deleting anything. Older versions open at
        their own URL for your workspace only — viewers always get the current
        one.
      </p>
      {isPending ? (
        <Skeleton style={{ height: 46 }} />
      ) : data?.versions.length ? (
        <ul className="detail-list versions-list">
          {data.versions.slice(0, 20).map((version) => (
            <VersionRow
              key={version.id}
              version={version}
              promoting={promote.isPending}
              onPromote={() => promote.mutate(version.id)}
            />
          ))}
        </ul>
      ) : (
        <div className="empty small-empty">No published versions yet.</div>
      )}
      {promote.isError ? (
        <p className="mini error">{promote.error.message}</p>
      ) : null}
    </>
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
  const feedbackMutation = useMutation({
    mutationFn: (feedback: string) =>
      postForm("/admin/artifact/feedback", {
        artifact_key: artifact.url_key,
        feedback,
      }),
    onSettled: invalidate,
  });
  const feedback = artifact.feedback_mode === "private" ? "private" : "shared";
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
  // Play the exit animation before unmounting.
  const [leaving, setLeaving] = useState(false);
  const requestClose = () => {
    setLeaving(true);
    setTimeout(onClose, 170);
  };
  const deleteMutation = useMutation({
    mutationFn: () =>
      postForm("/admin/artifact/delete", { artifact_key: artifact.url_key }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      requestClose();
    },
  });
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
  const [series, setSeries] = useState<ViewSeries>("people");
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
                Contact your deployment operator if you believe this is a
                mistake.
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
              <label htmlFor={`artifact-feedback-${artifact.id}`}>
                Feedback
              </label>
              <div className="access">
                <select
                  id={`artifact-feedback-${artifact.id}`}
                  value={feedback}
                  disabled={feedbackMutation.isPending}
                  onChange={(e) => feedbackMutation.mutate(e.target.value)}
                >
                  <option value="shared">
                    Shared — viewers see each other's comments
                  </option>
                  <option value="private">
                    Private — each viewer sees only their own
                  </option>
                </select>
              </div>
            </div>
          </div>
          <h3 className="share-heading">Share</h3>
          <SharePanel artifactId={artifact.id} onChanged={invalidate} />
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
              <strong>{formatNumber(artifact.views_people)}</strong>
              <span>Views · people</span>
              {artifact.views_agents ? (
                <small>+{formatNumber(artifact.views_agents)} by agents</small>
              ) : null}
            </div>
            <div>
              <strong>{formatNumber(artifact.unique_people)}</strong>
              <span>People</span>
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
          <h3>
            Views · last 30 days
            <SeriesToggle series={series} onChange={setSeries} />
          </h3>
          {daily.some((row) => row[series]) ? (
            <BarChart
              days={fillDays(seriesRows(daily, series), 30)}
              height={64}
              unit={series === "people" ? "views by people" : "agent reads"}
            />
          ) : (
            <div className="empty small-empty">
              No {series === "people" ? "views by people" : "agent reads"} in
              this window.
            </div>
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
                      <strong>
                        {viewerName(view)} <ViewerBadge view={view} />
                      </strong>
                    </span>
                    <time>{ago(view.ts)}</time>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <VersionsPanel artifact={artifact} onChanged={invalidate} />
          <h3>Comments</h3>
          {isPending ? (
            <Skeleton style={{ height: 46 }} />
          ) : detail?.comments.length ? (
            <ul className="detail-list">
              {detail.comments.slice(0, 8).map((comment) => (
                <li key={comment.id}>
                  <span>
                    <strong title={comment.email}>
                      {comment.author_name || comment.email}
                    </strong>
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
          <h3>Delete artifact</h3>
          <p className="mini">
            Permanently removes every version, share link, comment, and view
            record. The public link stops working immediately.
          </p>
          <button
            type="button"
            className="button small ghost danger"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Permanently delete “${artifact.title}”? This cannot be undone.`,
                )
              )
                deleteMutation.mutate();
            }}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete artifact"}
          </button>
        </div>
      </aside>
    </>
  );
}
