import type { Artifact, Env, ViewerSession } from "./types";
import {
  readCookie,
  setViewerCookie,
  signViewerSession,
  verifyViewerSession,
  viewerCookieName,
} from "./auth";
import { getArtifactById, getArtifactByUrlKey, insertView } from "./db";
import { sendVerificationEmail } from "./mailer";
import {
  error,
  escapeHtml,
  htmlPage,
  normalizeEmail,
  nowSec,
  publicArtifactPath,
  randomCode,
  randomId,
} from "./util";

export async function getViewerSession(
  request: Request,
  env: Env,
  artifact: Artifact,
): Promise<ViewerSession | null> {
  const raw = readCookie(request, viewerCookieName(artifact.id));
  if (!raw) return null;
  const session = await verifyViewerSession(raw, env);
  if (!session || session.artifact_id !== artifact.id) return null;
  return session;
}

export function renderGate(
  artifact: Artifact,
  redirectTo: string,
  prefillEmail = "",
  shareLinkId = "",
): Response {
  const verified =
    artifact.gate_level === "verified_email" ||
    artifact.gate_level === "allowlist";
  const action = verified ? "/_au/gate/start" : "/_au/gate/email";
  return htmlPage(
    artifact.title,
    `<h1>${escapeHtml(artifact.title)}</h1>
<p class="muted">Enter your email to continue.</p>
<form method="post" action="${action}">
  <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
  <input type="hidden" name="redirect_to" value="${escapeHtml(redirectTo)}">
  <input type="hidden" name="share_link_id" value="${escapeHtml(shareLinkId)}">
  <label>Email</label>
  <input name="email" type="email" autocomplete="email" value="${escapeHtml(prefillEmail)}" required>
  <button type="submit">${verified ? "Send code" : "Continue"}</button>
</form>`,
  );
}

export async function handleGateRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  try {
    if (request.method === "POST" && path === "/_au/gate/email") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const email = normalizeEmail(String(form.get("email") || ""));
      if (!email.includes("@"))
        return error(400, "invalid_email", "valid email required");
      const shareLinkId = String(form.get("share_link_id") || "") || null;
      const redirectTo = safeArtifactRedirect(
        env,
        artifact,
        request,
        form.get("redirect_to"),
      );
      const viewId = await insertView(
        env,
        artifact,
        shareLinkId,
        email,
        false,
        request,
      );
      const session = await signViewerSession(
        {
          artifact_id: artifact.id,
          version_id: artifact.current_version_id,
          email,
          verified: false,
          view_id: viewId,
          exp: nowSec() + 30 * 86400,
        },
        env,
      );
      return redirectWithCookie(
        redirectTo,
        setViewerCookie(viewerCookieName(artifact.id), session),
      );
    }

    if (request.method === "POST" && path === "/_au/gate/start") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const email = normalizeEmail(String(form.get("email") || ""));
      if (!email.includes("@"))
        return error(400, "invalid_email", "valid email required");
      if (!isAllowed(artifact, email))
        return htmlPage(
          artifact.title,
          `<p class="error">This email is not allowed for this artifact.</p>`,
        );
      const redirectTo = safeArtifactRedirect(
        env,
        artifact,
        request,
        form.get("redirect_to"),
      );
      const shareLinkId = String(form.get("share_link_id") || "") || null;
      const token = randomId("vt");
      const code = randomCode();
      await env.DB.prepare(
        "INSERT INTO viewer_tokens (token, artifact_id, email, code, expires_at, created_at, redirect_to, share_link_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          token,
          artifact.id,
          email,
          code,
          nowSec() + 15 * 60,
          nowSec(),
          redirectTo,
          shareLinkId,
        )
        .run();
      const verifyUrl = `${env.SITE_BASE_URL}/_au/gate/verify?t=${encodeURIComponent(token)}`;
      await sendVerificationEmail(env, artifact, email, code, verifyUrl);
      return htmlPage(
        artifact.title,
        `<h1>Check your email</h1>
<p class="muted">Use the link or enter the code we sent.</p>
${env.ALLOW_DEBUG_CODES === "true" ? `<p class="muted">Debug code: <strong>${code}</strong></p>` : ""}
<form method="post" action="/_au/gate/verify">
  <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <input type="hidden" name="redirect_to" value="${escapeHtml(redirectTo)}">
  <input type="hidden" name="share_link_id" value="${escapeHtml(shareLinkId || "")}">
  <label>Code</label>
  <input name="code" inputmode="numeric" autocomplete="one-time-code" required>
  <button type="submit">Verify</button>
</form>`,
      );
    }

    if (request.method === "POST" && path === "/_au/gate/verify") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const email = normalizeEmail(String(form.get("email") || ""));
      const code = String(form.get("code") || "").trim();
      const row = await env.DB.prepare(
        "SELECT token FROM viewer_tokens WHERE artifact_id = ? AND email = ? AND code = ? AND used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(artifact.id, email, code, nowSec())
        .first<{ token: string }>();
      if (!row)
        return htmlPage(
          artifact.title,
          `<p class="error">Invalid or expired code.</p>`,
        );
      return await consumeVerified(
        request,
        env,
        artifact,
        row.token,
        safeArtifactRedirect(env, artifact, request, form.get("redirect_to")),
        String(form.get("share_link_id") || "") || null,
      );
    }

    if (request.method === "GET" && path === "/_au/gate/verify") {
      const url = new URL(request.url);
      const token = url.searchParams.get("t") || "";
      const row = await env.DB.prepare(
        `SELECT vt.token, vt.email, vt.redirect_to, vt.share_link_id, a.id AS artifact_id
         FROM viewer_tokens vt JOIN artifacts a ON a.id = vt.artifact_id
         WHERE vt.token = ? AND vt.used_at IS NULL AND vt.expires_at >= ?`,
      )
        .bind(token, nowSec())
        .first<{
          token: string;
          email: string;
          redirect_to: string | null;
          share_link_id: string | null;
          artifact_id: string;
        }>();
      if (!row)
        return htmlPage(
          "Expired link",
          `<p class="error">This verification link is invalid or expired.</p>`,
        );
      const artifact = await getArtifactById(env, row.artifact_id);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      return await consumeVerified(
        request,
        env,
        artifact,
        token,
        safeArtifactRedirect(env, artifact, request, row.redirect_to),
        row.share_link_id || null,
      );
    }
  } catch (e) {
    return error(
      400,
      "gate_failed",
      e instanceof Error ? e.message : "gate failed",
    );
  }
  return error(404, "not_found", "gate route not found");
}

