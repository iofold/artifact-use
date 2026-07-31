import type { Artifact, Env, ViewerSession } from "./types";
import {
  readCookie,
  setViewerCookie,
  signViewerSession,
  verifyViewerSession,
  viewerCookieName,
} from "./auth";
import { getArtifactById, getArtifactByUrlKey, insertView } from "./db";
import { EmailDeliveryError, sendVerificationEmail } from "./mailer";
import { unavailableArtifactResponse } from "./moderation";
import { getPublisherSessionAuth } from "./publisher";
import { resolveWorkspaceOrg } from "./workspaces";
import {
  clearRateLimit,
  hashRateKey,
  rateLimit,
  rateLimitedResponse,
  requestIp,
} from "./rl";
import {
  bearerToken,
  error,
  escapeHtml,
  htmlPage,
  json,
  normalizeEmail,
  nowSec,
  publicArtifactPath,
  randomCode,
  randomId,
  requiresVerified,
  wantsHtml,
} from "./util";

export async function getViewerSession(
  request: Request,
  env: Env,
  artifact: Artifact,
): Promise<ViewerSession | null> {
  // Cookie (human browser) or `Authorization: Bearer <viewer-session token>`
  // (agent delegated/self-serve access). Both decode to the same session shape,
  // scoped to this artifact, so every gated path works for agents unchanged.
  const cookie = readCookie(request, viewerCookieName(artifact.id));
  const raw =
    cookie ||
    bearerToken(request) ||
    new URL(request.url).searchParams.get("agent");
  if (!raw) return null;
  const session = await verifyViewerSession(raw, env);
  if (!session || session.artifact_id !== artifact.id) return null;
  return session;
}

// The signed-in identity riding on the request, if any. A publisher session
// carries a WorkOS-authenticated email — strictly stronger proof than the
// gate's own OTP — so gates may honor it. Membership of the artifact's own
// workspace (directly or via the multi-workspace snapshot) decides HOW: members
// pass silently, everyone else gets a one-click consent so merely opening a
// link never discloses an email the viewer didn't agree to share.
export async function signedInViewer(
  request: Request,
  env: Env,
  artifact: Artifact,
): Promise<{ email: string; member: boolean } | null> {
  const auth = await getPublisherSessionAuth(request, env);
  const email = normalizeEmail(auth?.session.email || "");
  if (!auth || !validEmail(email)) return null;
  if (auth.session.orgId === artifact.org_id) return { email, member: true };
  try {
    await resolveWorkspaceOrg(env, auth.session.sub, artifact.org_id);
    return { email, member: true };
  } catch {
    return { email, member: false };
  }
}

