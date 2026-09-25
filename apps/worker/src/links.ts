// Share links: the sharing primitive for gated artifacts. A link passes the
// artifact's gate on the publisher's say-so — it is an explicit grant, so it
// works at every gate level and is withdrawn by revoking it.
//
//   recipient  the URL itself is the credential for one named person; views
//              are attributed to recipient_email (unverified) or, without an
//              email, to link:<id>
//   password   the viewer types a passcode (no email asked); identity link:<id>
//   open       anyone holding the unguessable id passes; identity link:<id>
//
// Every kind honours expires_at, revoked_at and max_opens. The passcode is
// hashed with PBKDF2-SHA256 and a per-link salt; it is returned exactly once,
// in the creation response, and never stored.
import type { Env } from "./types";
import { nowSec, publicArtifactUrl } from "./util";

export type ShareLinkKind = "recipient" | "password" | "open";
export type ShareLinkState = "active" | "expired" | "revoked" | "exhausted";

export const SHARE_LINK_KINDS: readonly ShareLinkKind[] = [
  "recipient",
  "password",
  "open",
];

export interface ShareLink {
  id: string;
  artifact_id: string;
  // Columns added by migration 0014 are optional so rows read through older
  // projections (or fixtures) still behave as legacy recipient links.
  kind?: ShareLinkKind | string | null;
  label?: string | null;
  recipient_email: string | null;
  recipient_label: string | null;
  password_hash?: string | null;
  password_salt?: string | null;
  max_opens?: number | null;
  open_count?: number | null;
  last_opened_at?: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_by?: string | null;
  created_at: number;
  view_count?: number | null;
}

// One sentence, said out loud wherever a link is handed over.
export const UNLISTED_NOTE =
  "Every artifact URL is unlisted: search engines are told not to index it, and only people holding the URL (or a share link) can open it.";

export function shareLinkKind(link: Pick<ShareLink, "kind">): ShareLinkKind {
  return link.kind === "password" || link.kind === "open"
    ? link.kind
    : "recipient";
}

export function shareLinkState(
  link: ShareLink,
  now = nowSec(),
): ShareLinkState {
  if (link.revoked_at) return "revoked";
  if (link.expires_at && link.expires_at < now) return "expired";
  const max = Number(link.max_opens || 0);
  if (max > 0 && Number(link.open_count || 0) >= max) return "exhausted";
  return "active";
}

// The identity a view is recorded under when the link passes the gate.
export function shareLinkIdentity(link: ShareLink): string {
  if (shareLinkKind(link) === "recipient" && link.recipient_email)
    return link.recipient_email;
  return `link:${link.id}`;
}

export function shareLinkUrl(env: Env, urlKey: string, id: string): string {
  return `${publicArtifactUrl(env, urlKey)}?v=${encodeURIComponent(id)}`;
}

// The link object every API, MCP and admin response returns. Never includes
// the hash or salt.
export function shareLinkJson(
  env: Env,
  urlKey: string,
  link: ShareLink,
  now = nowSec(),
): Record<string, unknown> {
  return {
    id: link.id,
    kind: shareLinkKind(link),
    label: link.label || null,
    recipient_email: link.recipient_email || null,
    recipient_label: link.recipient_label || null,
    url: shareLinkUrl(env, urlKey, link.id),
    state: shareLinkState(link, now),
    expires_at: link.expires_at || null,
    revoked_at: link.revoked_at || null,
    max_opens: link.max_opens || null,
    open_count: Number(link.open_count || 0),
    last_opened_at: link.last_opened_at || null,
    view_count: Number(link.view_count || 0),
    created_at: link.created_at,
  };
}

// Unambiguous lower-case alphabet (no 0/o, 1/l/i): three groups of four,
// ~59 bits of entropy, easy to read out over a call.
const PASSCODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generatePasscode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map(
    (b) => PASSCODE_ALPHABET[b % PASSCODE_ALPHABET.length],
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export const PASSCODE_MIN = 6;
export const PASSCODE_MAX = 72;

export function normalizePasscode(value: unknown): string {
  return String(value ?? "").trim();
}

// Workers cap PBKDF2 at 100,000 iterations; 50,000 keeps a verify well under
// the CPU budget while making offline guessing of a leaked hash expensive.
const PBKDF2_ITERATIONS = 50_000;

export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashPasscode(
  passcode: string,
  saltHex: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromHex(saltHex) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function verifyPasscode(
  link: ShareLink,
  passcode: string,
): Promise<boolean> {
  if (!link.password_hash || !link.password_salt) return false;
  const candidate = await hashPasscode(passcode, link.password_salt);
  return constantTimeEqual(candidate, link.password_hash);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Access presets: friendlier names for the four gate levels. No new levels —
// `client` is verified_email, the "share with a client" preset.
export const ACCESS_PRESETS = {
  open: "public",
  email: "email",
  client: "verified_email",
  restricted: "allowlist",
} as const;

export function gateLevelForPreset(
  preset: unknown,
): (typeof ACCESS_PRESETS)[keyof typeof ACCESS_PRESETS] | null {
  const key = String(preset || "") as keyof typeof ACCESS_PRESETS;
  return Object.prototype.hasOwnProperty.call(ACCESS_PRESETS, key)
    ? ACCESS_PRESETS[key]
    : null;
}
