ALTER TABLE sync_groups ADD COLUMN inventory_mode TEXT NOT NULL DEFAULT 'shared' CHECK(inventory_mode IN ('shared','one_way'));
