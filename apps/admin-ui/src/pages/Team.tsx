import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, postForm } from "../api";
import { Shell, Skeleton } from "../ui";

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
            Teammates you invite see the same artifacts, stats, and feedback as
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
    </Shell>
  );
}
