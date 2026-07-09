import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, postForm, type MintedPrompt } from "../api";
import { CopyBlock, Shell, Skeleton, ago, dateLabel } from "../ui";

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
      <section className="headline">
        <div>
          <p className="eyebrow">Agent setup</p>
          <h1>Connect an agent</h1>
          <p className="muted">
            Two paths: <strong>OAuth</strong> for agents with proper MCP support
            (Claude Code), a <strong>bearer-token prompt</strong> for everything
            else (Codex, custom agents). Agent asked you to approve a code?{" "}
            <a href="/connect">
              <strong>Approve it here →</strong>
            </a>
          </p>
        </div>
      </section>
      <section className="setup-page">
        {isPending || !data ? (
          <div className="setup-grid">
            <Skeleton style={{ height: 120 }} />
            <Skeleton style={{ height: 260 }} />
            <Skeleton style={{ height: 70 }} />
          </div>
        ) : (
          <div className="setup-grid">
            <div className="setup-paths">
              <div className="path-card">
                <p className="path-head">
                  Path A · OAuth{" "}
                  <span className="path-for">Claude Code, MCP clients</span>
                </p>
                <p className="mini">
                  No token to copy — the agent signs in as you in the browser.
                </p>
                <div className="copywrap">
                  <CopyBlock text={data.claudeAdd} />
                </div>
                <p className="mini">
                  Then <code>/mcp</code> in Claude Code →{" "}
                  <strong>Authenticate</strong>. Other MCP clients: use the
                  config under Manual setup below.
                </p>
              </div>
              <div className="path-card">
                <p className="path-head">
                  Path B · Bearer token{" "}
                  <span className="path-for">Codex, everything else</span>
                </p>
                <p className="mini">
                  For agents with weak or no OAuth support: paste one message
                  with a scoped 30-day token baked in — token, endpoints, and
                  instructions in a single prompt.
                </p>
                <p className="mini">
                  Your prompt is ready below. Codex users: the bearer config is
                  under Manual setup.
                </p>
              </div>
            </div>
            {minted ? (
              <div className="quick-prompt">
                <label htmlFor="minted-prompt">
                  {minted.label || "Agent prompt"} — shown once, copy it now
                </label>
                <CopyBlock id="minted-prompt" text={minted.prompt} rows={12} />
                <p className="mini">
                  Valid until {dateLabel(minted.expiresAt)}. Scope: publish,
                  read, manage access, and stats — this workspace only.
                </p>
              </div>
            ) : null}
            {data.quick ? (
              <div className="quick-prompt">
                <label htmlFor="quick-prompt">
                  Ready to paste — connects any agent
                </label>
                <CopyBlock
                  id="quick-prompt"
                  text={data.quick.prompt}
                  rows={12}
                />
                <p className="mini">
                  One paste is the whole setup: a publish token scoped to this
                  workspace (valid until {dateLabel(data.quick.expiresAt)}),
                  endpoints, and instructions. The same prompt stays here across
                  reloads; revoke its "Quick connect" token below to rotate it.
                </p>
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
                  placeholder="codex on my-laptop"
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
                {mint.isPending ? "Generating…" : "Generate agent prompt"}
              </button>
            </form>
            {data.tokens.length ? (
              <ul className="token-list">
                {data.tokens.map((token) => (
                  <li key={token.id}>
                    <span>
                      <strong>{token.label || "Agent token"}</strong>
                      <small>
                        {token.source} · created {dateLabel(token.created_at)} ·
                        expires {dateLabel(token.expires_at)} (
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
              <p className="mini">
                No active agent tokens yet. Copy the ready prompt above, or
                approve an agent's connect code at{" "}
                <a href="/connect">/connect</a>.
              </p>
            )}
            <details className="manual">
              <summary>Manual setup — MCP URL and configs</summary>
              <div className="setup-grid">
                <CopyBlock
                  label="MCP URL"
                  id="mcp-url"
                  text={data.site.mcpUrl}
                />
                <CopyBlock
                  label="OAuth MCP config (Claude Code, MCP clients)"
                  id="mcp-json"
                  text={data.mcpConfig}
                  rows={8}
                />
                <CopyBlock
                  label="Codex bearer config (~/.codex/config.toml)"
                  id="mcp-toml"
                  text={data.codexConfig}
                  rows={4}
                />
                <p className="mini">
                  Bearer tokens live in <code>ARTIFACT_USE_TOKEN</code> — never
                  in config files, source, or published HTML.
                </p>
              </div>
            </details>
          </div>
        )}
      </section>
    </Shell>
  );
}
