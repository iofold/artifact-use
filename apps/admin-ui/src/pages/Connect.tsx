import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, postForm, type ApprovedConnect, type MintedPrompt } from "../api";
import { CopyButton, Shell, Skeleton, ago, dateLabel } from "../ui";

export default function Connect() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialCode = searchParams.get("code") || "";
  const [code, setCode] = useState(initialCode);
  const [reviewCode, setReviewCode] = useState(initialCode);
  const [approved, setApproved] = useState<ApprovedConnect | null>(null);
  const { data, isPending, isFetching } = useQuery({
    queryKey: ["connect", reviewCode],
    queryFn: () => api.connect(reviewCode),
  });
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("");
  const [mintAllWorkspaces, setMintAllWorkspaces] = useState(false);
  const [approveAllWorkspaces, setApproveAllWorkspaces] = useState(false);
  const [minted, setMinted] = useState<MintedPrompt | null>(null);
  const mint = useMutation({
    mutationFn: () =>
      api.mintPrompt(label, days, mintAllWorkspaces ? "user" : "org"),
    onSuccess: (result) => {
      setMinted(result);
      setLabel("");
      void queryClient.invalidateQueries({ queryKey: ["connect"] });
    },
  });
  const approve = useMutation({
    mutationFn: () =>
      api.approveConnect(
        data?.pending?.code || reviewCode,
        approveAllWorkspaces ? "user" : "org",
      ),
    onSuccess: (result) => {
      setApproved(result);
      setCode("");
      setReviewCode("");
      setSearchParams({}, { replace: true });
      void queryClient.invalidateQueries({ queryKey: ["connect"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => postForm("/admin/agent-token/revoke", { id }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["connect"] }),
  });

  return (
    <Shell>
      <section className="headline connect-headline">
        <div>
          <p className="eyebrow">Agent setup</p>
          <h1>Connect an agent</h1>
          <p className="muted">
            Paste the prompt below into your agent. It identifies its own
            harness and follows the matching path in{" "}
            <a href="/llms.txt">/llms.txt</a>.
            <span className="approve-line">
              Already have a code?{" "}
              <a href="#device-approval">Use device approval at the bottom.</a>
            </span>
          </p>
        </div>
      </section>
      <section className="setup-page">
        {isPending || !data ? (
          <div className="setup-grid">
            <Skeleton style={{ height: 190 }} />
            <Skeleton style={{ height: 70 }} />
          </div>
        ) : (
          <div className="setup-grid">
            {data.quick ? (
              <section className="setup-handoff">
                <div>
                  <p className="eyebrow">Recommended</p>
                  <h2>Paste this prompt into your agent.</h2>
                  <p className="muted">
                    This is the canonical setup for Codex, Claude, ChatGPT, and
                    other agents. It carries a workspace-scoped credential and
                    tells the agent how to connect from its current harness.
                  </p>
                </div>
                <div className="setup-prompt">
                  <label htmlFor="agent-setup-prompt">Agent setup prompt</label>
                  <textarea
                    id="agent-setup-prompt"
                    aria-label="Agent setup prompt"
                    value={data.quick.prompt}
                    readOnly
                    spellCheck={false}
                    rows={7}
                  />
                  <div className="handoff-actions">
                    <CopyButton
                      text={data.quick.prompt}
                      label="Copy setup prompt"
                      className="button setup-copy"
                      icon
                    />
                    <a
                      className="button ghost"
                      href="/llms.txt"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Read harness guide ↗
                    </a>
                  </div>
                </div>
                <p className="mini">
                  <span>
                    Valid until {dateLabel(data.quick.expiresAt)} · publish,
                    read, access, stats, and comments
                  </span>
                  <span>
                    This prompt contains a credential. Paste it only into the
                    agent you want to authorize.
                  </span>
                </p>
              </section>
            ) : (
              <div className="empty error-box">
                <strong>Setup prompt unavailable</strong>
                <span>Reload the page to prepare a new workspace token.</span>
              </div>
            )}
            <details className="manual">
              <summary>Rotate prompt &amp; manage agent tokens</summary>
              <div className="setup-grid">
                {minted ? (
                  <div className="setup-prompt setup-prompt-rotated">
                    <label htmlFor="new-agent-setup-prompt">
                      {minted.label || "Agent prompt"} · valid until{" "}
                      {dateLabel(minted.expiresAt)}
                    </label>
                    <textarea
                      id="new-agent-setup-prompt"
                      aria-label="New agent setup prompt"
                      value={minted.prompt}
                      readOnly
                      spellCheck={false}
                      rows={7}
                    />
                    <div className="handoff-actions">
                      <CopyButton
                        text={minted.prompt}
                        label="Copy prompt"
                        className="button small"
                      />
                    </div>
                  </div>
                ) : null}
                <form
                  className="token-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    mint.mutate();
                  }}
                >
                  <div>
                    <label htmlFor="ap-label">Agent label</label>
                    <input
                      id="ap-label"
                      placeholder="agent on my-laptop"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="ap-days">Expires in days</label>
                    <input
                      id="ap-days"
                      inputMode="numeric"
                      placeholder="30"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                    />
                  </div>
                  <label className="scope-choice" htmlFor="ap-scope">
                    <input
                      id="ap-scope"
                      type="checkbox"
                      checked={mintAllWorkspaces}
                      onChange={(e) => setMintAllWorkspaces(e.target.checked)}
                    />
                    <span className="scope-copy">
                      <strong>All my workspaces</strong>
                      <small>
                        The agent names a target workspace on each publish
                        instead of being pinned to this one.
                      </small>
                    </span>
                  </label>
                  <button type="submit" disabled={mint.isPending}>
                    {mint.isPending ? "Generating…" : "Create another prompt"}
                  </button>
                </form>
                {mint.isError ? (
                  <p className="mini error-box">
                    Could not create the prompt. Try again.
                  </p>
                ) : null}
                {data.tokens.length ? (
                  <ul className="token-list">
                    {data.tokens.map((token) => (
                      <li key={token.id}>
                        <span>
                          <strong>{token.label || "Agent token"}</strong>
                          <small>
                            {token.source} · created{" "}
                            {dateLabel(token.created_at)}· expires{" "}
                            {dateLabel(token.expires_at)} (
                            {ago(token.created_at)})
                          </small>
                        </span>
                        <button
                          type="button"
                          className="button small danger"
                          onClick={() => revoke.mutate(token.id)}
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mini">No active agent tokens.</p>
                )}
                <p className="mini">
                  Prompts contain scoped credentials. Keep them out of source,
                  logs, and published artifacts.
                </p>
              </div>
            </details>
            <section className="connect-approval" id="device-approval">
              <div>
                <p className="eyebrow">Fallback</p>
                <h2>Approve a device code</h2>
                <p className="muted">
                  Use this only when an agent has already started device
                  authorization and shown you a code. Only approve a request you
                  or a teammate initiated.
                </p>
              </div>
              <form
                className="connect-code-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const nextCode = code.trim();
                  setApproved(null);
                  approve.reset();
                  setReviewCode(nextCode);
                  setSearchParams(nextCode ? { code: nextCode } : {}, {
                    replace: true,
                  });
                }}
              >
                <div>
                  <label htmlFor="connect-code">Device code</label>
                  <input
                    id="connect-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="ABCD-2345"
                    autoComplete="one-time-code"
                    required
                  />
                </div>
                <button type="submit" disabled={isFetching}>
                  {isFetching ? "Checking…" : "Review code"}
                </button>
              </form>
              {approved ? (
                <div className="approval-result success-box" role="status">
                  <span>
                    <strong>{approved.label} approved</strong>
                    <small>
                      The agent receives its token on its next poll. You can
                      revoke it above at any time.
                    </small>
                  </span>
                </div>
              ) : reviewCode && !isFetching && data.pending ? (
                <div className="approval-result">
                  <span>
                    <strong>
                      {data.pending.agentLabel || "Unnamed agent"}
                    </strong>
                    <small>
                      Pending code {data.pending.code} · expires 15 minutes
                      after the request started
                    </small>
                    <label
                      className="scope-choice"
                      htmlFor="approve-scope"
                    >
                      <input
                        id="approve-scope"
                        type="checkbox"
                        checked={approveAllWorkspaces}
                        onChange={(e) =>
                          setApproveAllWorkspaces(e.target.checked)
                        }
                      />
                      <span className="scope-copy">
                        <strong>All my workspaces</strong>
                        <small>
                          The agent names its target workspace per publish.
                        </small>
                      </span>
                    </label>
                  </span>
                  <button
                    type="button"
                    onClick={() => approve.mutate()}
                    disabled={approve.isPending}
                  >
                    {approve.isPending ? "Approving…" : "Approve agent"}
                  </button>
                </div>
              ) : reviewCode && !isFetching ? (
                <p className="error-box" role="alert">
                  No pending request matches this code. It may have expired or
                  already been approved.
                </p>
              ) : null}
              {approve.isError ? (
                <p className="error-box" role="alert">
                  The code could not be approved. Review it again and retry.
                </p>
              ) : null}
            </section>
          </div>
        )}
      </section>
    </Shell>
  );
}
