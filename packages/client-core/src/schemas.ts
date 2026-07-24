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

export const artifactPublishTool: ToolSchema = {
  name: "artifact_publish",
  description:
    "Publish or update a static artifact. Pass html for a single-file artifact, or files for a small inline multi-file artifact. If you can read files from a local filesystem and make HTTP requests from a shell, prefer artifact_upload_session so file bytes go directly over HTTP instead of through MCP/model context.",
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
    "List artifacts, fetch stats, update access or public link-preview details, create a tracked share link, permanently delete an artifact, or list the workspaces this credential can publish to.",
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
          "share_link",
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
      recipient_email: { type: "string" },
      recipient_label: { type: "string" },
      expires_days: { type: "number" },
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

export const artifactCommentsTool: ToolSchema = {
  name: "artifact_comments",
  description:
    'Read, post, and resolve feedback comments on an artifact. Viewers comment through the on-page widget; this tool is the publisher side of the loop: list with status "open" to see outstanding feedback, fix and republish the same artifact slug, then reply to each thread and resolve it. Comments are threaded (parent_id / parent_comment_id) and may carry a `target` anchor describing the on-page element they point at.',
  inputSchema: {
    type: "object",
    required: ["action", "artifact"],
    properties: {
      action: {
        type: "string",
        enum: ["list", "post", "resolve", "reopen"],
      },
      artifact: {
        type: "string",
        description: "Artifact url_key from artifact_manage list, or slug.",
      },
      workspace: workspaceProperty,
      status: {
        type: "string",
        enum: ["open", "resolved", "all"],
        description:
          "list: filter threads by resolution state (replies follow their root). Default all.",
      },
      since: {
        type: "number",
        description:
          "list: only comments created after this unix timestamp (seconds) — new feedback since the last check.",
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
      ...artifactPublishTool.inputSchema.properties,
      dir: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
  },
};
