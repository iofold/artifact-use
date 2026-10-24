import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { fixture, bearer } from "./security-review/fixture.ts";
import { viewerCookieName } from "../src/auth.ts";

test("protected script files cannot be embedded by another artifact origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_resource");
  f.file(
    a,
    "private.js",
    "window.__auditPrivateScript='PRIVATE_SCRIPT_BYTES'",
    "application/javascript",
  );
  const cookie = `${viewerCookieName(a.id)}=${encodeURIComponent(await f.viewer(a))}`;
  for (const origin of [
    "https://audit.example",
    "https://a-resource.pages.example",
  ]) {
    const response = await worker.fetch(
      new Request(`${origin}/go/${a.url_key}/private.js`, {
        headers: {
          Cookie: cookie,
          "Sec-Fetch-Site": "same-site",
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Mode": "no-cors",
        },
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Cross-Origin-Resource-Policy"),
      "same-origin",
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  }
  const publicArtifact = f.artifact(
    "art_publicresource",
    "org_other",
    "public",
  );
  const publicFile = await f.request(
    `/go/${publicArtifact.url_key}/private.txt`,
  );
  assert.notEqual(
    publicFile.headers.get("Cross-Origin-Resource-Policy"),
    "same-origin",
    "public resources stay reusable",
  );
  const comments = await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
    headers: bearer(await f.viewer(a)),
  });
  assert.equal(
    comments.headers.get("Cross-Origin-Resource-Policy"),
    "same-origin",
  );
  assert.equal(comments.headers.get("X-Content-Type-Options"), "nosniff");
});

