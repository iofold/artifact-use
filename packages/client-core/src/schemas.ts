// Runtime-agnostic MCP tool schemas shared by the stdio server and the worker
// /mcp endpoint. No node imports so this module can be bundled into either
// runtime. The base tools describe the hosted (HTTP) surface; the stdio server
// adds its local-only `dir`/`dry_run` inputs via artifactPublishLocalTool.

export const GATE_LEVELS = [
  "public",
  "email",
  "verified_email",
  "allowlist",
] as const;

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<string, unknown>;
  };
}

// Shared by every tool: multi-workspace credentials (user-scoped tokens) must
// name their target workspace on each call; single-workspace credentials may
// omit it or name their own workspace.
const workspaceProperty = {
  type: "string",
  description:
    'Target workspace (organization id or slug). Required on every call when the credential is user-scoped (publishes to multiple workspaces); discover yours with artifact_manage {"action":"workspaces"}.',
};

// Optimistic concurrency on republish: pass the version_id of the last
// publish; a 409 version_conflict means someone published in between.
const baseVersionProperty = {
  type: "string",
  description:
    "Republish only if this is still the current version_id (from your last publish); otherwise 409 version_conflict with the newer version.",
};

export const artifactPublishTool: ToolSchema = {
  name: "artifact_publish",
  description:
    "Publish or update a static artifact. Pass html for a single-file artifact, or files for a small inline multi-file artifact. If you can read files from a local filesystem and make HTTP requests from a shell, prefer artifact_upload_session so file bytes go directly over HTTP instead of through MCP/model context.",
  inputSchema: {
    type: "object",
    required: ["artifact"],
    properties: {
      allow_secrets: {
        type: "boolean",
        description:
          "Publish even if the secret scan finds credential-like strings (they are returned as warnings).",
      },
      artifact: { type: "string", description: "Artifact slug to publish." },
      workspace: workspaceProperty,
      title: { type: "string" },
      description: {
        type: "string",
        maxLength: 200,
        description:
          "A one- or two-sentence public summary for link previews. This is visible even when the artifact is gated. If omitted for HTML, Artifact Use derives a summary from page metadata or the first paragraph.",
      },
      gate_level: { type: "string", enum: [...GATE_LEVELS] },
      entrypoint: { type: "string", default: "index.html" },
      base_version_id: baseVersionProperty,
      html: { type: "string" },
      files: {
        type: "array",
        description:
          "Inline files for multi-file artifacts. Use content for text or content_base64 for binary.",
        items: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            content_base64: { type: "string" },
            content_type: { type: "string" },
          },
        },
      },
    },
  },
};

export const artifactUploadSessionTool: ToolSchema = {
  name: "artifact_upload_session",
  description:
    "Create a short-lived direct upload session for large files or folders. Use this when the agent has filesystem and shell/curl access: call this tool for a 6-hour bearer upload_token, then PUT file bytes directly to upload_base with Content-Length, Content-Type, and X-Artifact-Sha256, and POST the manifest to complete_url without embedding file contents in MCP arguments.",
  inputSchema: {
    type: "object",
    required: ["artifact"],
    properties: {
      artifact: { type: "string", description: "Artifact slug to publish." },
      workspace: workspaceProperty,
      title: { type: "string" },
      description: {
        type: "string",
        maxLength: 200,
        description:
          "A one- or two-sentence public summary for link previews. This is visible even when the artifact is gated. If omitted for HTML, Artifact Use derives a summary from page metadata or the first paragraph.",
      },
      gate_level: { type: "string", enum: [...GATE_LEVELS] },
      entrypoint: { type: "string", default: "index.html" },
      base_version_id: baseVersionProperty,
      ttl_seconds: {
        type: "number",
        description: "Token lifetime in seconds. Maximum is 21600 (6 hours).",
        default: 21600,
      },
    },
  },
};

