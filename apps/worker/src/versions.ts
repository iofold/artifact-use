// Versions: every completed publish of an artifact is kept and addressable.
//
//   list      GET  /api/v1/artifacts/{key}/versions
//   view      GET  {artifact url}_v/{version_id}/[path]   (serve.ts)
//   promote   POST /api/v1/artifacts/{key}/versions/{id}/promote
//   diff      GET  /api/v1/artifacts/{key}/versions/{from}/diff/{to}
//
// Rolling back is promoting an older version: the stable URL serves it again
// and the newer versions stay listed and viewable. `current` and `previous`
// are accepted wherever a version id is, so an agent can ask "what changed in
// the last publish" without listing first.
import type { Artifact, ArtifactFile, ArtifactVersion, Env } from "./types";
import {
  getVersion,
  getVersionForArtifact,
  listCompleteVersions,
  listFilesForVersion,
  setCurrentVersion,
} from "./db";
import { unifiedDiff } from "./diff";
import {
  error,
  escapeHtml,
  publicArtifactPath,
  publicArtifactUrl,
  siteBaseUrl,
} from "./util";

// Reserved path segment under an artifact URL; validateAssetPath rejects
// `_`-prefixed paths, so no published file can ever shadow it.
export const VERSION_SEGMENT = "_v";

// Diff budgets: files larger than this, binary files, and everything past
// the file or byte cap are reported by status only.
export const DIFF_MAX_FILE_BYTES = 200 * 1024;
export const DIFF_MAX_FILES = 50;
export const DIFF_MAX_TOTAL_BYTES = 300 * 1024;
const DIFF_TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "txt",
  "md",
  "svg",
  "xml",
  "csv",
]);

export function versionPath(
  env: Env,
  urlKey: string,
  versionId: string,
): string {
  return `${publicArtifactPath(env, urlKey)}${VERSION_SEGMENT}/${encodeURIComponent(versionId)}/`;
}

export function versionUrl(
  env: Env,
  urlKey: string,
  versionId: string,
): string {
  return `${siteBaseUrl(env)}${versionPath(env, urlKey, versionId)}`;
}

export interface PublishLinks {
  artifact: string;
  version: string;
  review: string;
}

// Attached to every publish result and version listing. `review` is the
// reviewer-facing link; today it is the stable URL, and the key is kept so a
// distinct review surface can replace it without changing callers.
export function publishLinks(
  env: Env,
  urlKey: string,
  versionId: string | null,
): PublishLinks {
  const artifact = publicArtifactUrl(env, urlKey);
  return {
    artifact,
    version: versionId ? versionUrl(env, urlKey, versionId) : artifact,
    review: artifact,
  };
}

export function versionJson(
  env: Env,
  artifact: Artifact,
  version: ArtifactVersion,
): Record<string, unknown> {
  return {
    id: version.id,
    created_at: version.created_at,
    completed_at: version.completed_at,
    file_count: Number(version.file_count || 0),
    total_size: Number(version.total_size || 0),
    entrypoint: version.entrypoint,
    created_by: version.created_by,
    current: version.id === artifact.current_version_id,
    url: versionUrl(env, artifact.url_key, version.id),
  };
}

export async function listVersions(
  env: Env,
  artifact: Artifact,
): Promise<{ versions: Record<string, unknown>[] }> {
  const versions = await listCompleteVersions(env, artifact.id);
  return {
    versions: versions.map((version) => versionJson(env, artifact, version)),
  };
}

