// Synthetic, in-memory fixtures for the 2026-10-24 security review.
// Never reads deployment configuration, credentials, or production data.
import { sqliteD1 } from "../helpers/sqlite-d1.ts";
import worker from "../../src/index.ts";
import {
  signPayload,
  signViewerSession,
  signCreatorToken,
} from "../../src/auth.ts";
import { nowSec } from "../../src/util.ts";
import type { Env, Artifact, ViewerSession } from "../../src/types.ts";

export function fixture(origin = "https://audit.example") {
  const { db, raw } = sqliteD1();
  const objects = new Map<string, { text: string; type: string }>();
  const env = {
    DB: db,
    SESSION_SECRET: "synthetic-local-audit-secret-only",
    SITE_BASE_URL: origin,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>Synthetic admin shell</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
    BUCKET: {
      async get(key: string) {
        const found = objects.get(key);
        if (!found) return null;
        return {
          body: new Response(found.text).body,
          text: async () => found.text,
          size: new TextEncoder().encode(found.text).length,
          uploaded: new Date(0),
          httpEtag: '"synthetic"',
          httpMetadata: { contentType: found.type },
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", found.type);
          },
        };
      },
      async put(
        key: string,
        value: Uint8Array,
        opts: { httpMetadata?: { contentType?: string } },
      ) {
        objects.set(key, {
          text: new TextDecoder().decode(value),
          type: opts.httpMetadata?.contentType || "text/plain",
        });
        return { size: value.byteLength };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  } as unknown as Env;

  function artifact(
    id: string,
    org = "org_victim",
    gate = "allowlist",
    feedback = "private",
  ) {
    const key = `${id.replace(/^art_/, "").replaceAll("_", "-")}-abcdef`;
    raw
      .prepare(
        `INSERT INTO artifacts (id, org_id, slug, url_key, title, gate_level, allowlist_json, feedback_mode, current_version_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_AUDIT', 1, 1)`,
      )
      .run(
        id,
        org,
        id,
        key,
        `Synthetic ${id}`,
        gate,
        JSON.stringify({ emails: ["victim@example.com"] }),
        feedback,
        `ver_${id}`,
      );
    raw
      .prepare(
        `INSERT INTO artifact_versions (id, artifact_id, org_id, status, entrypoint, created_by, created_at)
      VALUES (?, ?, ?, 'complete', 'index.html', 'user_AUDIT', 1)`,
      )
      .run(`ver_${id}`, id, org);
    const a = raw
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(id) as unknown as Artifact;
    file(
      a,
      "index.html",
      "<!doctype html><title>Synthetic artifact</title><p>PRIVATE_ARTIFACT_BYTES</p>",
      "text/html",
    );
    file(a, "private.txt", "PRIVATE_FILE_BYTES", "text/plain");
    return a;
  }

  function file(a: Artifact, path: string, text: string, type: string) {
    const key = `${a.id}/${path}`;
    objects.set(key, { text, type });
    raw
      .prepare(
        `INSERT INTO artifact_files (version_id, path, storage_key, content_type, size, uploaded_at) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(version_id, path) DO UPDATE SET storage_key=excluded.storage_key, content_type=excluded.content_type`,
      )
      .run(a.current_version_id, path, key, type, text.length);
  }

  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`${origin}${path}`, init), env);
  const viewer = (a: Artifact, fields: Partial<ViewerSession> = {}) =>
    signViewerSession(
      {
        artifact_id: a.id,
        version_id: a.current_version_id,
        email: "victim@example.com",
        verified: true,
        view_id: 1,
        exp: nowSec() + 3600,
        ...fields,
      },
      env,
    );
  const publisher = () =>
    signPayload(
      {
        typ: "publisher",
        sub: "user_AUDIT",
        orgId: "org_victim",
        email: "victim@example.com",
        name: "Synthetic victim",
        roles: ["member"],
        exp: nowSec() + 3600,
      },
      env,
    );
  const creator = (
    org = "org_victim",
    permissions = [
      "artifacts:read",
      "artifacts:publish",
      "artifacts:manage_access",
    ],
  ) =>
    signCreatorToken(
      {
        typ: "creator",
        sub: "user_AUDIT",
        org_id: org,
        email: "victim@example.com",
        permissions,
        iat: nowSec(),
        exp: nowSec() + 3600,
      },
      env,
    );
  const form = (
    path: string,
    values: Record<string, string>,
    extra: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "CF-Connecting-IP": "192.0.2.1",
        ...extra,
      },
      body: new URLSearchParams(values),
    });
  return {
    env,
    raw,
    artifact,
    file,
    request,
    viewer,
    publisher,
    creator,
    form,
  };
}

export const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});
