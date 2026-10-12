ALTER TABLE sync_groups ADD COLUMN billing_snapshot TEXT;
ALTER TABLE sync_groups ADD COLUMN sku_usage_lock TEXT;
ALTER TABLE sync_groups ADD COLUMN sku_usage_lock_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE synced_skus (
  group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('inventory','product')),
  source_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  PRIMARY KEY(group_id,kind,source_id,sku)
);
CREATE INDEX synced_skus_group_sku ON synced_skus(group_id,sku);
INSERT INTO synced_skus(group_id,kind,source_id,sku)
  SELECT group_id,'inventory','',sku FROM inventory_links WHERE status<>'preview';
