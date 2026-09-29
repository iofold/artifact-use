import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderGate } from "../src/gate.ts";
import type { Artifact } from "../src/types.ts";
import { SUBMIT_ONCE_SCRIPT, htmlPage } from "../src/util.ts";

test("system pages ship the submit-once guard", async () => {
  const body = await htmlPage("Title", "<form></form>").text();
  assert.ok(body.includes(`<script>${SUBMIT_ONCE_SCRIPT}</script>`));
});

test("the verified gate labels its busy state", async () => {
  const body = await renderGate(artifact("verified_email"), "/go/x/").text();
  assert.match(body, /data-busy-label="Sending code…">Send code</);
});

test("a form submits once, then swallows repeat taps and Enter presses", () => {
  const page = fakePage("Send code", "Sending code…");
  assert.equal(page.submit(), false);
  assert.equal(page.button.disabled, true);
  assert.equal(page.button.textContent, "Sending code…");
  assert.equal(page.submit(), true);
  assert.equal(page.submit(), true);
});

test("buttons without a busy label fall back to a generic one", () => {
  const page = fakePage("Continue as a@example.com");
  page.submit();
  assert.equal(page.button.textContent, "Please wait…");
});

test("a page restored from the back/forward cache can submit again", () => {
  const page = fakePage("Send code", "Sending code…");
  page.submit();
  page.pageshow(false);
  assert.equal(page.button.disabled, true, "fresh loads are left alone");
  page.pageshow(true);
  assert.equal(page.button.disabled, false);
  assert.equal(page.button.textContent, "Send code");
  assert.equal(page.submit(), false);
});

function fakePage(label: string, busyLabel?: string) {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const on = (key: string) => (type: string, fn: (event: unknown) => void) => {
    (listeners[`${key}:${type}`] ??= []).push(fn);
  };
  const attributes = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      hasAttribute: (name: string) => map.has(name),
      getAttribute: (name: string) => map.get(name) ?? null,
      setAttribute: (name: string, value: string) => map.set(name, value),
      removeAttribute: (name: string) => map.delete(name),
    };
  };
  const button = {
    disabled: false,
    textContent: label,
    ...attributes(busyLabel ? { "data-busy-label": busyLabel } : {}),
  };
  const form = { ...attributes(), querySelector: () => button };
  const document = {
    addEventListener: on("document"),
    querySelectorAll: (selector: string) =>
      selector === "form[data-submitting]" &&
      form.hasAttribute("data-submitting")
        ? [form]
        : [],
  };
  vm.runInNewContext(SUBMIT_ONCE_SCRIPT, {
    document,
    window: { addEventListener: on("window") },
  });
  return {
    button,
    submit() {
      let prevented = false;
      for (const fn of listeners["document:submit"] ?? [])
        fn({ target: form, preventDefault: () => (prevented = true) });
      return prevented;
    },
    pageshow(persisted: boolean) {
      for (const fn of listeners["window:pageshow"] ?? []) fn({ persisted });
    },
  };
}

function artifact(gateLevel: Artifact["gate_level"]): Artifact {
  return {
    id: "art_once",
    org_id: "org_once",
    slug: "once",
    url_key: "once-abc123",
    title: "Once",
    description: null,
    gate_level: gateLevel,
    allowlist_json: null,
    current_version_id: "ver_once",
    created_by: "user_once",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
}
