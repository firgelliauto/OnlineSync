CREATE TABLE inventory_mode_settings (
 group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
 inventory_mode TEXT NOT NULL CHECK(inventory_mode IN ('shared','one_way')),
 settings TEXT NOT NULL,
 safety_enabled INTEGER NOT NULL DEFAULT 0,
 last_requested_at INTEGER,
 last_source TEXT,
 PRIMARY KEY(group_id,inventory_mode)
);
INSERT INTO inventory_mode_settings(group_id,inventory_mode,settings,safety_enabled,last_requested_at,last_source)
SELECT g.id,g.inventory_mode,i.settings,COALESCE(s.enabled,0),s.last_requested_at,s.last_source
FROM sync_groups g JOIN inventory_settings i ON i.group_id=g.id LEFT JOIN inventory_safety_net s ON s.group_id=g.id;
