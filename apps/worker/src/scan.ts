// Publish-time secret detection. An artifact URL is unlisted, not private:
// anyone who has the link and passes the gate can read every file, so a
// credential pasted into a demo page or a bundled .env is a leak the moment
// it is published. Patterns are deliberately narrow (provider prefixes, fixed
// lengths, mixed character classes, placeholder rejection) so ordinary HTML
// with base64 images, UUIDs, hashes, and CSS class names passes untouched.
// False negatives are acceptable; a false positive blocks a publish.

export interface Finding {
  path: string;
  kind: string;
  line: number;
  // First four characters of the matched secret followed by an ellipsis;
  // enough to recognise the credential, never enough to use it.
  preview: string;
}

// Publish-level caps: how many files one completion reads back from R2, the
// largest file read, and how many findings are reported before scanning
// stops. A handful of findings is enough to act on; the rest are noise.
export const MAX_SCAN_FILES = 200;
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;
export const MAX_FINDINGS = 20;

interface Pattern {
  kind: string;
  // Must carry the g flag; group 1, when present, is the secret value.
  regex: RegExp;
  accept?: (secret: string) => boolean;
}

const PATTERNS: Pattern[] = [
  {
    kind: "private_key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { kind: "aws_access_key_id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "aws_secret_access_key",
    regex:
      /\baws_secret[a-z_]*["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    accept: mixedCaseWithDigit,
  },
  { kind: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: "anthropic_api_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    // Not preceded by a word, dot, hash, slash, or hyphen so CSS selectors
    // (.sk-circle) and hyphenated words (task-manager) never start a match.
    kind: "openai_api_key",
    regex: /(?<![\w.#/-])sk-(?!ant-)(?:proj-)?([A-Za-z0-9_-]{20,})/g,
    accept: mixedCaseWithDigit,
  },
  { kind: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_live_key", regex: /\brk_live_[A-Za-z0-9]{16,}\b/g },
  {
    // Stripe and WorkOS both issue sk_live_ / sk_test_ secret keys.
    kind: "stripe_or_workos_secret_key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    kind: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  {
    // header.payload(.signature): two base64url JSON objects ("eyJ" is `{"`).
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  },
  {
    // This service's own creator tokens: au_creator_<payload>.<signature>.
    kind: "artifact_use_creator_token",
    regex: /\bau_creator_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  },
  {
    // Plain, JSON-keyed, and env-file assignments: client_secret = "…",
    // "clientSecret": "…", API_SECRET=…
    kind: "client_secret_assignment",
    regex:
      /\b(?:client[_-]?secret|api[_-]?secret|secret[_-]?key)\b["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9_\-./+=]{24,})/gi,
    accept: (secret) => letterAndDigit(secret) && !looksLikePlaceholder(secret),
  },
];

const TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "map",
  "txt",
  "md",
  "markdown",
  "svg",
  "xml",
  "csv",
  "yaml",
  "yml",
  "env",
]);

// Files worth reading back for a scan: anything served as text, plus the
// text-shaped types some clients label loosely (JSON, JS, SVG, XML).
export function isTextLike(contentType: string, path: string): boolean {
  const mime = (contentType.split(";", 1)[0] || "").trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (
    /^application\/(?:json|ld\+json|manifest\+json|javascript|x-javascript|ecmascript|xml|xhtml\+xml)$/.test(
      mime,
    )
  )
    return true;
  if (mime === "image/svg+xml") return true;
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return TEXT_EXTENSIONS.has(ext);
}

export function scanForSecrets(
  text: string,
  path: string,
  limit = MAX_FINDINGS,
): Finding[] {
  if (limit <= 0 || !text) return [];
  const candidates: Array<{
    start: number;
    end: number;
    kind: string;
    secret: string;
  }> = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let taken = 0;
    for (
      let match = pattern.regex.exec(text);
      match && taken < limit;
      match = pattern.regex.exec(text)
    ) {
      // Every pattern consumes at least one character, so lastIndex always
      // advances; this guard only protects against a future zero-width edit.
      if (match[0].length === 0) pattern.regex.lastIndex += 1;
      const secret = match[1] ?? match[0];
      if (pattern.accept && !pattern.accept(secret)) continue;
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: pattern.kind,
        secret,
      });
      taken += 1;
    }
  }
  // Earliest match wins where two patterns cover the same bytes, e.g. a
  // client_secret assignment whose value is itself an sk_live_ key.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const findings: Finding[] = [];
  const lineStarts = lineStartOffsets(text);
  let coveredUntil = -1;
  for (const candidate of candidates) {
    if (findings.length >= limit) break;
    if (candidate.start < coveredUntil) continue;
    coveredUntil = candidate.end;
    findings.push({
      path,
      kind: candidate.kind,
      line: lineAt(lineStarts, candidate.start),
      preview: mask(candidate.secret),
    });
  }
  return findings;
}

// A truthy allow_secrets on the publish body (JSON true, or "true" from a
// form-shaped client) turns findings into warnings instead of a refusal.
export function allowsSecrets(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = (body as { allow_secrets?: unknown }).allow_secrets;
  return value === true || value === "true";
}

export function secretsDetectedMessage(findings: Finding[]): string {
  const files = new Set(findings.map((f) => f.path));
  return (
    `Found ${findings.length} probable credential${findings.length === 1 ? "" : "s"} ` +
    `in ${files.size} file${files.size === 1 ? "" : "s"} (see findings). ` +
    "Nothing was published: remove them and retry, or pass allow_secrets: true to publish anyway. " +
    "Anyone who has the link and passes the gate can read every file of an artifact."
  );
}

function mask(secret: string): string {
  return `${secret.slice(0, 4)}…`;
}

function mixedCaseWithDigit(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

function letterAndDigit(value: string): boolean {
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function looksLikePlaceholder(value: string): boolean {
  return (
    /example|placeholder|your[_-]?|xxx|changeme|redacted|dummy|sample|\$\{|\{\{|</i.test(
      value,
    ) || /^[A-Z0-9_]+$/.test(value)
  );
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
