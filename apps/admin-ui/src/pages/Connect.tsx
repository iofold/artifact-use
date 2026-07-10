import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, postForm, type MintedPrompt } from "../api";
import { CopyButton, Shell, Skeleton, ago, dateLabel } from "../ui";

export default function Connect() {
  const { data, isPending } = useQuery({
    queryKey: ["connect"],
    queryFn: api.connect,
  });
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("");
  const [minted, setMinted] = useState<MintedPrompt | null>(null);
  const mint = useMutation({
    mutationFn: () => api.mintPrompt(label, days),
    onSuccess: (result) => {
      setMinted(result);
      setLabel("");
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
            Copy one compact handoff. The agent identifies its own harness and
            follows the matching path in <a href="/llms.txt">/llms.txt</a>.
            <span className="approve-line">
              Agent already has a code?{" "}
              <a href="/connect">
                Approve an agent code
                <svg
                  className="inline-arrow"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
                </svg>
              </a>
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
                  <p className="eyebrow">Universal handoff</p>
                  <h2>One short prompt. The agent picks the path.</h2>
                  <p className="muted">
                    It contains one workspace-scoped token and a pointer to the
                    harness guide. The credential is not displayed on this page.
                  </p>
                </div>
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
                <p className="mini">
                  <span>
                    Valid until {dateLabel(data.quick.expiresAt)} · publish,
                    read, access, stats, and feedback
                  </span>
                  <span>To rotate, revoke “Quick connect” below.</span>
                </p>
              </section>
            ) : (
              <div className="empty error-box">
                <strong>Setup prompt unavailable</strong>
                <span>Reload the page to prepare a new workspace token.</span>
              </div>
            )}
            <details className="manual">
              <summary>Quick connect &amp; token management</summary>
              <div className="setup-grid">
                {minted ? (
                  <div className="minted-prompt-row">
                    <span>
                      <strong>{minted.label || "Agent prompt"} is ready</strong>
                      <small>
                        Valid until {dateLabel(minted.expiresAt)} · shown only
                        as a copy action
                      </small>
                    </span>
                    <CopyButton
                      text={minted.prompt}
                      label="Copy prompt"
                      className="button small"
                    />
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
          </div>
        )}
      </section>
    </Shell>
  );
}
