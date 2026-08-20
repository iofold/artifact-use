import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheControl } from "../src/serve.ts";

test("html is never cached, regardless of gate or path shape", () => {
  assert.equal(cacheControl("public", true, "index.html"), "private, no-store");
  assert.equal(
    cacheControl("email", true, "assets/app-D4kL9x2Q.html"),
    "private, no-store",
  );
});

test("hashed bundler assets are immutable; gated stays private", () => {
  assert.equal(
    cacheControl("public", false, "assets/mount-0445okQG.js"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControl("email", false, "assets/mount-0445okQG.js"),
    "private, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControl("allowlist", false, "deep/dir/assets/queue-C6QTutkh.css"),
    "private, max-age=31536000, immutable",
  );
});

test("non-hashed files keep the original contract", () => {
  assert.equal(
    cacheControl("email", false, "media/attract-loop-v2.mp4"),
    "private, no-store",
  );
  assert.equal(
    cacheControl("public", false, "media/attract-loop-v2.mp4"),
    "public, max-age=300, must-revalidate",
  );
  // assets/ dir alone is not enough — the filename must carry a hash
  assert.equal(
    cacheControl("email", false, "assets/logo.png"),
    "private, no-store",
  );
});
