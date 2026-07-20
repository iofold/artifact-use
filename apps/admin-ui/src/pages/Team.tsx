import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, postForm } from "../api";
import { Shell, Skeleton } from "../ui";

function Workspaces({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["workspace-context"],
    queryFn: api.workspaceContext,
    staleTime: 60_000,
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["workspace-context"] });
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const rename = useMutation({
    mutationFn: () => api.renameWorkspace(renameTo.trim()),
    onSuccess: () => {
      setRenaming(false);
      invalidate();
    },
  });
  const [newName, setNewName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createWorkspace(newName.trim()),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
  });
  if (!data) return null;
  return (
    <section className="team-panel" id="workspaces">
      <div>
        <p className="eyebrow">Workspaces</p>
        <h2>Where you can publish</h2>
        <p className="muted">
          Every workspace your account belongs to. Switching re-enters
          sign-in for the selected workspace — usually a single silent
          redirect.
        </p>
      </div>
      <div className="team-body">
        <ul className="workspace-list">
          {data.workspaces.map((workspace) => (
            <li key={workspace.org_id}>
              <span>
                <strong>
                  {workspace.org_name || workspace.org_id}
                  {workspace.active ? (
                    <em className="workspace-current">Current</em>
                  ) : null}
                </strong>
                <small>
                  {workspace.org_slug ? `${workspace.org_slug} · ` : ""}
                  {workspace.role || "member"} ·{" "}
                  <code>{workspace.org_id}</code>
                </small>
              </span>
              {workspace.active && canManage ? (
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() => {
                    setRenameTo(workspace.org_name || "");
                    rename.reset();
                    setRenaming((value) => !value);
                  }}
                >
                  Rename
                </button>
              ) : null}
              {workspace.switch_url ? (
                <a className="button small" href={workspace.switch_url}>
                  Switch
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        {renaming ? (
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate();
            }}
          >
            <div>
              <label htmlFor="ws-rename">New workspace name</label>
              <input
                id="ws-rename"
                value={renameTo}
                onChange={(event) => setRenameTo(event.target.value)}
                minLength={2}
                maxLength={80}
                required
              />
            </div>
            <button type="submit" disabled={rename.isPending}>
              {rename.isPending ? "Renaming…" : "Save name"}
            </button>
            <p className="mini">
              Renaming changes the workspace slug. Agents that pin the slug
              (in .artifact-use.json or --workspace) must update it; pins
              using the org id keep working.
            </p>
            {rename.isError ? (
              <p className="mini error-box">
                Could not rename the workspace. Only workspace admins can
                rename, and names must be 2–80 characters.
              </p>
            ) : null}
          </form>
        ) : null}
        <form
          className="workspace-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div>
            <label htmlFor="ws-new">New workspace</label>
            <input
              id="ws-new"
              placeholder="Milestone Internet"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              minLength={2}
              maxLength={80}
              required
            />
          </div>
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create workspace"}
          </button>
          <p className="mini">
            You become its admin; use Switch to enter it, then invite
            teammates from this page.
          </p>
          {create.isError ? (
            <p className="mini error-box">
              Could not create the workspace. Check the name and try again.
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}

export default function Team() {
  const { data, isPending } = useQuery({
    queryKey: ["team"],
    queryFn: api.team,
  });
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["team"] });
  const [invite, setInvite] = useState({ email: "", role: "member", days: "" });
  const inviteMutation = useMutation({
    mutationFn: () =>
      postForm("/admin/team/invite", {
        email: invite.email,
        role_slug: invite.role,
        expires_days: invite.days,
      }),
    onSuccess: () => setInvite({ email: "", role: "member", days: "" }),
    onSettled: invalidate,
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => postForm("/admin/team/invite/revoke", { id }),
    onSettled: invalidate,
  });

  return (
    <Shell>
      <section className="team-panel" id="team">
        <div>
          <p className="eyebrow">Team</p>
          <h2>Publisher access</h2>
          <p className="muted">
            Teammates you invite see the same artifacts, stats, and comments as
            you.
          </p>
          {data ? (
            <p className="mini">
              Workspace ID <code>{data.orgId}</code>
            </p>
          ) : null}
        </div>
        <div className="team-body">
          {isPending || !data ? (
            <>
              <Skeleton style={{ height: 70 }} />
              <Skeleton style={{ height: 140 }} />
            </>
          ) : (
            <>
              {data.canEdit ? (
                <form
                  className="team-invite"
                  onSubmit={(e) => {
                    e.preventDefault();
                    inviteMutation.mutate();
                  }}
                >
                  <div>
                    <label htmlFor="ti-email">Email</label>
                    <input
                      id="ti-email"
                      type="email"
                      required
                      placeholder="teammate@example.com"
                      value={invite.email}
                      onChange={(e) =>
                        setInvite({ ...invite, email: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label htmlFor="ti-role">Role</label>
                    <select
                      id="ti-role"
                      value={invite.role}
                      onChange={(e) =>
                        setInvite({ ...invite, role: e.target.value })
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ti-days">Expires</label>
                    <input
                      id="ti-days"
                      inputMode="numeric"
                      placeholder="14"
                      value={invite.days}
                      onChange={(e) =>
                        setInvite({ ...invite, days: e.target.value })
                      }
                    />
                  </div>
                  <button type="submit" disabled={inviteMutation.isPending}>
                    {inviteMutation.isPending ? "Inviting…" : "Invite user"}
                  </button>
                </form>
              ) : !data.canManage ? (
                <div className="empty small-empty">
                  <strong>Invite access is admin-only.</strong>
                  <span>
                    Ask an organization admin to invite or remove team members.
                  </span>
                </div>
              ) : null}
              {data.error ? (
                <div className="empty small-empty error-box">{data.error}</div>
              ) : null}
              <div className="team-grid">
                <div>
                  <h3>Members</h3>
                  {data.members.length ? (
                    <ul className="detail-list">
                      {data.members.map((member) => (
                        <li key={member.id}>
                          <span>
                            <strong>{member.name || member.email}</strong>
                            <small>
                              {member.email} · {member.status}
                            </small>
                          </span>
                          <span className="pill">{member.role}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="empty small-empty">No members loaded.</div>
                  )}
                </div>
                <div>
                  <h3>Pending invitations</h3>
                  {data.invitations.length ? (
                    <ul className="detail-list">
                      {data.invitations.map((inv) => (
                        <li key={inv.id}>
                          <span>
                            <strong>{inv.email}</strong>
                            <small>
                              {inv.role} · expires {inv.expiresAt}
                            </small>
                          </span>
                          {data.canEdit ? (
                            <button
                              type="button"
                              className="button small ghost danger"
                              onClick={() => revokeInvite.mutate(inv.id)}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span className="pill">{inv.state}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="empty small-empty">
                      No pending invitations.
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
      <Workspaces canManage={Boolean(data?.canManage)} />
    </Shell>
  );
}
