PRAGMA foreign_keys = ON;

CREATE TABLE stores (
  shop TEXT PRIMARY KEY,
  shopify_shop_id TEXT,
  access_token_cipher TEXT NOT NULL,
  refresh_token_cipher TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uninstalled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_groups (
  id TEXT PRIMARY KEY,
  main_shop TEXT NOT NULL UNIQUE REFERENCES stores(shop),
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'paused', 'active')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_stores (
  group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  shop TEXT NOT NULL UNIQUE REFERENCES stores(shop),
  role TEXT NOT NULL CHECK (role IN ('main', 'child')),
  location_id TEXT,
  PRIMARY KEY (group_id, shop)
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at TEXT
);

CREATE TABLE inventory_links (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  shared_quantity INTEGER NOT NULL CHECK (shared_quantity >= 0),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'active', 'blocked')),
  block_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (group_id, sku)
);

CREATE TABLE inventory_members (
  link_id TEXT NOT NULL REFERENCES inventory_links(id) ON DELETE CASCADE,
  shop TEXT NOT NULL REFERENCES stores(shop),
  inventory_item_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  last_quantity INTEGER NOT NULL CHECK (last_quantity >= 0),
  PRIMARY KEY (link_id, shop),
  UNIQUE (shop, inventory_item_id, location_id)
);

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  topic TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  shop TEXT,
  link_id TEXT,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX inventory_links_group_status ON inventory_links(group_id, status);
CREATE INDEX sync_events_group_recent ON sync_events(group_id, id DESC);
