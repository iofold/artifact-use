import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  postForm,
  type SuperArtifact,
  type SuperEvent,
  type SuperModerationEvent,
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

export default function SuperAdmin() {
  const { data, isPending, error } = useQuery({
    queryKey: ["super"],
    queryFn: api.superOverview,
    retry: false,
  });
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const openId = params.get("open") || "";
  const openArtifact =
    (openId && data?.artifacts.find((a) => a.id === openId)) || null;

  if (error) {
    return (
      <Shell>
        <section className="headline">
          <div>
            <p className="eyebrow">Super admin</p>
            <h1>Not available</h1>
            <p className="muted">
              Super admin isn't enabled for this account — it's configured by
              ARTIFACT_USE_SUPER_ADMIN_USER_IDS.
            </p>
          </div>
        </section>
      </Shell>
    );
  }
  if (isPending || !data) {
    return (
      <Shell>
        <section className="headline">
          <div>
            <p className="eyebrow">Super admin</p>
            <h1>All artifacts</h1>
            <Skeleton style={{ height: 14, width: 220 }} />
          </div>
          <Skeleton style={{ height: 64, width: 420 }} />
        </section>
        <Skeleton style={{ height: 160, marginTop: 22 }} />
        <Skeleton style={{ height: 300, marginTop: 24 }} />
      </Shell>
    );
  }

  const orgs = groupByOrg(data.artifacts);
  const q = query.trim().toLowerCase();
  const rows = data.artifacts.filter(
    (a) =>
      (!orgFilter || a.org_id === orgFilter) &&
      (!q ||
        `${a.title} ${a.url_key} ${a.org_id} ${a.created_by} ${a.gate_level} ${a.status}`
          .toLowerCase()
          .includes(q)),
  );
  const totals = {
    views: data.artifacts.reduce((s, a) => s + a.total_views, 0),
    gated: data.artifacts.filter((a) => a.gate_level !== "public").length,
    feedback: data.artifacts.reduce((s, a) => s + a.comment_count, 0),
  };

  return (
    <Shell
      me={{
        ...data.me,
        orgId: "",
        name: null,
        superAdmin: true,
        teamAdmin: true,
      }}
    >
      <section className="headline">
        <div>
          <p className="eyebrow">Super admin</p>
          <h1>All artifacts</h1>
          <p className="muted">
            {data.me.email || data.me.sub} · every workspace on this deployment
          </p>
        </div>
        <div className="metrics">
          <div>
            <strong>{formatNumber(data.artifacts.length)}</strong>
            <span>Artifacts</span>
          </div>
          <div>
            <strong>{formatNumber(orgs.length)}</strong>
            <span>Workspaces</span>
          </div>
          <div>
            <strong>{formatNumber(totals.views)}</strong>
            <span>Views</span>
          </div>
          <div>
            <strong>{formatNumber(totals.gated)}</strong>
            <span>Gated</span>
          </div>
          <div>
            <strong>{formatNumber(totals.feedback)}</strong>
            <span>Feedback</span>
          </div>
        </div>
      </section>

      <section
        className="activity-viz"
        aria-label="Platform views, last 30 days"
      >
        <div className="viz-head">
          <p className="eyebrow">Platform activity</p>
          <span className="muted">
            {formatNumber(data.daily.reduce((s, d) => s + d.n, 0))} views · last
            30 days · all workspaces
          </span>
        </div>
        <BarChart days={fillDays(data.daily, 30)} height={96} />
      </section>

      <section aria-label="Workspaces">
        <div className="art-toolbar">
          <h2>
            Workspaces <span className="pill">{formatNumber(orgs.length)}</span>
          </h2>
        </div>
        <div className="org-grid">
          {orgs.map((org) => (
            <button
              key={org.orgId}
              type="button"
              className={`org-card${orgFilter === org.orgId ? " active" : ""}`}
              onClick={() =>
                setOrgFilter(orgFilter === org.orgId ? "" : org.orgId)
              }
              title={org.orgId}
            >
              <code>{org.orgId}</code>
              <span>
                <strong>{formatNumber(org.artifacts)}</strong> artifacts ·{" "}
                <strong>{formatNumber(org.views)}</strong> views ·{" "}
                <strong>{formatNumber(org.feedback)}</strong> feedback
                {org.suspended ? " · suspended" : ""}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="artifacts" aria-label="All artifacts">
        <div className="art-toolbar">
          <h2>
            Artifacts <span className="pill">{formatNumber(rows.length)}</span>
            {orgFilter ? (
              <button
                type="button"
                className="button small ghost"
                onClick={() => setOrgFilter("")}
              >
                Clear workspace filter ✕
              </button>
            ) : null}
          </h2>
          <input
            type="search"
            placeholder="Search title, org, user, gate…"
            aria-label="Search artifacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="art-table super">
          <div className="art-head">
            <span>Artifact</span>
            <span className="art-owner">Owner</span>
            <span className="art-gate">Gate</span>
            <span className="num">Views</span>
            <span className="num art-fb">Feedback</span>
            <span className="art-date">Updated</span>
          </div>
          {rows.map((artifact) => (
            <button
              type="button"
              key={artifact.id}
              className={`art-tr${openId === artifact.id ? " active" : ""}`}
              onClick={() => setParams({ open: artifact.id })}
            >
              <span className="art-name">
                <strong>{artifact.title}</strong>
                <small>{artifact.path}</small>
              </span>
              <span className="art-owner">
                <code>{artifact.org_id}</code>
                <code className="dim">{artifact.created_by}</code>
              </span>
              <span className="art-gate">
                <span className="pill">{artifact.gate_level}</span>
                {artifact.status === "suspended" || artifact.org_suspended ? (
                  <span className="pill danger">Suspended</span>
                ) : null}
              </span>
              <span className="num">{formatNumber(artifact.total_views)}</span>
              <span className="num art-fb">
                {formatNumber(artifact.comment_count)}
              </span>
              <span className="art-date">{ago(artifact.updated_at)}</span>
            </button>
          ))}
          {!rows.length ? (
            <p className="mini art-none">Nothing matches.</p>
          ) : null}
        </div>
      </section>

      {data.events.length ? (
        <section className="activity">
          <p className="eyebrow">Audit trail</p>
          <h2>Recent ownership moves</h2>
          <ul className="activity-feed">
            {data.events.map((event) => (
              <li key={event.id}>
                <span>
                  <strong>{event.artifact_title || event.artifact_id}</strong>
                  <small>
                    {event.from_org_id} → {event.to_org_id} ({event.to_user_id})
                    · by {event.actor_user_id}
                  </small>
                </span>
                <time>{ago(event.created_at)}</time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.moderationEvents.length ? (
        <section className="activity">
          <p className="eyebrow">Moderation trail</p>
          <h2>Recent suspension actions</h2>
          <ul className="activity-feed">
            {data.moderationEvents.slice(0, 30).map((event) => (
              <li key={event.id}>
                <span>
                  <strong>
                    {event.action} {event.artifact_title || event.org_id}
                  </strong>
                  <small>
                    {event.scope} · by {event.actor_user_id}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </small>
                </span>
                <time>{ago(event.created_at)}</time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {openArtifact ? (
        <SuperSheet
          artifact={openArtifact}
          events={data.events.filter(
            (event) => event.artifact_id === openArtifact.id,
          )}
          moderationEvents={data.moderationEvents.filter(
            (event) =>
              event.artifact_id === openArtifact.id ||
              (event.scope === "org" && event.org_id === openArtifact.org_id),
          )}
          onClose={() => {
            params.delete("open");
            setParams(params, { replace: true });
          }}
        />
      ) : null}
    </Shell>
  );
}

function groupByOrg(artifacts: SuperArtifact[]) {
  const map = new Map<
    string,
    {
      orgId: string;
      artifacts: number;
      views: number;
      feedback: number;
      suspended: boolean;
      reason: string | null;
    }
  >();
  for (const artifact of artifacts) {
    const entry = map.get(artifact.org_id) || {
      orgId: artifact.org_id,
      artifacts: 0,
      views: 0,
      feedback: 0,
      suspended: false,
      reason: null,
    };
    entry.artifacts += 1;
    entry.views += artifact.total_views;
    entry.feedback += artifact.comment_count;
    entry.suspended ||= artifact.org_suspended;
    entry.reason ||= artifact.org_moderation_reason;
    map.set(artifact.org_id, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.views - a.views);
}

function SuperSheet({
  artifact,
  events,
  moderationEvents,
  onClose,
}: {
  artifact: SuperArtifact;
  events: SuperEvent[];
  moderationEvents: SuperModerationEvent[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const requestClose = () => {
    setLeaving(true);
    setTimeout(onClose, 170);
  };
  const [target, setTarget] = useState({ org: "", user: "" });
  const [moderationReason, setModerationReason] = useState("");
  const transfer = useMutation({
    mutationFn: () =>
      postForm("/admin/super/transfer", {
        artifact_id: artifact.id,
        target_org_id: target.org,
        target_user_id: target.user,
      }),
    onSuccess: () => {
      setTarget({ org: "", user: "" });
      void queryClient.invalidateQueries({ queryKey: ["super"] });
    },
  });
  const moderation = useMutation({
    mutationFn: (input: {
      scope: "artifact" | "org";
      action: "suspend" | "restore";
    }) =>
      postForm(`/admin/super/${input.scope}/${input.action}`, {
        ...(input.scope === "artifact"
          ? { artifact_id: artifact.id }
          : { org_id: artifact.org_id }),
        ...(input.action === "suspend" ? { reason: moderationReason } : {}),
      }),
    onSuccess: () => {
      setModerationReason("");
      void queryClient.invalidateQueries({ queryKey: ["super"] });
    },
  });
  const requestSuspension = (scope: "artifact" | "org") => {
    const target = scope === "artifact" ? artifact.title : artifact.org_id;
    const impact =
      scope === "artifact"
        ? "this artifact"
        : "every artifact in this workspace and block new publishes";
    if (
      window.confirm(
        `Suspend ${target}? This will immediately block ${impact}.`,
      )
    )
      moderation.mutate({ scope, action: "suspend" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <div className="sheet-actions">
            <a
              className="button small"
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open artifact ↗
            </a>
            <span className="pill">{artifact.gate_level}</span>
          </div>
          <div className="sheet-stats">
            <div>
              <strong>{formatNumber(artifact.total_views)}</strong>
              <span>Views</span>
            </div>
            <div>
              <strong>{formatNumber(artifact.comment_count)}</strong>
              <span>Feedback</span>
            </div>
            <div>
              <strong>{formatNumber(artifact.share_links)}</strong>
              <span>Share links</span>
            </div>
            <div>
              <strong>{formatBytes(artifact.total_size)}</strong>
              <span>{formatNumber(artifact.file_count)} files</span>
            </div>
          </div>
          <h3>Identity</h3>
          <ul className="detail-list ids">
            <li>
              <span>
                <small>Artifact</small>
                <code>{artifact.id}</code>
              </span>
              <CopyButtonInline text={artifact.id} />
            </li>
            <li>
              <span>
                <small>Owner org</small>
                <code>{artifact.org_id}</code>
              </span>
              <CopyButtonInline text={artifact.org_id} />
            </li>
            <li>
              <span>
                <small>Created by</small>
                <code>{artifact.created_by}</code>
              </span>
              <CopyButtonInline text={artifact.created_by} />
            </li>
            <li>
              <span>
                <small>URL key</small>
                <code>{artifact.url_key}</code>
              </span>
              <CopyButtonInline text={artifact.url_key} />
            </li>
          </ul>
          <p className="mini">
            Published {dateLabel(artifact.completed_at)} · updated{" "}
            {ago(artifact.updated_at)}
          </p>
          <h3>Availability controls</h3>
          <div className="moderation-controls">
            <div className="moderation-state">
              <span>
                Artifact: <strong>{artifact.status}</strong>
              </span>
              {artifact.moderation_reason ? (
                <small>{artifact.moderation_reason}</small>
              ) : null}
              <span>
                Workspace:{" "}
                <strong>
                  {artifact.org_suspended ? "suspended" : "active"}
                </strong>
              </span>
              {artifact.org_moderation_reason ? (
                <small>{artifact.org_moderation_reason}</small>
              ) : null}
            </div>
            <label htmlFor="moderation-reason">
              Reason for next suspension
            </label>
            <textarea
              id="moderation-reason"
              rows={3}
              maxLength={500}
              placeholder="Required for suspend actions; not used for restore"
              value={moderationReason}
              onChange={(event) => setModerationReason(event.target.value)}
            />
            <div className="moderation-actions">
              <div className="moderation-action-row">
                <span>
                  <strong>Artifact only</strong>
                  <small>{artifact.title}</small>
                </span>
                {artifact.status === "suspended" ? (
                  <button
                    type="button"
                    className="button small ghost"
                    onClick={() =>
                      moderation.mutate({
                        scope: "artifact",
                        action: "restore",
                      })
                    }
                    disabled={moderation.isPending}
                  >
                    Restore artifact
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button small danger"
                    onClick={() => requestSuspension("artifact")}
                    disabled={
                      moderation.isPending || !moderationReason.trim().length
                    }
                  >
                    Suspend artifact
                  </button>
                )}
              </div>
              <div className="moderation-action-row workspace-action">
                <span>
                  <strong>Entire workspace</strong>
                  <small>{artifact.org_id}</small>
                </span>
                {artifact.org_suspended ? (
                  <button
                    type="button"
                    className="button small ghost"
                    onClick={() =>
                      moderation.mutate({ scope: "org", action: "restore" })
                    }
                    disabled={moderation.isPending}
                  >
                    Restore workspace
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button small danger"
                    onClick={() => requestSuspension("org")}
                    disabled={
                      moderation.isPending || !moderationReason.trim().length
                    }
                  >
                    Suspend workspace
                  </button>
                )}
              </div>
            </div>
            {moderation.isError ? (
              <p className="error mini">
                {(moderation.error as Error).message}
              </p>
            ) : null}
          </div>
          <h3>Moderation history</h3>
          {moderationEvents.length ? (
            <ul className="detail-list">
              {moderationEvents.map((event) => (
                <li key={event.id}>
                  <span>
                    <strong>
                      {event.action} {event.scope}
                    </strong>
                    <small>
                      {event.reason || "restored"} · by {event.actor_user_id}
                    </small>
                  </span>
                  <time>{ago(event.created_at)}</time>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty small-empty">No moderation actions.</div>
          )}
          <h3>Move ownership</h3>
          <form
            className="transfer-form"
            onSubmit={(e) => {
              e.preventDefault();
              transfer.mutate();
            }}
          >
            <div>
              <label htmlFor="t-org">Target WorkOS org</label>
              <input
                id="t-org"
                placeholder="org_…"
                required
                value={target.org}
                onChange={(e) => setTarget({ ...target, org: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="t-user">Target WorkOS user</label>
              <input
                id="t-user"
                placeholder="user_…"
                required
                value={target.user}
                onChange={(e) => setTarget({ ...target, user: e.target.value })}
              />
            </div>
            <button type="submit" disabled={transfer.isPending}>
              {transfer.isPending ? "Moving…" : "Move artifact"}
            </button>
          </form>
          {transfer.isError ? (
            <p className="error mini">{(transfer.error as Error).message}</p>
          ) : null}
          {transfer.isSuccess ? (
            <p className="mini" style={{ color: "var(--accent)" }}>
              Moved. Versions, share links, and created_by now point at the
              target.
            </p>
          ) : null}
          <p className="mini">
            Moving updates the artifact, its versions, and share links to the
            target org and user. The target user must be an active member of the
            target org. The public URL key <code>{artifact.url_key}</code> stays
            stable.
          </p>
          <h3>Transfer history</h3>
          {events.length ? (
            <ul className="detail-list">
              {events.map((event) => (
                <li key={event.id}>
                  <span>
                    <strong>
                      {event.from_org_id} → {event.to_org_id}
                    </strong>
                    <small>
                      to {event.to_user_id} · by {event.actor_user_id}
                    </small>
                  </span>
                  <time>{ago(event.created_at)}</time>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty small-empty">Never moved.</div>
          )}
        </div>
      </aside>
    </>
  );
}

function CopyButtonInline({ text }: { text: string }) {
  return (
    <span className="copy-inline">
      <CopyButton text={text} />
    </span>
  );
}
