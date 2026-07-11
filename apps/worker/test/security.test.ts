import assert from "node:assert/strict";
import test from "node:test";
import * as util from "../src/util.ts";

test("system security headers cover every admin response", () => {
  assert.equal(
    typeof util.secureSystemResponse,
    "function",
    "a central response wrapper must enforce headers independently of render helpers",
  );

  const response = util.secureSystemResponse(
    "/admin/api/missing",
    new Response('{"error":"missing"}', {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    "frame-ancestors 'none'",
  );
  assert.equal(
    response.headers.get("Cross-Origin-Opener-Policy"),
    "same-origin",
  );
});

test("central admin protection leaves artifact responses embeddable", () => {
  assert.equal(typeof util.secureSystemResponse, "function");

  const artifact = new Response("artifact");
  const response = util.secureSystemResponse(
    "/go/demo-123/index.html",
    artifact,
  );

  assert.equal(response, artifact);
  assert.equal(response.headers.get("X-Frame-Options"), null);
  assert.equal(response.headers.get("Content-Security-Policy"), null);
});

test("shared HTML pages carry the system security headers", () => {
  const response = util.htmlPage("Gate", "<p>Continue</p>");

  for (const [name, value] of Object.entries(util.SYSTEM_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
});
