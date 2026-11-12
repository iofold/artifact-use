// The share sheet's server side: one read ("who can open this artifact, and
// through which links") and one write (gate level plus allowlist edits) for
// the signed-in publisher. It lives on the trusted admin origin only. The
// artifact page reaches it through a link, never through an API: the widget
// shares a JS realm with untrusted artifact content, so nothing on an
// artifact host can mint a link, change the gate or read who was invited.
import {
  getArtifactUpstream,
  listShareLinks,
  updateArtifactAccess,
} from "./db";
import { validEmail, validEmailDomain } from "./gate";
import { shareLinkJson } from "./links";
import type { Artifact, Env, GateLevel } from "./types";
import {
  GATE_LEVELS,
  error,
  normalizeEmail,
  publicArtifactUrl,
  siteBaseUrl,
} from "./util";

export interface Allowlist {
  emails: string[];
  domains: string[];
}

// Enough for a real review group; keeps one row from growing without bound.
export const ALLOWLIST_MAX = 500;

// Exactly what shareSheetPath produces; the one address /admin/switch will
// return to.
export const SHARE_SHEET_PATH_RE = /^\/admin\/share\?artifact=art_[\w-]+$/;

export function shareSheetPath(artifactId: string): string {
  return `/admin/share?artifact=${encodeURIComponent(artifactId)}`;
}

export function shareSheetUrl(env: Env, artifactId: string): string {
  return `${siteBaseUrl(env)}${shareSheetPath(artifactId)}`;
}

// What is stored today, for display and for merging. Tolerant on purpose: a
// malformed stored policy reads as empty here (isAllowed already treats it as
// "nobody"), so the next save from the sheet repairs it.
export function readAllowlist(value: string | null | undefined): Allowlist {
  if (!value) return { emails: [], domains: [] };
  try {
    const parsed = JSON.parse(value) as { emails?: unknown; domains?: unknown };
    const strings = (list: unknown) =>
      Array.isArray(list)
        ? list.filter((item): item is string => typeof item === "string")
        : [];
    return dedupe({
      emails: strings(parsed?.emails)
        .map((email) => normalizeEmail(email))
        .filter(validEmail),
      domains: strings(parsed?.domains)
        .map(normalizeDomain)
        .filter(validEmailDomain),
    });
  } catch {
    return { emails: [], domains: [] };
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^@/, "");
}

function dedupe(list: Allowlist): Allowlist {
  return {
    emails: [...new Set(list.emails)],
    domains: [...new Set(list.domains)],
  };
}

// People type and paste freely: one entry per line, or separated by commas,
// semicolons or spaces. `jane@acme.com` is a person, `acme.com` (or
// `@acme.com`) everyone at that domain. Anything else is reported back by
// name instead of being saved: one bad entry in a stored allowlist makes
// isAllowed refuse everybody.
export function parseAllowlistEntries(
  input: unknown,
): { ok: true; list: Allowlist } | { ok: false; invalid: string[] } {
  const raw = Array.isArray(input) ? input : [input];
  const entries = raw
    .flatMap((item) => String(item ?? "").split(/[\s,;]+/))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const list: Allowlist = { emails: [], domains: [] };
  const invalid: string[] = [];
  for (const entry of entries) {
    if (entry.lastIndexOf("@") > 0) {
      const email = normalizeEmail(entry);
      if (validEmail(email)) list.emails.push(email);
      else invalid.push(entry);
      continue;
    }
    const domain = normalizeDomain(entry);
    if (validEmailDomain(domain)) list.domains.push(domain);
    else invalid.push(entry);
  }
  return invalid.length
    ? { ok: false, invalid }
    : { ok: true, list: dedupe(list) };
}

// A whole policy handed over at once ({emails, domains}, as the REST API and
// MCP send it). Returns the JSON to store, or the entries that are not an
// address or a domain.
export function normalizeAllowlistPolicy(
  value: unknown,
): { ok: true; json: string } | { ok: false; message: string } {
  if (value === null) return { ok: true, json: JSON.stringify(emptyList()) };
  if (typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      message:
        'allowlist must be an object: {"emails": [...], "domains": [...]}',
    };
  const { emails = [], domains = [] } = value as {
    emails?: unknown;
    domains?: unknown;
  };
  if (!Array.isArray(emails) || !Array.isArray(domains))
    return {
      ok: false,
      message: "allowlist.emails and allowlist.domains must be arrays",
    };
  const list: Allowlist = { emails: [], domains: [] };
  const invalid: string[] = [];
  for (const item of emails) {
    const email = typeof item === "string" ? normalizeEmail(item) : "";
    if (email && validEmail(email)) list.emails.push(email);
    else invalid.push(String(item));
  }
  for (const item of domains) {
    const domain = typeof item === "string" ? normalizeDomain(item) : "";
    if (domain && validEmailDomain(domain)) list.domains.push(domain);
    else invalid.push(String(item));
  }
  if (invalid.length) return { ok: false, message: invalidMessage(invalid) };
  const clean = dedupe(list);
  if (clean.emails.length + clean.domains.length > ALLOWLIST_MAX)
    return { ok: false, message: tooManyMessage() };
  return { ok: true, json: JSON.stringify(clean) };
}