test("browser mutations cannot use publisher cookies from a sibling artifact origin", async () => {
  const f = fixture();
  const a = f.artifact("art_blindpost");
  const cookie = `__Host-au_pub=${encodeURIComponent(await f.publisher())}`;
  for (const endpoint of ["comments", "profile"]) {
    const body = JSON.stringify({
      artifact_key: a.url_key,
      body: "UNTRUSTED_WRITE",
      display_name: "UNTRUSTED_NAME",
    });
    for (const originHeaders of [
      { Origin: "https://a-attacker.pages.example" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const response = await f.request(`/_au/${endpoint}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/plain",
          ...originHeaders,
        },
        body,
      });
      assert.equal(response.status, 403, endpoint);
    }
  }
  assert.equal(
    (f.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number })
      .n,
    0,
  );
  assert.equal(
    (f.raw.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number })
      .n,
    0,
  );
  const legitimate = await f.request("/_au/comments", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://audit.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ artifact_key: a.url_key, body: "LEGITIMATE_WRITE" }),
  });
  assert.equal(legitimate.status, 200);
});

test("handoff state is issued only for browser document navigations", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_statefetch");
  const response = await worker.fetch(
    new Request(
      `https://a-statefetch.pages.example/go/${a.url_key}/?__au_auth=1`,
      { headers: { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } },
    ),
    f.env,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("legacy browser links redirect to the artifact's own origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_public", "org_other", "public");
  const r = await f.request(`/go/${a.url_key}/?tab=2`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(r.status, 302);
  assert.equal(
    r.headers.get("Location"),
    `https://a-public.pages.example/go/${a.url_key}/?tab=2`,
  );
});

test("artifact hosts cannot use publisher cookies, admin routes, or other artifact endpoints", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_attacker", "org_other", "public");
  const b = f.artifact("art_victim");
  const cookie = `__Host-au_pub=${encodeURIComponent(await f.publisher())}; ${viewerCookieName(b.id)}=${encodeURIComponent(await f.viewer(b))}`;
  for (const path of [
    "/admin",
    "/api/v1/artifacts",
    `/go/${b.url_key}/private.txt`,
    `/_au/comments?artifact_key=${b.url_key}`,
    `/_au/versions?artifact_key=${b.url_key}`,
  ]) {
    const r = await worker.fetch(
      new Request(`https://a-attacker.pages.example${path}`, {
        headers: { Cookie: cookie, Accept: "text/html" },
      }),
      f.env,
    );
    assert.equal(r.status, 404, path);
  }
  const post = await worker.fetch(
    new Request("https://a-attacker.pages.example/_au/agent-token", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ artifact_key: b.url_key }),
    }),
    f.env,
  );
  assert.equal(post.status, 404);
  const own = await worker.fetch(
    new Request(`https://a-attacker.pages.example/go/${a.url_key}/`),
    f.env,
  );
  assert.equal(own.status, 200);
  assert.equal(
    own.headers.get("Content-Security-Policy"),
    null,
    "interactive HTML runs on its isolated origin",
  );
});

test("trusted-origin artifact bytes remain available to agents but cannot execute as a trusted document", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_agent");
  const r = await f.request(`/go/${a.url_key}/`, {
    headers: bearer(await f.creator()),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Security-Policy") || "", /sandbox/);
  assert.doesNotMatch(
    r.headers.get("Content-Security-Policy") || "",
    /allow-same-origin|allow-scripts/,
  );
  assert.match(await r.text(), /PRIVATE_ARTIFACT_BYTES/);
});

test("missing isolation configuration does not execute uploaded HTML on the trusted origin", async () => {
  const f = fixture();
  const a = f.artifact("art_fallback", "org_other", "public");
  const r = await f.request(`/go/${a.url_key}/`, {
    headers: { Accept: "text/html" },
  });
  assert.match(r.headers.get("Content-Security-Policy") || "", /sandbox/);
  assert.doesNotMatch(
    r.headers.get("Content-Security-Policy") || "",
    /allow-scripts|allow-same-origin/,
  );
});

test("a signed-in publisher crosses to the target origin with a one-use artifact-scoped handoff", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_member");
  const cookie = `__Host-au_pub=${encodeURIComponent(await f.publisher())}; ${viewerCookieName(a.id)}=${encodeURIComponent(await f.viewer(a))}`;
  const start = await f.request(`/go/${a.url_key}/`, {
    headers: { Accept: "text/html", Cookie: cookie },
  });
  assert.equal(start.status, 302);
  const initial = start.headers.get("Location") || "";
  assert.equal(new URL(initial).origin, "https://a-member.pages.example");
  assert.equal(new URL(initial).searchParams.get("__au_auth"), "1");
  const challenge = await worker.fetch(new Request(initial), f.env);
  assert.equal(challenge.status, 303);
  const bindingCookie = challenge.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Host-au_handoff_"))
    ?.split(";")[0];
  assert.ok(bindingCookie);
  const authorized = await worker.fetch(
    new Request(challenge.headers.get("Location")!, {
      headers: { Accept: "text/html", Cookie: cookie },
    }),
    f.env,
  );
  const destination = authorized.headers.get("Location") || "";
  assert.ok(new URL(destination).searchParams.get("__au_handoff"));
  assert.equal(
    (await worker.fetch(new Request(destination), f.env)).status,
    401,
    "another browser cannot substitute the sender's identity",
  );
  const landed = await worker.fetch(
    new Request(destination, {
      headers: { Accept: "text/html", Cookie: bindingCookie },
    }),
    f.env,
  );
  assert.equal(landed.status, 303);
  const viewerCookie = landed.headers
    .getSetCookie()
    .find((x) => x.startsWith(viewerCookieName(a.id) + "="));
  assert.ok(viewerCookie);
  assert.doesNotMatch(viewerCookie, /Domain=/i);
  assert.equal(
    (await worker.fetch(new Request(destination), f.env)).status,
    401,
    "handoff cannot be replayed",
  );
  const page = await worker.fetch(
    new Request(new URL(landed.headers.get("Location")!, destination), {
      headers: { Accept: "text/html", Cookie: viewerCookie.split(";")[0] },
    }),
    f.env,
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PRIVATE_ARTIFACT_BYTES/);
  const context = await worker.fetch(
    new Request(
      `https://a-member.pages.example/_au/artifact-context?artifact_key=${a.url_key}`,
      { headers: { Cookie: viewerCookie.split(";")[0] } },
    ),
    f.env,
  );
  const info = (await context.json()) as { role: string; admin_url: string };
  assert.equal(info.role, "publisher");
  assert.equal(new URL(info.admin_url).origin, "https://audit.example");
});

test("unknown hosts cannot reach the application", async () => {
  const f = fixture();
  const r = await worker.fetch(
    new Request("https://unconfigured.example/health"),
    f.env,
  );
  assert.equal(r.status, 404);
});

test("isolated public publisher views remain excluded from audience analytics", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_publicowner", "org_victim", "public");
  const token = await f.viewer(a, { workspace_user_id: "user_AUDIT" });
  const response = await worker.fetch(
    new Request(`https://a-publicowner.pages.example/go/${a.url_key}/`, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0",
        Cookie: `${viewerCookieName(a.id)}=${encodeURIComponent(token)}`,
      },
    }),
    f.env,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (
      f.raw
        .prepare("SELECT COUNT(*) AS n FROM views WHERE artifact_id=?")
        .get(a.id) as { n: number }
    ).n,
    0,
  );
});

test("parallel first navigations keep independent browser handoff state", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_parallel");
  const first = await Promise.all(
    [1, 2].map(() =>
      worker.fetch(
        new Request(
          `https://a-parallel.pages.example/go/${a.url_key}/?__au_auth=1`,
        ),
        f.env,
      ),
    ),
  );
  const states = first.map((r) => r.headers.getSetCookie()[0]!.split(";")[0]);
  assert.notEqual(states[0].split("=")[0], states[1].split("=")[0]);
  const grants = await Promise.all(
    first.map(async (r) =>
      worker.fetch(
        new Request(r.headers.get("Location")!, {
          headers: {
            Accept: "text/html",
            Cookie: `__Host-au_pub=${encodeURIComponent(await f.publisher())}; ${viewerCookieName(a.id)}=${encodeURIComponent(await f.viewer(a))}`,
          },
        }),
        f.env,
      ),
    ),
  );
  for (const grant of grants)
    assert.equal(
      (
        await worker.fetch(
          new Request(grant.headers.get("Location")!, {
            headers: { Cookie: states.join("; ") },
          }),
          f.env,
        )
      ).status,
      303,
    );
});
