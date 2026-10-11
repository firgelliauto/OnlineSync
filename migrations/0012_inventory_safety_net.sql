CREATE TABLE inventory_safety_net (
  group_id TEXT PRIMARY KEY REFERENCES sync_groups(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  last_requested_at INTEGER NOT NULL DEFAULT 0,
  last_source TEXT
);
