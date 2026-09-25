import type { Artifact, Env, ViewerSession } from "./types";
import {
  readCookie,
  setViewerCookie,
  signViewerSession,
  verifyViewerSession,
  viewerCookieName,
} from "./auth";
import {
  getArtifactById,
  getArtifactByUrlKey,
  getShareLink,
  insertView,
  recordShareLinkOpen,
} from "./db";
import {
  type ShareLink,
  type ShareLinkState,
  normalizePasscode,
  shareLinkIdentity,
  shareLinkKind,
  shareLinkState,
  verifyPasscode,
} from "./links";
import { EmailDeliveryError, sendVerificationEmail } from "./mailer";
import { unavailableArtifactResponse } from "./moderation";
import { getPublisherSessionAuth } from "./publisher";
import { resolveWorkspaceOrg } from "./workspaces";
import {
  type RateLimitResult,
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
  notice = "",
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
${notice ? `<p class="error">${escapeHtml(notice)}</p>` : ""}
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
      // This route is the plain email gate only: a public artifact needs no
      // session, and a verified gate must go through the one-time code.
      if (artifact.gate_level === "public")
        return error(400, "gate_not_required", "this artifact is not gated");
      if (requiresVerified(artifact.gate_level))
        return error(
          400,
          "otp_required",
          "this artifact requires email verification; use /_au/gate/start",
        );
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
      // The plain gate takes the viewer's word for the address; the least we
      // can do is check that the domain can receive mail at all.
      if (!(await emailDomainAcceptsMail(email))) {
        const message = `${email.split("@")[1]} has no mail server; check the address`;
        return wantsHtml(request)
          ? renderGate(
              artifact,
              redirectTo,
              email,
              shareLinkId || "",
              "",
              message,
            )
          : error(400, "invalid_email_domain", message);
      }
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

    // Share links: the passcode form for `password` links, and the JSON way
    // in for every kind (recipient/open links pass with no passcode).
    if (request.method === "POST" && path === "/_au/gate/link") {
      const form = await request.formData();
      const artifact = await formArtifact(env, form);
      if (!artifact)
        return error(404, "artifact_not_found", "artifact not found");
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      const linkId = String(form.get("link") || "").trim();
      const link = linkId ? await getShareLink(env, artifact.id, linkId) : null;
      if (!link) return error(404, "link_not_found", "share link not found");
      const state = shareLinkState(link);
      if (state !== "active") return deadLinkResponse(request, artifact, state);
      const redirectTo = safeArtifactRedirect(
        env,
        artifact,
        request,
        form.get("redirect_to"),
      );
      if (shareLinkKind(link) === "password") {
        const check = await checkPasscode(
          request,
          env,
          link,
          normalizePasscode(form.get("passcode")),
        );
        if (check.result === "limited")
          return rateLimitedResponse(check.limit, request, artifact.title);
        if (check.result === "wrong")
          return wantsHtml(request)
            ? renderPasscodeGate(
                artifact,
                redirectTo,
                link.id,
                "That passcode is not right.",
              )
            : error(401, "invalid_passcode", "invalid passcode");
      }
      return issueViewerSession(
        request,
        env,
        artifact,
        shareLinkIdentity(link),
        false,
        link.id,
        redirectTo,
        true,
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
  // True only when the caller validated the share link itself (kind, state,
  // passcode). Form-supplied share_link_id values merely attribute the view.
  viaLink = false,
): Promise<Response> {
  const minted = await mintViewerSession(
    request,
    env,
    artifact,
    email,
    verified,
    shareLinkId,
    viaLink,
  );
  if (!wantsHtml(request))
    return json(
      { token: minted.token, token_type: "Bearer", expires_at: minted.exp },
      { headers: { "Set-Cookie": minted.cookie } },
    );
  return redirectWithCookie(redirectTo, minted.cookie);
}

// Record the view and sign the 30-day session; the caller decides how to
// answer (redirect, JSON token, or serve inline with the cookie attached).
export async function mintViewerSession(
  request: Request,
  env: Env,
  artifact: Artifact,
  email: string,
  verified: boolean,
  shareLinkId: string | null,
  viaLink = false,
): Promise<{
  session: ViewerSession;
  token: string;
  cookie: string;
  exp: number;
}> {
  const viewId = await insertView(
    env,
    artifact,
    shareLinkId,
    email,
    verified,
    request,
  );
  // One open per session: the counter moves here, never on asset requests.
  if (shareLinkId) await recordShareLinkOpen(env, artifact.id, shareLinkId);
  const exp = nowSec() + 30 * 86400;
  const session: ViewerSession = {
    artifact_id: artifact.id,
    version_id: artifact.current_version_id,
    email,
    verified,
    view_id: viewId,
    exp,
    ...(viaLink && shareLinkId ? { link_id: shareLinkId } : {}),
  };
  const token = await signViewerSession(session, env);
  const cookie = setViewerCookie(viewerCookieName(artifact.id), token);
  return { session, token, cookie, exp };
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

// RFC 5322-ish without the exotic forms: one @, a dot-atom local part of at
// most 64 characters, and a hostname with at least one dot and an alphabetic
// TLD. Stops "a@b", "x@localhost" and "@@" — 13% of viewer identities were
// junk of exactly that shape.
export function validEmail(email: string): boolean {
  if (email.length > 320) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || email.indexOf("@") !== at) return false;
  if (!LOCAL_PART_RE.test(local)) return false;
  return validEmailDomain(domain);
}

const LOCAL_PART_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

function validEmailDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] || "";
  if (!/^[a-z]{2,63}$/i.test(tld)) return false;
  return labels.every((label) =>
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
  );
}

