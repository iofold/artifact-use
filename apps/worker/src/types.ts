export type GateLevel = "public" | "email" | "verified_email" | "allowlist";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  BROWSER?: BrowserRun;
  ASSETS: Fetcher;
  EMAIL?: SendEmail;
  SITE_BASE_URL: string;
  ARTIFACT_PUBLIC_PATH_PREFIX?: string;
  WORKOS_AUTHKIT_URL: string;
  WORKOS_AUDIENCE: string;
  WORKOS_ISSUER: string;
  WORKOS_JWKS_URL: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  ARTIFACT_USE_SUPER_ADMIN_USER_IDS?: string;
  ARTIFACT_USE_DOCS_URL?: string;
  ARTIFACT_USE_PRIVACY_URL?: string;
  ARTIFACT_USE_TERMS_URL?: string;
  ARTIFACT_USE_AUTH_SCOPES?: string;
  ARTIFACT_USE_READ_SCOPES?: string;
  ARTIFACT_USE_WRITE_SCOPES?: string;
  ABUSE_EMAIL?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  DEFAULT_PACKAGE_LIMIT_BYTES?: string;
  DEFAULT_FILE_LIMIT_BYTES?: string;
  DEFAULT_FILE_COUNT_LIMIT?: string;
  HTTP_MCP_INLINE_FILE_LIMIT_BYTES?: string;
  ALLOW_DEBUG_CODES?: string;
  SESSION_SECRET: string;
  DEV_AUTH_TOKEN?: string;
  DEV_AUTH_USER_ID?: string;
  DEV_AUTH_ORG_ID?: string;
  DEV_AUTH_EMAIL?: string;
}

export type TokenScope = "org" | "user";

export interface Creator {
  sub: string;
  orgId: string;
  email: string | null;
  permissions: Set<string>;
  raw: Record<string, unknown>;
  // Creator tokens only: 'user' tokens select a workspace per request, 'org'
  // tokens are pinned to orgId. Absent for OAuth/JWT and dev identities.
  tokenScope?: TokenScope;
  // True when orgId came from an explicit, membership-validated workspace
  // selection rather than a credential default.
  workspaceSelected?: boolean;
}

export interface CreatorToken {
  typ: "creator";
  jti?: string;
  sub: string;
  org_id: string;
  scope?: TokenScope;
  email: string | null;
  name?: string | null;
  permissions: string[];
  iat: number;
  exp: number;
}

export interface Artifact {
  id: string;
  org_id: string;
  slug: string;
  url_key: string;
  title: string;
  description: string | null;
  gate_level: GateLevel;
  allowlist_json: string | null;
  current_version_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  status: "active" | "suspended";
  moderation_reason: string | null;
  moderated_by: string | null;
  moderated_at: number | null;
  org_suspended?: number;
  org_moderation_reason?: string | null;
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  org_id: string;
  status: "draft" | "finalizing" | "complete" | "aborted";
  entrypoint: string;
  manifest_json: string | null;
  total_size: number;
  file_count: number;
  created_by: string;
  created_at: number;
  completed_at: number | null;
}

export interface ArtifactFile {
  version_id: string;
  path: string;
  storage_key: string;
  content_type: string;
  size: number;
  sha256: string | null;
  uploaded_at: number;
}

export interface ManifestFile {
  path: string;
  content_type: string;
  size: number;
  sha256?: string | null;
}

export interface PublishManifest {
  entrypoint: string;
  files: ManifestFile[];
}

export interface ViewerSession {
  artifact_id: string;
  version_id: string | null;
  email: string;
  verified: boolean;
  view_id: number;
  exp: number;
}

export interface UploadSession {
  typ: "artifact_upload";
  org_id: string;
  version_id: string;
  created_by: string;
  exp: number;
}

export interface PublisherSession {
  typ: "publisher";
  sub: string;
  orgId: string;
  email: string | null;
  name: string | null;
  role?: string | null;
  roles?: string[];
  permissions?: string[];
  sessionId?: string | null;
  organizationMembershipId?: string | null;
  exp: number;
}
