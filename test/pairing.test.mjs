import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createPairingCode, redeemPairingCode } from '../src/pairing.mjs';

function adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return { run() { const result = sqlite.prepare(sql).run(...values);
            return { meta: { changes: Number(result.changes) } }; } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}

test('pairing moves an installed child store to the main group once', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO stores (shop, access_token_cipher, refresh_token_cipher,
    token_expires_at, refresh_expires_at) VALUES
    ('main.myshopify.com','x','x',1,1),('child.myshopify.com','x','x',1,1),
    ('other.myshopify.com','x','x',1,1)`);
  sqlite.exec(`INSERT INTO sync_groups (id, main_shop) VALUES
    ('main-group','main.myshopify.com'),('child-group','child.myshopify.com'),
    ('other-group','other.myshopify.com')`);
  sqlite.exec(`INSERT INTO group_stores (group_id, shop, role) VALUES
    ('main-group','main.myshopify.com','main'),
    ('child-group','child.myshopify.com','main'),
    ('other-group','other.myshopify.com','main')`);
  const db = adapter(sqlite);
  const { code } = await createPairingCode(db, 'main-group');
  sqlite.exec("UPDATE sync_groups SET status='active' WHERE id='main-group'");
  assert.equal(await redeemPairingCode(db, 'child.myshopify.com', 'child-group', code), false);
  sqlite.exec("UPDATE sync_groups SET status='setup' WHERE id='main-group'");
  assert.equal(await redeemPairingCode(db, 'child.myshopify.com', 'child-group', code), true);
  assert.deepEqual({ ...sqlite.prepare('SELECT group_id, role FROM group_stores WHERE shop = ?')
    .get('child.myshopify.com') }, { group_id: 'main-group', role: 'child' });
  assert.equal(sqlite.prepare('SELECT id FROM sync_groups WHERE id = ?').get('child-group'), undefined);
  assert.equal(await redeemPairingCode(db, 'other.myshopify.com', 'other-group', code), false);
  assert.ok(sqlite.prepare('SELECT id FROM sync_groups WHERE id = ?').get('other-group'));
  sqlite.close();
});
