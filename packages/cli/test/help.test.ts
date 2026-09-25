import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The CLI is JSON-first for every real command; help and version are the two
// human-readable exceptions. These run the entry point as a child process so
// they cover argv handling and exit codes exactly as a shell sees them.

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", entry, ...args],
      { env: { ...process.env, ARTIFACT_USE_TOKEN: "" } },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const failure = e as Run & { code?: number };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
}

test("help, --help, -h and no arguments print the human-readable usage", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = await run(...args);
    assert.equal(result.code, 0, args.join(" "));
    assert.match(result.stdout, /^Usage: artifact-use <command>/);
    assert.throws(() => JSON.parse(result.stdout), `${args} printed JSON`);
    for (const command of [
      "publish-html",
      "publish-folder",
      "list",
      "stats",
      "gate",
      "preview",
      "share",
      "comments",
      "workspaces",
      "schema",
    ])
      assert.match(result.stdout, new RegExp(`^  ${command} `, "m"));
    // fields come from the schema table: required first, optional bracketed
    assert.match(
      result.stdout,
      /^ {2}publish-folder\s+artifact, dir {2}\[title, description, gate_level, entrypoint, allow_secrets, base_version_id\]$/m,
    );
    assert.match(
      result.stdout,
      /^ {2}gate\s+artifact, gate_level {2}\[allowlist, title\]$/m,
    );
    assert.match(
      result.stdout,
      /gate_level\s+public \| email \| verified_email \| allowlist/,
    );
    assert.match(
      result.stdout,
      /comments\.action\s+list \(default\) \| post \| resolve \| reopen/,
    );
    for (const item of [
      "ARTIFACT_USE_TOKEN",
      "ARTIFACT_USE_API_BASE",
      "ARTIFACT_USE_WORKSPACE",
      "--json '<object>'",
      "--workspace",
      "--version",
      "--dry-run",
    ])
      assert.ok(result.stdout.includes(item), `usage lacks ${item}`);
  }
});

test("help <command> and <command> --help print that command's schema as JSON", async () => {
  for (const args of [
    ["help", "publish-html"],
    ["publish-html", "--help"],
    ["publish-html", "-h"],
  ]) {
    const result = await run(...args);
    assert.equal(result.code, 0, args.join(" "));
    const schema = JSON.parse(result.stdout);
    assert.deepEqual(schema.required, ["artifact", "html"]);
    assert.deepEqual(schema.properties.gate_level.enum, [
      "public",
      "email",
      "verified_email",
      "allowlist",
    ]);
    // pretty-printed, not a single line
    assert.ok(result.stdout.trim().includes("\n"));
  }
  const noInput = await run("help", "list");
  assert.equal(noInput.code, 0);
  assert.deepEqual(JSON.parse(noInput.stdout).properties, {});
});

test("--version prints the package version", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await run(flag);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${pkg.version}\n`);
  }
});

test("unknown commands keep the JSON error envelope and exit 1", async () => {
  for (const args of [["bogus"], ["help", "bogus"]]) {
    const result = await run(...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: { message: "unknown command: bogus" },
    });
  }
});

test("real commands still answer in JSON", async () => {
  const result = await run("schema", "gate");
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).required, [
    "artifact",
    "gate_level",
  ]);
});
