CREATE TRIGGER IF NOT EXISTS artifacts_created_by_workos_insert
BEFORE INSERT ON artifacts
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_created_by_workos_update
BEFORE UPDATE OF created_by ON artifacts
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS artifact_versions_created_by_workos_insert
BEFORE INSERT ON artifact_versions
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS artifact_versions_created_by_workos_update
BEFORE UPDATE OF created_by ON artifact_versions
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS share_links_created_by_workos_insert
BEFORE INSERT ON share_links
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'share_links.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS share_links_created_by_workos_update
BEFORE UPDATE OF created_by ON share_links
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'share_links.created_by must be a WorkOS user id');
END;