function emptyList(): Allowlist {
  return { emails: [], domains: [] };
}

function invalidMessage(invalid: string[]): string {
  const shown = invalid.slice(0, 5).join(", ");
  const more = invalid.length > 5 ? ` and ${invalid.length - 5} more` : "";
  return `not an email address or a domain: ${shown}${more}`;
}

function tooManyMessage(): string {
  return `an allowlist holds at most ${ALLOWLIST_MAX} entries; allow a whole domain instead`;
}

// Everything the sheet shows. Share-link URLs are bearer credentials, which
// is why this is answered to the publisher's admin session alone.
export async function shareStateJson(
  env: Env,
  artifact: Artifact,
): Promise<Record<string, unknown>> {
  const [links, upstream] = await Promise.all([
    listShareLinks(env, artifact.id),
    getArtifactUpstream(env, artifact.id),
  ]);
  return {
    artifact: {
      id: artifact.id,
      url_key: artifact.url_key,
      title: artifact.title,
      url: publicArtifactUrl(env, artifact.url_key),
      gate_level: artifact.gate_level,
      status: artifact.status,
      org_suspended: Boolean(artifact.org_suspended),
      // An upstream backend is only reachable through a gate, so the sheet
      // does not offer "anyone with the link" while one is attached.
      has_upstream: Boolean(upstream),
      allowlist: readAllowlist(artifact.allowlist_json),
    },
    links: links.map((link) => shareLinkJson(env, artifact.url_key, link)),
  };
}

// One access change from the sheet: a gate level, people or domains to add,
// people or domains to remove — any combination. Additions and removals are
// merged into the stored list, so two people sharing at once do not overwrite
// each other's whole list the way a textarea save did.
export async function applyAccessChange(
  env: Env,
  artifact: Artifact,
  body: { gate_level?: unknown; add?: unknown; remove?: unknown },
): Promise<Artifact | Response> {
  let level: GateLevel | null = null;
  if (body.gate_level !== undefined && body.gate_level !== null) {
    const wanted = String(body.gate_level);
    if (!GATE_LEVELS.has(wanted))
      return error(400, "invalid_gate_level", "gate_level is not supported");
    level = wanted as GateLevel;
  }
  const guarded = await publicNeedsNoUpstream(env, artifact, level);
  if (guarded) return guarded;
  const add = body.add === undefined ? null : parseAllowlistEntries(body.add);
  if (add && !add.ok)
    return error(400, "invalid_allowlist_entry", invalidMessage(add.invalid));
  const remove =
    body.remove === undefined ? null : parseAllowlistEntries(body.remove);
  let allowlistJson: string | undefined;
  if (add || remove) {
    const current = readAllowlist(artifact.allowlist_json);
    // An entry that cannot be parsed cannot be in the list either, so a
    // removal that does not parse simply removes nothing.
    const drop = remove?.ok ? remove.list : emptyList();
    const next = dedupe({
      emails: [...current.emails, ...(add?.list.emails || [])].filter(
        (email) => !drop.emails.includes(email),
      ),
      domains: [...current.domains, ...(add?.list.domains || [])].filter(
        (domain) => !drop.domains.includes(domain),
      ),
    });
    if (next.emails.length + next.domains.length > ALLOWLIST_MAX)
      return error(400, "allowlist_too_long", tooManyMessage());
    allowlistJson = JSON.stringify(next);
  }
  if (!level && allowlistJson === undefined) return artifact;
  return updateArtifactAccess(env, artifact, null, level, allowlistJson);
}

// Shared by every path that can set a gate level: an artifact with an
// upstream backend must keep a gate (see upstream.ts).
export async function publicNeedsNoUpstream(
  env: Env,
  artifact: Artifact,
  level: string | null,
): Promise<Response | null> {
  if (level !== "public") return null;
  if (!(await getArtifactUpstream(env, artifact.id))) return null;
  return error(
    409,
    "upstream_requires_gate",
    "this artifact has an upstream backend; clear it before making the artifact public",
  );
}
