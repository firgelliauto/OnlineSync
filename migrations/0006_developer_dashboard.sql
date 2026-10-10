ALTER TABLE stores ADD COLUMN is_development INTEGER;
ALTER TABLE sync_groups ADD COLUMN billing_trial_ends_at TEXT;
CREATE TABLE operational_issues (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES sync_groups(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES inventory_links(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT
);
CREATE INDEX operational_issues_open ON operational_issues(resolved_at,last_seen_at);
CREATE TABLE operational_heartbeats (
  name TEXT PRIMARY KEY,
  last_success_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
