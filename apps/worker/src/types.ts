export type GateLevel = "public" | "email" | "verified_email" | "allowlist";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SITE_BASE_URL: string;
  WORKOS_AUTHKIT_URL: string;
  WORKOS_AUDIENCE: string;
  WORKOS_ISSUER: string;
  WORKOS_JWKS_URL: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  ARTIFACT_USE_AUTH_SCOPES?: string;
  ARTIFACT_USE_READ_SCOPES?: string;
  ARTIFACT_USE_WRITE_SCOPES?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  DEFAULT_PACKAGE_LIMIT_BYTES?: string;
  DEFAULT_FILE_LIMIT_BYTES?: string;
  DEFAULT_FILE_COUNT_LIMIT?: string;
  HTTP_MCP_INLINE_FILE_LIMIT_BYTES?: string;
  ALLOW_DEBUG_CODES?: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  DEV_AUTH_TOKEN?: string;
}

export interface Creator {
  sub: string;
  orgId: string;
  email: string | null;
  permissions: Set<string>;
  raw: Record<string, unknown>;
}

export interface Tenant {
  org_id: string;
  slug: string;
  name: string | null;
  owner_email: string | null;
  created_at: number;
  updated_at: number;
}

export interface Artifact {
  id: string;
  org_id: string;
  tenant_slug: string;
  slug: string;
  title: string;
  description: string | null;
  gate_level: GateLevel;
  allowlist_json: string | null;
  current_version_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  org_id: string;
  status: "draft" | "complete" | "aborted";
  entrypoint: string;
  manifest_json: string | null;
  total_size: number;
  file_count: number;
  created_by: string | null;
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

export interface PublisherSession {
  sub: string;
  orgId: string;
  email: string | null;
  name: string | null;
  exp: number;
}
