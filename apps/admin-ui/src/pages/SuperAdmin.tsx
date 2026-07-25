import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  api,
  postForm,
  type SuperArtifact,
  type SuperEvent,
  type SuperOverview,
  type SuperModerationEvent,
  type SuperUser,
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

function orgLabel(data: SuperOverview, id: string | null): string {
  return (id && data.workspaces.find((w) => w.id === id)?.name) || id || "?";
}
function userLabel(data: SuperOverview, id: string | null): string {
  if (!id) return "?";
  const user = data.users.find((u) => u.id === id);
  return user?.email || user?.name || id;
}

export default function SuperAdmin() {
  const { data, isPending, error } = useQuery({
    queryKey: ["super"],
    queryFn: api.superOverview,
    retry: false,
  });
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [userQuery, setUserQuery] = useState("");
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

  const workspaces = [...data.workspaces].sort(
    (a, b) =>
      b.views - a.views ||
      b.artifacts - a.artifacts ||
      (a.name || a.id).localeCompare(b.name || b.id),
  );
  const workspaceById = new Map(
    data.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const userById = new Map(data.users.map((user) => [user.id, user]));
  const q = query.trim().toLowerCase();
  const rows = data.artifacts.filter((artifact) => {
    const workspace = workspaceById.get(artifact.org_id);
    const owner = userById.get(artifact.created_by);
    return (
      (!orgFilter || artifact.org_id === orgFilter) &&
      (!q ||
        `${artifact.title} ${artifact.url_key} ${artifact.org_id} ${workspace?.name || ""} ${artifact.created_by} ${owner?.name || ""} ${owner?.email || ""} ${artifact.gate_level} ${artifact.status}`
          .toLowerCase()
          .includes(q))
    );
  });
  const userQ = userQuery.trim().toLowerCase();
  const users = data.users.filter(
    (user) =>
      !userQ ||
      `${user.name || ""} ${user.email || ""} ${user.id} ${user.memberships
        .map(
          (membership) =>
            `${membership.workspace_name || ""} ${membership.workspace_id} ${membership.role || ""}`,
        )
        .join(" ")}`
        .toLowerCase()
        .includes(userQ),
  );
  const totals = {
    views: data.artifacts.reduce((s, a) => s + a.total_views, 0),
    feedback: data.artifacts.reduce((s, a) => s + a.comment_count, 0),
    activeTokens: data.workspaces.reduce(
      (sum, workspace) => sum + workspace.active_tokens,
      0,
    ),
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
          <h1>Directory &amp; artifacts</h1>
          <p className="muted">
            {data.me.email || data.me.sub} · every WorkOS user and workspace,
            joined with publishing activity
          </p>
        </div>
        <div className="metrics">
          <div>
            <strong>{formatNumber(data.users.length)}</strong>
            <span>Users</span>
          </div>
          <div>
            <strong>{formatNumber(workspaces.length)}</strong>
            <span>Workspaces</span>
          </div>
          <div>
            <strong>{formatNumber(data.artifacts.length)}</strong>
            <span>Artifacts</span>
          </div>
          <div>
            <strong>{formatNumber(totals.views)}</strong>
            <span>Views</span>
          </div>
          <div>
            <strong>{formatNumber(totals.activeTokens)}</strong>
            <span>Active tokens</span>
          </div>
          <div>
            <strong>{formatNumber(totals.feedback)}</strong>
            <span>Comments</span>
          </div>
        </div>
      </section>

      {data.directoryError ? (
        <p className="error-box directory-error" role="alert">
          {data.directoryError}. Workspaces and users below are limited to
          identities still referenced by publishing data.
        </p>
      ) : null}

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
            Workspaces{" "}
            <span className="pill">{formatNumber(workspaces.length)}</span>
          </h2>
        </div>
        <div className="org-grid">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`org-card${orgFilter === workspace.id ? " active" : ""}`}
              onClick={() =>
                setOrgFilter(orgFilter === workspace.id ? "" : workspace.id)
              }
              title={workspace.id}
            >
              <strong className="org-name">
                {workspace.name || "Legacy workspace"}
              </strong>
              <code>{workspace.id}</code>
              <span>
                <strong>{formatNumber(workspace.member_count)}</strong> members
                · <strong>{formatNumber(workspace.artifacts)}</strong> artifacts
                · <strong>{formatNumber(workspace.views)}</strong> views
              </span>
              <span>
                {formatNumber(workspace.comments)} comments ·{" "}
                {formatNumber(workspace.active_tokens)} active tokens
                {workspace.suspended ? " · suspended" : ""}
                {workspace.directory_status === "orphaned"
                  ? " · missing from WorkOS"
                  : ""}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="directory-users" aria-label="Signed up users">
        <div className="art-toolbar">
          <h2>
            Signed up users{" "}
            <span className="pill">{formatNumber(users.length)}</span>
          </h2>
          <input
            type="search"
            placeholder="Search name, email, workspace…"
            aria-label="Search signed up users"
            value={userQuery}
            onChange={(event) => setUserQuery(event.target.value)}
          />
        </div>
        <div className="user-table">
          <div className="user-head">
            <span>User</span>
            <span>Workspace access</span>
            <span>Publishing</span>
            <span>Signed up / last seen</span>
          </div>
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
          {!users.length ? (
            <p className="mini art-none">Nothing matches.</p>
          ) : null}
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
                <code>
                  {workspaceById.get(artifact.org_id)?.name || artifact.org_id}
                </code>
                <code className="dim">
                  {userById.get(artifact.created_by)?.email ||
                    artifact.created_by}
                </code>
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
                    {orgLabel(data, event.from_org_id)} →{" "}
                    {orgLabel(data, event.to_org_id)} (
                    {userLabel(data, event.to_user_id)}) · by{" "}
                    {userLabel(data, event.actor_user_id)}
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
                    {event.scope} · by {userLabel(data, event.actor_user_id)}
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
          data={data}
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

function UserRow({ user }: { user: SuperUser }) {
  return (
    <div className="user-tr">
      <span className="user-identity">
        <strong>{user.name || user.email || "Legacy user"}</strong>
        {user.name && user.email ? <small>{user.email}</small> : null}
        <code>{user.id}</code>
        {user.directory_status === "orphaned" ? (
          <small className="danger-text">Missing from WorkOS</small>
        ) : null}
      </span>
      <span className="user-memberships">
        {user.memberships.length ? (
          user.memberships.map((membership) => (
            <span className="membership" key={membership.workspace_id}>
              <strong>
                {membership.workspace_name || membership.workspace_id}
              </strong>
              {membership.role ? <small>{membership.role}</small> : null}
            </span>
          ))
        ) : (
          <small className="muted">No active workspace membership</small>
        )}
      </span>
      <span className="user-activity">
        <strong>{formatNumber(user.artifacts)} artifacts</strong>
        <small>
          {formatNumber(user.views)} views · {formatNumber(user.comments)}{" "}
          comments
        </small>
        <small>{formatNumber(user.active_tokens)} active tokens</small>
      </span>
      <span className="user-dates">
        <strong>{dateLabel(user.created_at)}</strong>
        <small>
          Last seen {user.last_sign_in_at ? ago(user.last_sign_in_at) : "never"}
        </small>
      </span>
    </div>
  );
}

function SuperSheet({
  data,
  artifact,
  events,
  moderationEvents,
  onClose,
}: {
  data: SuperOverview;
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
              <span>Comments</span>
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
                <strong>{orgLabel(data, artifact.org_id)}</strong>
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
                  <small>{orgLabel(data, artifact.org_id)}</small>
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
                      {event.reason || "restored"} · by{" "}
                      {userLabel(data, event.actor_user_id)}
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
              <label htmlFor="t-org">Target workspace</label>
              <select
                id="t-org"
                required
                value={target.org}
                onChange={(e) => setTarget({ org: e.target.value, user: "" })}
              >
                <option value="">Choose workspace…</option>
                {data.workspaces
                  .filter((w) => w.id !== artifact.org_id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.id}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="t-user">Target member</label>
              <select
                id="t-user"
                required
                disabled={!target.org}
                value={target.user}
                onChange={(e) => setTarget({ ...target, user: e.target.value })}
              >
                <option value="">Choose member…</option>
                {data.users
                  .filter((u) => u.workspace_ids.includes(target.org))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email || u.name || u.id}
                    </option>
                  ))}
              </select>
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
                      {orgLabel(data, event.from_org_id)} →{" "}
                      {orgLabel(data, event.to_org_id)}
                    </strong>
                    <small>
                      to {userLabel(data, event.to_user_id)} · by{" "}
                      {userLabel(data, event.actor_user_id)}
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