// Does the domain publish an MX (or, failing that, an A/AAAA) record? Asked
// over DNS-over-HTTPS so the plain email gate rejects typos and made-up
// domains without ever sending mail. Fails open: a DNS outage must not lock
// viewers out of a gate that only ever took their word anyway.
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 2000;
const DOMAIN_CACHE_OK_SEC = 6 * 60 * 60;
const DOMAIN_CACHE_BAD_SEC = 10 * 60;
const DOMAIN_CACHE_MAX = 5000;
const domainCache = new Map<string, { ok: boolean; exp: number }>();

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type?: number }>;
}

export async function emailDomainAcceptsMail(email: string): Promise<boolean> {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) return false;
  const now = nowSec();
  const cached = domainCache.get(domain);
  if (cached && cached.exp > now) return cached.ok;
  let ok: boolean;
  try {
    const mx = await dohQuery(domain, "MX");
    if (mx === null) return true;
    ok =
      mx ||
      (await dohQuery(domain, "A")) === true ||
      (await dohQuery(domain, "AAAA")) === true;
  } catch {
    return true;
  }
  if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear();
  domainCache.set(domain, {
    ok,
    exp: now + (ok ? DOMAIN_CACHE_OK_SEC : DOMAIN_CACHE_BAD_SEC),
  });
  return ok;
}

// true: records exist; false: authoritative "nothing there"; null: the
// resolver could not answer (treated as accept by the caller).
async function dohQuery(
  domain: string,
  type: "MX" | "A" | "AAAA",
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as DohAnswer;
    // 0 NOERROR, 3 NXDOMAIN; anything else is a resolver problem.
    if (body.Status === 3) return false;
    if (body.Status !== 0) return null;
    const wanted = type === "MX" ? 15 : type === "A" ? 1 : 28;
    return (body.Answer || []).some((answer) => answer.type === wanted);
  } finally {
    clearTimeout(timer);
  }
}

// Test seam: the cache is per isolate and would otherwise leak between cases.
export function resetEmailDomainCache(): void {
  domainCache.clear();
}

// ---- share links ---------------------------------------------------------

const PASSCODE_ATTEMPTS = 10;
const PASSCODE_WINDOW_SEC = 15 * 60;

function passcodeBucket(linkId: string, ipHash: string): string {
  return `gate:link:15m:${linkId.slice(0, 40)}:${ipHash}`;
}

type PasscodeCheck =
  { result: "ok" | "wrong" } | { result: "limited"; limit: RateLimitResult };