export function isVersionRef(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

// `current`, `previous` (the complete version before the current one), or a
// version id; null when nothing complete matches within this artifact.
export async function resolveVersionRef(
  env: Env,
  artifact: Artifact,
  ref: string,
): Promise<ArtifactVersion | null> {
  if (ref === "current") {
    if (!artifact.current_version_id) return null;
    const current = await getVersion(env, artifact.current_version_id);
    return current && current.artifact_id === artifact.id ? current : null;
  }
  if (ref === "previous") {
    const versions = await listCompleteVersions(env, artifact.id);
    const at = versions.findIndex((v) => v.id === artifact.current_version_id);
    return at >= 0 ? versions[at + 1] || null : versions[1] || null;
  }
  const version = await getVersionForArtifact(env, artifact.id, ref);
  return version && version.status === "complete" ? version : null;
}

export interface PromoteResult {
  artifact: Artifact;
  version: ArtifactVersion;
  links: PublishLinks;
  changed: boolean;
}

// Point the stable URL at a version. Only complete versions of this very
// artifact qualify: a draft has nothing to serve and a foreign id must read
// as "not found", never as a hint that it exists elsewhere.
export async function promoteVersion(
  env: Env,
  artifact: Artifact,
  versionId: string,
): Promise<PromoteResult | Response> {
  const version = await getVersionForArtifact(env, artifact.id, versionId);
  if (!version)
    return error(
      404,
      "version_not_found",
      "version not found on this artifact",
    );
  if (version.status !== "complete")
    return error(
      409,
      "version_not_complete",
      "only completed versions can be promoted",
    );
  const changed = artifact.current_version_id !== version.id;
  const updated = changed
    ? await setCurrentVersion(env, artifact, version.id)
    : artifact;
  return {
    artifact: updated,
    version,
    links: publishLinks(env, updated.url_key, version.id),
    changed,
  };
}

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface DiffFile {
  path: string;
  status: DiffStatus;
  size_from: number | null;
  size_to: number | null;
  sha_from: string | null;
  sha_to: string | null;
  diff?: string;
}

export interface VersionDiff {
  from: string;
  to: string;
  from_created_at: number;
  to_created_at: number;
  files: DiffFile[];
  summary: Record<DiffStatus, number>;
  truncated: boolean;
}

export function isDiffableText(file: ArtifactFile): boolean {
  const media = (file.content_type || "").split(";")[0]?.trim().toLowerCase();
  if (media && media.startsWith("text/")) return true;
  if (media === "application/json" || media === "application/javascript")
    return true;
  if (media === "image/svg+xml" || media === "application/xml") return true;
  const ext = file.path.split(".").pop()?.toLowerCase() || "";
  return DIFF_TEXT_EXTENSIONS.has(ext);
}

// File-level status from the two manifests, plus a unified diff for changed
// text files within the budgets. Reads R2 only for files that need it.
export async function diffVersions(
  env: Env,
  artifact: Artifact,
  from: ArtifactVersion,
  to: ArtifactVersion,
): Promise<VersionDiff> {
  const [fromFiles, toFiles] = await Promise.all([
    listFilesForVersion(env, from.id),
    listFilesForVersion(env, to.id),
  ]);
  const fromByPath = new Map(fromFiles.map((f) => [f.path, f]));
  const toByPath = new Map(toFiles.map((f) => [f.path, f]));
  const paths = [...new Set([...fromByPath.keys(), ...toByPath.keys()])].sort();
  const files: DiffFile[] = [];
  const summary: Record<DiffStatus, number> = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  };
  let diffed = 0;
  let bytes = 0;
  let truncated = false;
  for (const path of paths) {
    const a = fromByPath.get(path) || null;
    const b = toByPath.get(path) || null;
    const entry: DiffFile = {
      path,
      status: "unchanged",
      size_from: a ? a.size : null,
      size_to: b ? b.size : null,
      sha_from: a?.sha256 || null,
      sha_to: b?.sha256 || null,
    };
    const readable = Boolean(a && b && diffable(a) && diffable(b));
    let texts: [string | null, string | null] | null = null;
    const read = async () =>
      (texts ??= await Promise.all([
        readText(env, a!.storage_key),
        readText(env, b!.storage_key),
      ]));
    if (!a) entry.status = "added";
    else if (!b) entry.status = "removed";
    else if (a.sha256 && b.sha256)
      entry.status = a.sha256 === b.sha256 ? "unchanged" : "changed";
    else if (a.size !== b.size) entry.status = "changed";
    else if (readable) {
      // No hash to compare (single-file HTML publishes from before hashes
      // were recorded): same size, so read both and compare the bytes.
      const [textA, textB] = await read();
      entry.status =
        textA !== null && textB !== null && textA === textB
          ? "unchanged"
          : "changed";
    }
    if (entry.status === "changed" && readable) {
      if (diffed >= DIFF_MAX_FILES || bytes >= DIFF_MAX_TOTAL_BYTES)
        truncated = true;
      else {
        const [textA, textB] = await read();
        const size =
          textA !== null && textB !== null
            ? attachDiff(entry, textA, textB, bytes)
            : 0;
        if (size === null) truncated = true;
        else {
          diffed += 1;
          bytes += size;
        }
      }
    }
    summary[entry.status] += 1;
    files.push(entry);
  }
  return {
    from: from.id,
    to: to.id,
    from_created_at: from.created_at,
    to_created_at: to.created_at,
    files,
    summary,
    truncated,
  };
}

function diffable(file: ArtifactFile): boolean {
  return isDiffableText(file) && file.size <= DIFF_MAX_FILE_BYTES;
}

// Attach a unified diff when it fits the remaining byte budget; returns the
// bytes it added, or null when it would not fit (the entry keeps its status).
function attachDiff(
  entry: DiffFile,
  textA: string,
  textB: string,
  bytes: number,
): number | null {
  const diff = unifiedDiff(textA, textB, `a/${entry.path}`, `b/${entry.path}`);
  const size = new TextEncoder().encode(diff).byteLength;
  if (bytes + size > DIFF_MAX_TOTAL_BYTES) return null;
  entry.diff = diff;
  return size;
}

async function readText(env: Env, storageKey: string): Promise<string | null> {
  try {
    const object = await env.BUCKET.get(storageKey);
    if (!object || !("body" in object)) return null;
    return await object.text();
  } catch {
    return null;
  }
}

// The strip a browser sees at the top of a prior version. Server-rendered,
// inline-styled, injected right after <body> so it needs nothing from the
// page; the widget is injected separately and stays untouched.
export function versionBanner(
  env: Env,
  artifact: Artifact,
  version: ArtifactVersion,
): string {
  const current = version.id === artifact.current_version_id;
  const when = new Date(
    Number(version.completed_at || version.created_at) * 1000,
  );
  const stamp = when.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const href = escapeHtml(publicArtifactPath(env, artifact.url_key));
  const note = current
    ? "this is the current version"
    : "this is not the current version";
  const action = current ? "Open stable link" : "Open current";
  return (
    `<div id="au-version-banner" data-au-version="${escapeHtml(version.id)}" role="status" ` +
    `style="position:fixed;top:0;left:0;right:0;z-index:2147483646;box-sizing:border-box;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;justify-content:center;padding:6px 14px;background:#1b2429;color:#f6f8f8;font:13px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 1px 0 rgba(0,0,0,.25)">` +
    `<span>Viewing version from <time datetime="${when.toISOString()}">${stamp}</time> · ${note}</span>` +
    `<a href="${href}" style="color:#9fe1d8;font-weight:600;text-decoration:underline">${action}</a>` +
    `</div>`
  );
}

export function injectVersionBanner(html: string, banner: string): string {
  const body = /<body\b[^>]*>/i.exec(html);
  if (body)
    return (
      html.slice(0, body.index + body[0].length) +
      banner +
      html.slice(body.index + body[0].length)
    );
  return banner + html;
}