export const artifactManageTool: ToolSchema = {
  name: "artifact_manage",
  description:
    "List artifacts, fetch stats, update access or public link-preview details, point an artifact at an upstream backend that gated viewers reach via its `_api/` path, create/list/revoke share links (recipient, password, or open; every link passes the gate until it expires, is revoked, or hits max_opens), list versions, promote one (rollback = promote an older version), diff two versions, permanently delete an artifact, or list the workspaces this credential can publish to.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "stats",
          "set_access",
          "set_preview",
          "set_upstream",
          "share_link",
          "share_links",
          "revoke_link",
          "versions",
          "promote",
          "diff",
          "delete",
          "move",
          "workspaces",
        ],
      },
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
      workspace: workspaceProperty,
      gate_level: { type: "string", enum: [...GATE_LEVELS] },
      title: {
        type: "string",
        description: "set_preview: the public artifact title.",
      },
      description: {
        type: "string",
        maxLength: 200,
        description:
          "set_preview: the public link-preview summary. Visible even when the artifact is gated; pass an empty string to clear it.",
      },
      allowlist: { type: "object" },
      upstream_url: {
        type: "string",
        description:
          "set_upstream: https:// base URL of the artifact's backend. Requests to <artifact url>_api/<path> are forwarded there after the artifact gate passes, with X-Artifact-Viewer-Email set to the viewer's gate email. Omit or pass an empty string to remove the upstream.",
      },
      upstream_secret: {
        type: "string",
        description:
          "set_upstream: bearer token sent to the upstream as Authorization: Bearer <secret>. Write-only; never returned.",
      },
      kind: {
        type: "string",
        enum: ["recipient", "password", "open"],
        description:
          "share_link: recipient (URL is the credential for one named person, default), password (viewer types a passcode; returned once), open (anyone with the URL).",
      },
      label: { type: "string", description: "share_link: shown in the admin." },
      recipient_email: { type: "string" },
      recipient_label: { type: "string" },
      passcode: {
        type: "string",
        description:
          "share_link kind=password: custom passcode (6-72 chars); generated when omitted.",
      },
      expires_days: { type: "number", description: "share_link: 1-365." },
      max_opens: {
        type: "number",
        description: "share_link: opens allowed before the link stops working.",
      },
      link_id: {
        type: "string",
        description: "revoke_link: id from share_links.",
      },
      version_id: {
        type: "string",
        description: "promote: version to serve at the stable URL.",
      },
      from_version: {
        type: "string",
        description:
          'diff: version id, "current" or "previous" (default previous).',
      },
      to_version: {
        type: "string",
        description: 'diff: version id or "current" (default).',
      },
      to_workspace: {
        type: "string",
        description:
          "move: target workspace (org id or slug). The credential's user must be a member of it; the artifact keeps its public URL and creator, and is managed from the target workspace afterwards.",
      },
      confirm: {
        type: "boolean",
        description:
          "delete: must be true. Deletion is permanent and removes every version, file, share link, comment, and view record; the public URL stops working immediately.",
      },
    },
  },
};

export const WEBHOOK_EVENTS = [
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "comment.reopened",
  "comment.sent_to_agent",
] as const;

export const artifactCommentsTool: ToolSchema = {
  name: "artifact_comments",
  description:
    'Read, post, and resolve feedback comments on an artifact, or subscribe a webhook to them. Viewers comment through the on-page widget; this tool is the publisher side of the loop: act on status "sent" first (viewers pressed "Send to agent"), then "open"; fix and republish the same artifact slug, reply to each thread, resolve it. Comments are threaded (parent_id / parent_comment_id), carry author_kind (human|agent) and may carry a `target` describing the on-page element (selector, label, caption, src, heading, text). To wait for new feedback, list with wait: 25 and pass the returned next_since back as since; or subscribe a webhook.',
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "post",
          "resolve",
          "reopen",
          "subscribe",
          "unsubscribe",
          "webhooks",
        ],
      },
      artifact: {
        type: "string",
        description:
          "Artifact url_key from artifact_manage list, or slug. Required except for subscribe (optional: scope to one artifact), unsubscribe and webhooks.",
      },
      workspace: workspaceProperty,
      status: {
        type: "string",
        enum: ["open", "sent", "resolved", "all"],
        description:
          'list: open, sent (flagged "Send to agent" and unresolved), resolved, or all (default). Replies follow their root.',
      },
      since: {
        type: "number",
        description:
          "list: only comments created after this unix timestamp (seconds). Pass the previous result's next_since.",
      },
      wait: {
        type: "number",
        description:
          "list: hold up to this many seconds (max 25) until a comment newer than since exists; returns [] with next_since on timeout. Loop on wait: 25.",
      },
      url: {
        type: "string",
        description:
          "subscribe: https URL that receives each event as a JSON POST signed with X-Artifact-Use-Signature (sha256 HMAC of the body with the returned secret).",
      },
      events: {
        type: "array",
        items: { type: "string", enum: [...WEBHOOK_EVENTS] },
        description: "subscribe: events to deliver. Default all.",
      },
      webhook_id: {
        type: "string",
        description: "unsubscribe: id from subscribe or webhooks.",
      },
      page_path: {
        type: "string",
        description:
          "list/post: scope to one page of a multi-page artifact (path as stored on the comment).",
      },
      limit: {
        type: "number",
        description: "list: maximum comments returned (default 200, max 500).",
      },
      body: {
        type: "string",
        description: "post: the comment text. Required for post.",
      },
      parent_id: {
        type: "number",
        description:
          "post: comment id to reply to. Replies join that thread and inherit its target anchor.",
      },
      comment_id: {
        type: "number",
        description: "resolve/reopen: id of the comment (thread root).",
      },
    },
  },
};

// The stdio server also accepts a local folder path (`dir`) and a `dry_run`
// preview that the hosted endpoint does not expose.
export const artifactPublishLocalTool: ToolSchema = {
  ...artifactPublishTool,
  description:
    artifactPublishTool.description +
    " Pass dir to publish a local folder without sending file bytes through model context, or dry_run to preview the manifest without uploading.",
  inputSchema: {
    ...artifactPublishTool.inputSchema,
    properties: {
      allow_secrets: {
        type: "boolean",
        description:
          "Publish even if the secret scan finds credential-like strings (they are returned as warnings).",
      },
      ...artifactPublishTool.inputSchema.properties,
      dir: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
  },
};
