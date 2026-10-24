-- Keep legacy URLs stable while new URLs retain the full random artifact id.
DROP TRIGGER artifacts_url_key_insert;
DROP TRIGGER artifacts_url_key_update;

CREATE TRIGGER artifacts_url_key_insert
BEFORE INSERT ON artifacts
WHEN NEW.url_key IS NULL OR NEW.url_key = '' OR (
  NEW.url_key NOT GLOB '*-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'
  AND NOT (substr(NEW.url_key, -33, 1) = '-' AND length(NEW.url_key) > 33
           AND substr(NEW.url_key, -32) NOT GLOB '*[^0-9a-f]*')
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts.url_key must end with a valid artifact code');
END;

CREATE TRIGGER artifacts_url_key_update
BEFORE UPDATE OF url_key ON artifacts
WHEN NEW.url_key IS NULL OR NEW.url_key = '' OR (
  NEW.url_key NOT GLOB '*-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'
  AND NOT (substr(NEW.url_key, -33, 1) = '-' AND length(NEW.url_key) > 33
           AND substr(NEW.url_key, -32) NOT GLOB '*[^0-9a-f]*')
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts.url_key must end with a valid artifact code');
END;
