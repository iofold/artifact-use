// MCP tool annotations (title, readOnlyHint, destructiveHint, idempotentHint,
// openWorldHint). Both directories that list connectors require them on
// every tool: Anthropic's asks for title plus readOnly/destructive, OpenAI's
// for readOnly/openWorld/destructive. Kept out of schemas.ts so the schema
// byte budget stays readable and the two servers share one source.
import type { ToolSchema } from "./schemas.js";

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  artifact_publish: {
    title: "Publish artifact",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  artifact_upload_session: {
    title: "Start upload session",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  artifact_manage: {
    title: "Manage artifact",
    readOnlyHint: false,
    // `delete` removes every version, file and comment for good.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  artifact_comments: {
    title: "Artifact comments",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    // Webhook subscriptions make the service call URLs the caller names.
    openWorldHint: true,
  },
};

export type AnnotatedTool = ToolSchema & {
  title: string;
  annotations: ToolAnnotations;
};

export function withAnnotations(tool: ToolSchema): AnnotatedTool {
  const annotations = TOOL_ANNOTATIONS[tool.name] || {
    title: tool.name,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  return { ...tool, title: annotations.title, annotations };
}
