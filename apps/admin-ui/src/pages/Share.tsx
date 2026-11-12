// /admin/share?artifact=art_… — the share sheet on a page of its own. The
// Share button on an artifact opens this in a small window: sharing runs here,
// on the admin origin with the publisher's session, and never inside the
// artifact's own page.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ApiError } from "../api";
import { SharePanel, useShareState } from "../share";
import { Logo } from "../ui";

type OtherWorkspace = { name: string; switch_url: string };

export default function Share() {
  const [params] = useSearchParams();
  const artifactId = params.get("artifact") || "";
  const { data, error } = useShareState(artifactId);
  const title = data?.artifact.title || "";
  useEffect(() => {
    document.title = title ? `Share · ${title}` : "Share · Artifact Use";
  }, [title]);

  const other =
    error instanceof ApiError && error.code === "other_workspace"
      ? (error.body.workspace as OtherWorkspace | undefined)
      : undefined;
  const done = () => {
    // A window the Share button opened closes itself; a tab reached any
    // other way goes back to the artifact instead.
    window.close();
    setTimeout(() => {
      window.location.href = data?.artifact.url || "/admin";
    }, 150);
  };

  return (
    <div className="share-page">
      <header className="share-top">
        <a className="brand" href="/admin">
          <Logo />
          Artifact Use
        </a>
      </header>
      <main className="share-card">
        <p className="eyebrow">Share</p>
        {error ? (
          other ? (
            <>
              <h1>This artifact is in {other.name}</h1>
              <p className="muted">
                You are signed in to a different workspace. Switch to{" "}
                {other.name} to share it.
              </p>
              <a className="button" href={other.switch_url}>
                Switch to {other.name}
              </a>
            </>
          ) : (
            <>
              <h1>Nothing to share here</h1>
              <p className="muted">
                {error instanceof ApiError && error.status === 404
                  ? "This artifact is not in your workspace, or it was deleted."
                  : error.message}
              </p>
              <a className="button ghost" href="/admin">
                Open your artifacts
              </a>
            </>
          )
        ) : (
          <>
            <h1>{title || " "}</h1>
            <SharePanel artifactId={artifactId} />
            <footer className="share-foot">
              <a
                className="text-button"
                href={`/admin?open=${encodeURIComponent(artifactId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Views, versions and comments in admin ↗
              </a>
              <button type="button" onClick={done}>
                Done
              </button>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
