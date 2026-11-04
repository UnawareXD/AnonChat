const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_identity_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  username TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('random', 'custom')),
  custom_permanent INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS identity_history (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  old_identity_id TEXT NOT NULL,
  new_identity_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'rotation',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  parent_post_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_value_cents INTEGER NOT NULL DEFAULT 0,
  selected_version_id TEXT,
  FOREIGN KEY(parent_post_id) REFERENCES posts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS post_versions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  previous_version_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('original', 'author_edit', 'reader_revert')),
  content TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_bids (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  bidder_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled','superseded','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT,
  settled_at TEXT,
  previous_bid_id TEXT,
  target_version_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'reader_revert'
);

CREATE TABLE IF NOT EXISTS post_reactions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  reaction TEXT NOT NULL CHECK(reaction IN ('like', 'dislike')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, account_id)
);

CREATE TABLE IF NOT EXISTS balances (
  account_id TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  locked_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  balance_after_cents INTEGER NOT NULL DEFAULT 0,
  related_entity_type TEXT,
  related_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  memo TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS identity_marketplace_offers (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  buyer_account_id TEXT NOT NULL,
  seller_account_id TEXT NOT NULL,
  offer_value_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','expired','transferred')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  accepted_at TEXT,
  transferred_at TEXT,
  settlement_snapshot TEXT
);

CREATE TABLE IF NOT EXISTS marketplace_transactions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  buyer_account_id TEXT NOT NULL,
  seller_account_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  seller_paid_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS rotation_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  next_identity_id TEXT,
  scheduled_for TEXT NOT NULL,
  executed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed'))
);

CREATE TABLE IF NOT EXISTS audit_records (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  details TEXT
);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  reporter_account_id TEXT,
  target_entity_type TEXT,
  target_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS user_verifications (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_identities_account_active ON identities(account_id, active);
CREATE INDEX IF NOT EXISTS idx_posts_identity ON posts(identity_id);
CREATE INDEX IF NOT EXISTS idx_post_bids_post_status ON post_bids(post_id, status, locked_until);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id, reaction);
CREATE INDEX IF NOT EXISTS idx_post_reactions_account ON post_reactions(account_id, post_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_identity ON identity_marketplace_offers(identity_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_buyer ON identity_marketplace_offers(buyer_account_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_seller ON identity_marketplace_offers(seller_account_id, status);
CREATE INDEX IF NOT EXISTS idx_rotation_jobs_due ON rotation_jobs(scheduled_for, status);
`;

let db;

function hasColumn(conn, tableName, columnName) {
  const columns = conn.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function migrateLegacyPostsTable(conn) {
  if (!hasColumn(conn, 'posts', 'parent_post_id')) {
    const legacyPosts = conn.prepare('SELECT * FROM posts ORDER BY created_at ASC').all();
    conn.exec('PRAGMA foreign_keys = OFF;');
    conn.exec(`
      CREATE TABLE posts_new (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        parent_post_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_value_cents INTEGER NOT NULL DEFAULT 0,
        selected_version_id TEXT,
        FOREIGN KEY(parent_post_id) REFERENCES posts(id) ON DELETE SET NULL
      );
    `);

    if (legacyPosts.length > 0) {
      const columns = ['id', 'account_id', 'identity_id', 'body', 'created_at', 'current_value_cents', 'selected_version_id'];
      const insertColumns = columns.join(', ');
      const selectColumns = columns.join(', ');
      conn.prepare(`INSERT INTO posts_new (${insertColumns}, parent_post_id) SELECT ${selectColumns}, NULL FROM posts`).run();
    }

    conn.exec('DROP TABLE posts;');
    conn.exec('ALTER TABLE posts_new RENAME TO posts;');
    conn.exec('PRAGMA foreign_keys = ON;');
  }

  conn.exec('CREATE INDEX IF NOT EXISTS idx_posts_parent_post_id ON posts(parent_post_id);');
}

function initializeDatabase(options = {}) {
  const storage = options.storage || process.env.DB_PATH || './data/anonchat.db';
  const absolutePath = storage === ':memory:' ? ':memory:' : path.resolve(storage);
  if (absolutePath !== ':memory:') {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  }

  db = new DatabaseSync(absolutePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schemaSql);
  migrateLegacyPostsTable(db);

  try {
    db.exec('ALTER TABLE user_verifications ADD COLUMN invalidated_at TEXT;');
  } catch (error) {
    if (!/duplicate column/i.test(error.message || '')) {
      throw error;
    }
  }

  return db;
}

function ensureDatabase() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

function resetDatabase() {
  ensureDatabase();
  db.exec(`
    DELETE FROM moderation_reports;
    DELETE FROM audit_records;
    DELETE FROM identity_history;
    DELETE FROM marketplace_transactions;
    DELETE FROM identity_marketplace_offers;
    DELETE FROM post_reactions;
    DELETE FROM post_bids;
    DELETE FROM post_versions;
    DELETE FROM posts;
    DELETE FROM rotation_jobs;
    DELETE FROM user_verifications;
    DELETE FROM balances;
    DELETE FROM identities;
    DELETE FROM accounts;
  `);
  return db;
}

module.exports = {
  initializeDatabase,
  ensureDatabase,
  resetDatabase,
  get db() {
    return ensureDatabase();
  }
};
