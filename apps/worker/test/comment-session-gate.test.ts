// The comments and agent-token routes accept exactly the viewer sessions the
// page itself accepts: a revoked or expired share link's session is dead, and
// a verified gate wants a verified (or link) session.
import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentToken } from "../src/serve.ts";
import {
  ORIGIN,
  comments,
  feedbackEnv,
  seedArtifact,
  seedShareLink,
  viewerToken,
} from "./helpers/feedback-env.ts";

test("a revoked share link's session can no longer read or post comments", async () => {
  const { env, raw } = feedbackEnv();
  seedArtifact(raw, { id: "art_links", url_key: "links-abc123" });
  seedShareLink(raw, { id: "lnk_live", artifact_id: "art_links" });
  seedShareLink(raw, {
    id: "lnk_dead",
    artifact_id: "art_links",
    revoked_at: 5,
  });
  seedShareLink(raw, {
    id: "lnk_old",
    artifact_id: "art_links",
    expires_at: 5,
  });
  const live = await viewerToken(env, "art_links", {
    email: "link:lnk_live",
    link_id: "lnk_live",
  });
  const dead = await viewerToken(env, "art_links", {
    email: "link:lnk_dead",
    link_id: "lnk_dead",
  });
  const expired = await viewerToken(env, "art_links", {
    email: "link:lnk_old",
    link_id: "lnk_old",
  });

  assert.equal(
    (await comments(env, { bearer: live }, "GET", "links-abc123")).status,
    200,
  );
  for (const token of [dead, expired]) {
    assert.equal(
      (await comments(env, { bearer: token }, "GET", "links-abc123")).status,
      401,
    );
    assert.equal(
      (
        await comments(env, { bearer: token }, "POST", "links-abc123", {
          body: "still here?",
        })
      ).status,
      401,
    );
  }
});

test("a verified gate refuses an unverified session on the comments route", async () => {
  const { env, raw } = feedbackEnv();
  seedArtifact(raw, {
    id: "art_client",
    url_key: "client-abc123",
    gate_level: "verified_email",
  });
  // Minted while the artifact was on plain email access, then the publisher
  // switched it to `client`.
  const typed = await viewerToken(env, "art_client", {
    email: "someone@example.com",
  });
  const verified = await viewerToken(env, "art_client", {
    email: "someone@example.com",
    verified: true,
  });
  assert.equal(
    (await comments(env, { bearer: typed }, "GET", "client-abc123")).status,
    401,
  );
  assert.equal(
    (
      await comments(env, { bearer: typed }, "POST", "client-abc123", {
        body: "hello",
      })
    ).status,
    401,
  );
  assert.equal(
    (await comments(env, { bearer: verified }, "GET", "client-abc123")).status,
    200,
  );
});

test("a revoked link's session cannot mint a delegated agent token", async () => {
  const { env, raw } = feedbackEnv();
  seedArtifact(raw, { id: "art_agent", url_key: "agent-abc123" });
  seedShareLink(raw, {
    id: "lnk_gone",
    artifact_id: "art_agent",
    revoked_at: 5,
  });
  const dead = await viewerToken(env, "art_agent", {
    email: "link:lnk_gone",
    link_id: "lnk_gone",
  });
  const res = await handleAgentToken(
    new Request(`${ORIGIN}/_au/agent-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dead}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ artifact_key: "agent-abc123" }),
    }),
    env,
  );
  assert.equal(res.status, 401);
});
