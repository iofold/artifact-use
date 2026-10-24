// Loopback-only browser reproduction against the actual worker handlers.
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fixture } from "./fixture.ts";
import worker from "../../src/index.ts";
import { setViewerCookie, viewerCookieName } from "../../src/auth.ts";

const origin = process.env.AUDIT_BASE_URL || "http://localhost:18849";
const f = fixture(origin);
f.env.ARTIFACT_HOST_SUFFIX = process.env.AUDIT_HOST_SUFFIX || "localhost:18849";
const victim = f.artifact("art_victim");
f.file(
  victim,
  "private.js",
  "window.__auditPrivateScript='PRIVATE_SCRIPT_BYTES'",
  "application/javascript",
);
const attacker = f.artifact("art_attacker", "org_attacker", "public", "shared");
f.raw
  .prepare(
    `INSERT INTO comments (artifact_id, email, body, created_at, private_to) VALUES (?, 'customer@example.com', 'PRIVATE_OTHER_CUSTOMER_COMMENT', 1, 'customer@example.com')`,
  )
  .run(victim.id);
f.file(
  attacker,
  "index.html",
  `<!doctype html><title>Synthetic attacker artifact</title><body data-audit-main="${origin}"><p>Local security reproduction. No production data.</p></body>`,
  "text/html",
);
f.file(
  attacker,
  "public.js",
  "window.__auditPublicScript=true",
  "application/javascript",
);
let requests = 0;
const createFixtureServer = (listener: RequestListener) =>
  origin.startsWith("https:")
    ? createHttpsServer(
        {
          key: readFileSync(process.env.AUDIT_TLS_KEY!),
          cert: readFileSync(process.env.AUDIT_TLS_CERT!),
        },
        listener,
      )
    : createServer(listener);
createFixtureServer(async (req, res) => {
  requests++;
  try {
    // Test-only login, representing credentials a victim already possesses.
    if (req.url === "/__audit/publisher" || req.url === "/__audit/viewer") {
      const cookie = req.url.endsWith("publisher")
        ? `__Host-au_pub=${encodeURIComponent(await f.publisher())}; Path=/; Secure; HttpOnly; SameSite=Lax`
        : setViewerCookie(viewerCookieName(victim.id), await f.viewer(victim));
      res.writeHead(302, {
        "Set-Cookie": cookie,
        Location: `/go/${attacker.url_key}/`,
      });
      res.end();
      return;
    }
    if (req.url === "/__audit/count") {
      res.end(JSON.stringify({ requests }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const response = await worker.fetch(
      new Request(
        `${new URL(origin).protocol}//${req.headers.host}${req.url || "/"}`,
        {
          method: req.method,
          headers,
          ...(["GET", "HEAD"].includes(req.method || "GET")
            ? {}
            : { body: Buffer.concat(chunks) }),
        },
      ),
      f.env,
    );
    res.statusCode = response.status;
    for (const [k, v] of response.headers)
      if (k !== "set-cookie") res.setHeader(k, v);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}).listen(Number(new URL(origin).port || 18849), "127.0.0.1", () =>
  console.log(`Synthetic security fixture listening at ${origin}`),
);