// Ten guesses per link and IP per quarter hour; the window clears on success
// so a viewer who mistyped twice is not locked out after getting it right.
async function checkPasscode(
  request: Request,
  env: Env,
  link: ShareLink,
  passcode: string,
): Promise<PasscodeCheck> {
  const bucket = passcodeBucket(link.id, await hashRateKey(requestIp(request)));
  const limit = await rateLimit(
    env,
    bucket,
    PASSCODE_ATTEMPTS,
    PASSCODE_WINDOW_SEC,
  );
  if (!limit.allowed) return { result: "limited", limit };
  if (!passcode || !(await verifyPasscode(link, passcode)))
    return { result: "wrong" };
  await clearRateLimit(env, bucket, PASSCODE_WINDOW_SEC);
  return { result: "ok" };
}

// `Authorization: Basic base64(<link id>:<passcode>)` on the artifact URL —
// the curl-friendly way through a password link. The username may also be
// left empty when `?v=<link id>` is on the URL.
export function basicCredentials(
  request: Request,
): { user: string; pass: string } | null {
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!m || !m[1]) return null;
  try {
    const decoded = atob(m[1].trim());
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export type LinkAccess =
  | { kind: "none" }
  | { kind: "dead"; link: ShareLink; state: ShareLinkState }
  | { kind: "passcode"; link: ShareLink; wrong: boolean }
  | { kind: "limited"; link: ShareLink; limit: RateLimitResult }
  | { kind: "pass"; link: ShareLink };

// Decide what a request carrying `?v=<link id>` (or a Basic username) may
// do: pass straight through (recipient/open, or password with a correct
// Basic passcode), show the passcode form, or see the 410 for a dead link.
export async function resolveLinkAccess(
  request: Request,
  env: Env,
  artifact: Artifact,
  linkId: string | null,
): Promise<LinkAccess> {
  const basic = basicCredentials(request);
  const id = (linkId || basic?.user || "").trim().slice(0, 64);
  if (!id) return { kind: "none" };
  const link = await getShareLink(env, artifact.id, id);
  if (!link) return { kind: "none" };
  const state = shareLinkState(link);
  if (state !== "active") return { kind: "dead", link, state };
  if (shareLinkKind(link) !== "password") return { kind: "pass", link };
  if (!basic?.pass) return { kind: "passcode", link, wrong: false };
  const check = await checkPasscode(
    request,
    env,
    link,
    normalizePasscode(basic.pass),
  );
  if (check.result === "limited")
    return { kind: "limited", link, limit: check.limit };
  return check.result === "ok"
    ? { kind: "pass", link }
    : { kind: "passcode", link, wrong: true };
}

export function renderPasscodeGate(
  artifact: Artifact,
  redirectTo: string,
  linkId: string,
  notice = "",
): Response {
  return htmlPage(
    artifact.title,
    `<h1>${escapeHtml(artifact.title)}</h1>
<p class="muted">This link is protected. Enter the passcode you were given to continue.</p>
${notice ? `<p class="error">${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/_au/gate/link">
  <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
  <input type="hidden" name="redirect_to" value="${escapeHtml(redirectTo)}">
  <input type="hidden" name="link" value="${escapeHtml(linkId)}">
  <label>Passcode</label>
  <input name="passcode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  <button type="submit">Continue</button>
</form>`,
  );
}

const DEAD_LINK_COPY: Record<Exclude<ShareLinkState, "active">, string> = {
  expired: "This link has expired.",
  revoked: "This link was revoked.",
  exhausted: "This link has reached its open limit.",
};

// 410 for a link that no longer works, in both shapes. The bare artifact URL
// is deliberately not offered: the sender decides who gets a fresh link.
export function deadLinkResponse(
  request: Request,
  artifact: Artifact,
  state: ShareLinkState,
): Response {
  const reason = state === "active" ? "expired" : state;
  const copy = DEAD_LINK_COPY[reason];
  if (!wantsHtml(request))
    return json(
      {
        error: { code: `link_${reason}`, message: copy },
        link_state: reason,
      },
      { status: 410 },
    );
  const page = htmlPage(
    artifact.title,
    `<h1>This link no longer works</h1>
<p class="error">${escapeHtml(copy)}</p>
<p class="muted">Ask the person who shared it with you for a new link.</p>`,
  );
  return new Response(page.body, { status: 410, headers: page.headers });
}
