ALTER TABLE inventory_links ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_jobs (
  link_id TEXT PRIMARY KEY REFERENCES inventory_links(id) ON DELETE CASCADE,
  dirty INTEGER NOT NULL DEFAULT 1,
  lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_writes (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES inventory_links(id) ON DELETE CASCADE,
  shop TEXT NOT NULL REFERENCES stores(shop),
  from_quantity INTEGER NOT NULL,
  to_quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (link_id, shop)
);

CREATE INDEX sync_writes_link ON sync_writes(link_id);
