-- A one-line, agent-written summary of what a publish changed ("Moved the
-- demo controls into the header"), shown to the workspace in version history
-- in place of a diff. Optional; older versions and publishes without one keep
-- NULL.
ALTER TABLE artifact_versions ADD COLUMN change_note TEXT;
