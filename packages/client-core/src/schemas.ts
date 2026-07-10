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

export const artifactPublishTool: ToolSchema = {
  name: "artifact_publish",
  description:
    "Publish or update a static artifact. Pass html for a single-file artifact, or files for a small inline multi-file artifact. If you can read files from a local filesystem and make HTTP requests from a shell, prefer artifact_upload_session so file bytes go directly over HTTP instead of through MCP/model context.",
  inputSchema: {
    type: "object",
    required: ["artifact"],
    properties: {
      artifact: { type: "string", description: "Artifact slug to publish." },
      title: { type: "string" },
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
      title: { type: "string" },
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
    "List artifacts, fetch stats, update access, or create a tracked share link.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["list", "stats", "set_access", "share_link"],
      },
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
      gate_level: { type: "string", enum: [...GATE_LEVELS] },
      allowlist: { type: "object" },
      recipient_email: { type: "string" },
      recipient_label: { type: "string" },
      expires_days: { type: "number" },
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