async function consumeVerified(
  request: Request,
  env: Env,
  artifact: Artifact,
  token: string,
  redirectTo: string,
  shareLinkId: string | null,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT email FROM viewer_tokens WHERE token = ?",
  )
    .bind(token)
    .first<{ email: string }>();
  if (!row) return error(404, "token_not_found", "token not found");
  await env.DB.prepare("UPDATE viewer_tokens SET used_at = ? WHERE token = ?")
    .bind(nowSec(), token)
    .run();
  const viewId = await insertView(
    env,
    artifact,
    shareLinkId,
    row.email,
    true,
    request,
  );
  const session = await signViewerSession(
    {
      artifact_id: artifact.id,
      version_id: artifact.current_version_id,
      email: row.email,
      verified: true,
      view_id: viewId,
      exp: nowSec() + 30 * 86400,
    },
    env,
  );
  return redirectWithCookie(
    safeArtifactRedirect(env, artifact, request, redirectTo),
    setViewerCookie(viewerCookieName(artifact.id), session),
  );
}

function redirectWithCookie(url: string, cookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": cookie,
    },
  });
}

function safeArtifactRedirect(
  env: Env,
  artifact: Artifact,
  request: Request,
  value: FormDataEntryValue | string | null,
): string {
  const fallback = publicArtifactPath(env, artifact.url_key);
  const raw = String(value || fallback);
  try {
    const base = new URL(request.url);
    const url = new URL(raw, base);
    const path = url.pathname;
    if (url.origin !== base.origin) return fallback;
    if (path !== fallback && !path.startsWith(fallback)) return fallback;
    return `${path}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

async function formArtifact(
  env: Env,
  form: FormData,
): Promise<Artifact | null> {
  const artifactKey = String(form.get("artifact_key") || "");
  if (artifactKey) return getArtifactByUrlKey(env, artifactKey);
  return null;
}

function isAllowed(artifact: Artifact, email: string): boolean {
  if (artifact.gate_level !== "allowlist") return true;
  if (!artifact.allowlist_json) return false;
  const parsed = JSON.parse(artifact.allowlist_json) as {
    emails?: string[];
    domains?: string[];
  };
  const emails = new Set((parsed.emails || []).map((e) => e.toLowerCase()));
  if (emails.has(email)) return true;
  const domain = email.split("@")[1] || "";
  return (parsed.domains || []).some(
    (d) => d.replace(/^@/, "").toLowerCase() === domain,
  );
}
