import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishFolder } from "../src/index.ts";

// Regression guard for the client-side gate reset: publishing a folder or an
// HTML file without an explicit gate_level must not send one, otherwise the
// server overwrites a public artifact's gate with the default on every
// republish (the same bug 0a98f00 fixed server-side).

type Captured = { path: string; body: Record<string, unknown> | null };

function stubFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const isJson =
      path === "/api/v1/publish/start" || path.endsWith("/complete");
    const body = isJson && init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    if (path === "/api/v1/publish/start")
      return Response.json({
        version: { id: "ver_test" },
        limits: { package_bytes: 1e9, file_bytes: 1e8, file_count: 200 },
      });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const conf = {
  apiBase: "https://artifacts.example.com",
  token: "au_creator_test",
  workspace: "",
};

async function folderWithIndex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "au-gate-"));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  return dir;
}

test("publishFolder omits gate_level when the caller did not set one", async () => {
  const stub = stubFetch();
  try {
    await publishFolder(
      conf,
      { artifact: "demo", dir: await folderWithIndex() },
      false,
    );
    const start = stub.calls.find((c) => c.path === "/api/v1/publish/start");
    assert.ok(start, "start call missing");
    assert.equal(Object.hasOwn(start.body!, "gate_level"), false);
  } finally {
    stub.restore();
  }
});

test("publishFolder forwards an explicit gate_level", async () => {
  const stub = stubFetch();
  try {
    await publishFolder(
      conf,
      { artifact: "demo", dir: await folderWithIndex(), gate_level: "public" },
      false,
    );
    const start = stub.calls.find((c) => c.path === "/api/v1/publish/start");
    assert.equal(start?.body?.gate_level, "public");
  } finally {
    stub.restore();
  }
});