export function renderGate(
  artifact: Artifact,
  redirectTo: string,
  prefillEmail = "",
  shareLinkId = "",
  sessionEmail = "",
): Response {
  const verified = requiresVerified(artifact.gate_level);
  const action = verified ? "/_au/gate/start" : "/_au/gate/email";
  // One-click for signed-in viewers, unless an allowlist would reject their
  // email anyway — then only the manual form (with a different email) helps.
  const canContinueAs =
    !!sessionEmail &&
    (artifact.gate_level !== "allowlist" || isAllowed(artifact, sessionEmail));
  const hidden = `<input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
  <input type="hidden" name="redirect_to" value="${escapeHtml(redirectTo)}">
  <input type="hidden" name="share_link_id" value="${escapeHtml(shareLinkId)}">`;
  const continueAs = canContinueAs
    ? `<p class="muted">You're signed in — continue with one click, or use a different email below.</p>
<form method="post" action="/_au/gate/session">
  ${hidden}
  <button type="submit">Continue as ${escapeHtml(sessionEmail)}</button>
</form>`
    : `<p class="muted">Enter your email to continue.</p>`;
  return htmlPage(
    artifact.title,
    `<h1>${escapeHtml(artifact.title)}</h1>
${continueAs}
<form method="post" action="${action}">
  ${hidden}
  <label>Email</label>
  <input name="email" type="email" autocomplete="email" value="${escapeHtml(prefillEmail || (canContinueAs ? sessionEmail : ""))}" required>
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
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      const email = normalizeEmail(String(form.get("email") || ""));
      if (!validEmail(email))
        return error(400, "invalid_email", "valid email required");
      const ipHash = await hashRateKey(requestIp(request));
      const emailLimit = await rateLimit(
        env,
        `gate:email:ip:hour:${ipHash}`,
        60,
        60 * 60,
      );
      if (!emailLimit.allowed)
        return rateLimitedResponse(emailLimit, request, artifact.title);
      const shareLinkId = String(form.get("share_link_id") || "") || null;
      const redirectTo = safeArtifactRedirect(
        env,
        artifact,
        request,
        form.get("redirect_to"),
      );
      return issueViewerSession(
        request,
        env,
        artifact,
        email,
        false,
        shareLinkId,
        redirectTo,
      );
    }

    if (request.method === "POST" && path === "/_au/gate/session") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      if (artifact.gate_level === "public")
        return error(400, "gate_not_required", "this artifact is not gated");
      // Consent must be a top-level form submit from this artifact's own gate
      // page. Published artifacts run untrusted JS on this same origin, so the
      // Referer path and fetch metadata are the line between a deliberate
      // click and a drive-by disclosure of the signed-in email.
      if (!consentRequestOk(request, env, artifact))
        return error(
          403,
          "consent_required",
          "continue from the artifact's own gate page",
        );
      const viewer = await signedInViewer(request, env, artifact);
      if (!viewer)
        return error(
          401,
          "sign_in_required",
          "no signed-in session; use the email form instead",
        );
      if (!viewer.member && !isAllowed(artifact, viewer.email))
        return wantsHtml(request)
          ? htmlPage(
              artifact.title,
              `<p class="error">This email is not allowed for this artifact.</p>`,
            )
          : error(
              403,
              "email_not_allowed",
              "this email is not allowed for this artifact",
            );
      // Shares the plain email gate's issuance bucket: one IP gets 60 viewer
      // sessions an hour across both paths.
      const ipHash = await hashRateKey(requestIp(request));
      const sessionLimit = await rateLimit(
        env,
        `gate:email:ip:hour:${ipHash}`,
        60,
        60 * 60,
      );
      if (!sessionLimit.allowed)
        return rateLimitedResponse(sessionLimit, request, artifact.title);
      return issueViewerSession(
        request,
        env,
        artifact,
        viewer.email,
        true,
        String(form.get("share_link_id") || "") || null,
        safeArtifactRedirect(env, artifact, request, form.get("redirect_to")),
      );
    }

    if (request.method === "POST" && path === "/_au/gate/start") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      if (!requiresVerified(artifact.gate_level))
        return error(
          400,
          "otp_not_required",
          "this artifact does not require email verification",
        );
      const email = normalizeEmail(String(form.get("email") || ""));
      if (!validEmail(email))
        return error(400, "invalid_email", "valid email required");
      if (!isAllowed(artifact, email))
        return wantsHtml(request)
          ? htmlPage(
              artifact.title,
              `<p class="error">This email is not allowed for this artifact.</p>`,
            )
          : error(
              403,
              "email_not_allowed",
              "this email is not allowed for this artifact",
            );
      const emailHash = await hashRateKey(email);
      const ipHash = await hashRateKey(requestIp(request));
      for (const [bucket, limit, windowSec] of [
        [`otp:start:email:hour:${emailHash}`, 3, 60 * 60],
        [`otp:start:email:day:${emailHash}`, 10, 24 * 60 * 60],
        [
          `otp:start:artifact:day:${artifact.id.slice(0, 80)}`,
          50,
          24 * 60 * 60,
        ],
        [`otp:start:ip:hour:${ipHash}`, 20, 60 * 60],
      ] as const) {
        const result = await rateLimit(env, bucket, limit, windowSec);
        if (!result.allowed)
          return rateLimitedResponse(result, request, artifact.title);
      }
      const redirectTo = safeArtifactRedirect(
        env,
        artifact,
        request,
        form.get("redirect_to"),
      );
      const shareLinkId = String(form.get("share_link_id") || "") || null;
      await env.DB.prepare(
        `UPDATE viewer_tokens SET used_at = ?
         WHERE artifact_id = ? AND email = ? AND used_at IS NULL`,
      )
        .bind(nowSec(), artifact.id, email)
        .run();
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
      try {
        await sendVerificationEmail(env, artifact, email, code, verifyUrl);
      } catch (deliveryError) {
        if (!(deliveryError instanceof EmailDeliveryError)) throw deliveryError;
        await env.DB.prepare(
          "UPDATE viewer_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL",
        )
          .bind(nowSec(), token)
          .run();
        return emailDeliveryUnavailable(request, env, artifact);
      }
      // Agent OTP self-serve: tell a non-browser caller how to verify the code.
      if (!wantsHtml(request))
        return json({
          status: "otp_sent",
          verify: `${env.SITE_BASE_URL}/_au/gate/verify`,
          artifact_key: artifact.url_key,
          email,
          instructions:
            "Read the one-time code from the email just sent to this address, then POST form {artifact_key, email, code} to `verify` with header 'Accept: application/json' to receive a bearer token.",
          ...(env.ALLOW_DEBUG_CODES === "true" ? { debug_code: code } : {}),
        });
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
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      if (!requiresVerified(artifact.gate_level))
        return error(
          400,
          "otp_not_required",
          "this artifact does not require email verification",
        );
      const email = normalizeEmail(String(form.get("email") || ""));
      const code = String(form.get("code") || "").trim();
      if (!validEmail(email))
        return error(400, "invalid_email", "valid email required");
      if (!/^\d{6}$/.test(code))
        return error(400, "invalid_code", "six-digit code required");
      const identityBucket = `otp:verify:identity:15m:${artifact.id.slice(0, 80)}:${await hashRateKey(email)}`;
      const identityLimit = await rateLimit(env, identityBucket, 6, 15 * 60);
      if (!identityLimit.allowed)
        return rateLimitedResponse(identityLimit, request, artifact.title);
      const ipLimit = await rateLimit(
        env,
        `otp:verify:ip:10m:${await hashRateKey(requestIp(request))}`,
        30,
        10 * 60,
      );
      if (!ipLimit.allowed)
        return rateLimitedResponse(ipLimit, request, artifact.title);
      const row = await env.DB.prepare(
        "SELECT token FROM viewer_tokens WHERE artifact_id = ? AND email = ? AND code = ? AND used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(artifact.id, email, code, nowSec())
        .first<{ token: string }>();
      if (!row)
        return wantsHtml(request)
          ? htmlPage(
              artifact.title,
              `<p class="error">Invalid or expired code.</p>`,
            )
          : error(401, "invalid_code", "invalid or expired code");
      await clearRateLimit(env, identityBucket, 15 * 60);
      return await consumeVerified(
        request,
        env,
        artifact,
        row.token,
        email,
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
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      return await consumeVerified(
        request,
        env,
        artifact,
        token,
        row.email,
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
  email: string,
  redirectTo: string,
  shareLinkId: string | null,
): Promise<Response> {
  await env.DB.prepare("UPDATE viewer_tokens SET used_at = ? WHERE token = ?")
    .bind(nowSec(), token)
    .run();
  return issueViewerSession(
    request,
    env,
    artifact,
    email,
    true,
    shareLinkId,
    redirectTo,
  );
}

// The gate/session consent POST must be a top-level navigation whose Referer
// points into the target artifact's own path. Fetch metadata can't be forged
// from JS (forbidden headers), and the gate page renders at the artifact URL
// with no artifact JS, so a passing request is a human's form submit there. A
// missing Referer is rejected: hostile artifacts control their own referrer
// policy, so absence proves nothing. Viewers who strip Referer globally still
// have the manual email form.
function consentRequestOk(
  request: Request,
  env: Env,
  artifact: Artifact,
): boolean {
  const mode = request.headers.get("Sec-Fetch-Mode");
  if (mode && mode !== "navigate") return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest && dest !== "document") return false;
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    const ref = new URL(referer);
    return (
      ref.origin === new URL(request.url).origin &&
      ref.pathname.startsWith(publicArtifactPath(env, artifact.url_key))
    );
  } catch {
    return false;
  }
}

// Shared tail of every gate flow: record the view, mint the 30-day session,
// and answer with a bearer token (agents / in-widget fetches) or a redirect
// (browsers). Callers must pass an already-sanitized redirectTo. Also the tail
// of the serve-time member auto-pass, which is why it is exported.
export async function issueViewerSession(
  request: Request,
  env: Env,
  artifact: Artifact,
  email: string,
  verified: boolean,
  shareLinkId: string | null,
  redirectTo: string,
): Promise<Response> {
  const viewId = await insertView(
    env,
    artifact,
    shareLinkId,
    email,
    verified,
    request,
  );
  const exp = nowSec() + 30 * 86400;
  const session = await signViewerSession(
    {
      artifact_id: artifact.id,
      version_id: artifact.current_version_id,
      email,
      verified,
      view_id: viewId,
      exp,
    },
    env,
  );
  const cookie = setViewerCookie(viewerCookieName(artifact.id), session);
  if (!wantsHtml(request))
    return json(
      { token: session, token_type: "Bearer", expires_at: exp },
      { headers: { "Set-Cookie": cookie } },
    );
  return redirectWithCookie(redirectTo, cookie);
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

function emailDeliveryUnavailable(
  request: Request,
  env: Env,
  artifact: Artifact,
): Response {
  if (!wantsHtml(request))
    return error(
      503,
      "email_temporarily_unavailable",
      "verification email could not be sent; try again later",
    );
  const page = htmlPage(
    artifact.title,
    `<h1>Email temporarily unavailable</h1>
<p class="error">No code was sent. Please try again later or ask the person who shared this artifact for help.</p>
<p><a href="${escapeHtml(publicArtifactPath(env, artifact.url_key))}">Back to the artifact</a></p>`,
  );
  return new Response(page.body, { status: 503, headers: page.headers });
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

function validEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email);
}
