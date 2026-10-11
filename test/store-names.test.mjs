import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { saveStoreName, storeName } from '../src/store-names.mjs';
import { customerActivity } from '../src/customer-activity.mjs';

test('names are scoped to the connected group and child stores can rename only themselves', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const file of ['0001_initial.sql','0009_store_names.sql']) sqlite.exec(readFileSync(new URL('../migrations/'+file, import.meta.url),'utf8'));
    sqlite.exec(`INSERT INTO stores (shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at) VALUES
      ('main.myshopify.com','x','x',1,1),('child.myshopify.com','x','x',1,1),('other.myshopify.com','x','x',1,1);
      INSERT INTO sync_groups (id,main_shop) VALUES ('g','main.myshopify.com'),('other','other.myshopify.com');
      INSERT INTO group_stores (group_id,shop,role) VALUES ('g','main.myshopify.com','main'),('g','child.myshopify.com','child'),('other','other.myshopify.com','main');`);
    const db = { prepare: sql => ({ bind: (...values) => ({ run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }) }) }) };
    const main = {id:'g',role:'main'}, child = {id:'g',role:'child'};
    await saveStoreName(db,main,'main.myshopify.com','child.myshopify.com','  Canadian Store  ');
    assert.equal(sqlite.prepare("SELECT display_name FROM group_stores WHERE shop='child.myshopify.com'").get().display_name,'Canadian Store');
    await assert.rejects(saveStoreName(db,main,'main.myshopify.com','other.myshopify.com','Intruder'),/not in your/);
    await assert.rejects(saveStoreName(db,child,'child.myshopify.com','main.myshopify.com','Intruder'),/main store/);
    await saveStoreName(db,child,'child.myshopify.com','child.myshopify.com','My shop');
    for (const bad of [null,42,'a'.repeat(81),'Hidden\u202ename','Two\nlines']) await assert.rejects(saveStoreName(db,main,'main.myshopify.com','child.myshopify.com',bad));
    await saveStoreName(db,child,'child.myshopify.com','child.myshopify.com','');
    assert.equal(storeName(sqlite.prepare("SELECT shop,display_name FROM group_stores WHERE shop='child.myshopify.com'").get()),'child');
    assert.equal(sqlite.prepare("SELECT main_shop FROM sync_groups WHERE id='g'").get().main_shop,'main.myshopify.com');
    assert.equal(sqlite.prepare("SELECT display_name FROM group_stores WHERE shop='other.myshopify.com'").get().display_name,'');
  } finally { sqlite.close(); }
});

test('activity uses customer names in directions and errors without interpreting markup or replacements', () => {
  const rows = customerActivity([
    {id:1,shop:'child.myshopify.com',link_id:'l',sku:'SKU',event_type:'stock_change',detail:'SKU: shared quantity 4 → 3'},
    {id:2,shop:'main.myshopify.com',link_id:'l',sku:'SKU',event_type:'inventory_write',detail:'SKU: 4 → 3'},
    {id:3,shop:'child.myshopify.com',event_type:'product_sync_error',detail:'Failed at child.myshopify.com'}
  ],'main.myshopify.com',{'main.myshopify.com':'Main Brand','child.myshopify.com':'<Shop> $&'});
  assert.equal(rows[1].title,'Inventory copied: <Shop> $& → Main Brand · SKU');
  assert.equal(rows[0].description,'<Shop> $& · Failed at <Shop> $&');
});
