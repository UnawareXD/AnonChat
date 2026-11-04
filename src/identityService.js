const { randomUUID } = require('crypto');
const { config } = require('./config');
const { ensureDatabase } = require('./db');

function randomId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

const RESERVED = new Set([
  'admin', 'system', 'support', 'help', 'anonymous', 'mod', 'staff', 'root', 'owner',
  'marketplace', 'archive', 'settings', 'feed', 'login', 'register', 'bot', 'null', 'undefined'
]);

function generateRandomUsername() {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, 'x');
  return `${rand}${Math.floor(Math.random() * 90 + 10)}`;
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new Error('Username is required.');
  }
  const clean = username.trim();
  if (clean.length < 4 || clean.length > 18) {
    throw new Error('Username must be 4-18 characters.');
  }
  if (!/^[A-Za-z0-9_]+$/.test(clean)) {
    throw new Error('Only letters, numbers, and underscores are allowed.');
  }
  if (RESERVED.has(clean.toLowerCase())) {
    throw new Error('That username is reserved.');
  }
  return clean;
}

function accountExistsByPhone(phone) {
  return ensureDatabase().prepare('SELECT id FROM accounts WHERE phone = ?').get(phone);
}

function getIdentityForAccount(accountId, identityId) {
  return ensureDatabase().prepare('SELECT * FROM identities WHERE id = ? AND account_id = ?').get(identityId, accountId);
}

function createAccount({ phone, name = null }) {
  const conn = ensureDatabase();
  const normalized = String(phone || '').trim();
  if (!normalized) {
    throw new Error('Phone number is required.');
  }
  if (accountExistsByPhone(normalized)) {
    throw new Error('Account already exists for this phone number.');
  }

  const accountId = randomId('acc');
  conn.prepare('INSERT INTO accounts (id, phone, current_identity_id, status) VALUES (?, ?, NULL, ?)').run(accountId, normalized, 'active');
  conn.prepare("INSERT INTO balances (account_id, balance_cents, locked_cents, updated_at) VALUES (?, ?, 0, datetime('now'))").run(accountId, config.defaultBalanceCents);
  conn.prepare('INSERT INTO ledger_entries (id, account_id, entry_type, amount_cents, balance_after_cents, related_entity_type, related_entity_id, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomId('ledger'), accountId, 'credit', config.defaultBalanceCents, config.defaultBalanceCents, 'account', accountId, 'initial account funding');

  const identity = findOrCreateRandomIdentity(accountId, { force: true });
  conn.prepare('UPDATE accounts SET current_identity_id = ? WHERE id = ?').run(identity.id, accountId);
  return { id: accountId, phone: normalized, current_identity_id: identity.id, created_at: new Date().toISOString() };
}

function ensureUniqueUsername(username) {
  const existing = ensureDatabase().prepare('SELECT id FROM identities WHERE username = ? AND active = 1').get(username);
  if (existing) {
    throw new Error('Username is unavailable.');
  }
}

function findOrCreateRandomIdentity(accountId, { force = false } = {}) {
  const conn = ensureDatabase();
  const existing = conn.prepare('SELECT * FROM identities WHERE account_id = ? AND active = 1 AND kind = ?').get(accountId, 'random');
  if (existing && !force) {
    return existing;
  }
  let username;
  let attempts = 0;
  while (attempts < 100) {
    username = generateRandomUsername();
    const taken = conn.prepare('SELECT id FROM identities WHERE username = ?').get(username);
    if (!taken) {
      break;
    }
    attempts += 1;
  }
  if (!username) {
    throw new Error('Could not generate a unique random identity.');
  }

  const identityId = randomId('id');
  conn.prepare(`
    INSERT INTO identities (id, account_id, username, kind, custom_permanent, active, status, created_at)
    VALUES (?, ?, ?, 'random', 0, 1, 'active', datetime('now'))
  `).run(identityId, accountId, username);
  return conn.prepare('SELECT * FROM identities WHERE id = ?').get(identityId);
}

function getActiveIdentityForAccount(accountId) {
  const account = ensureDatabase().prepare('SELECT current_identity_id FROM accounts WHERE id = ?').get(accountId);
  if (!account || !account.current_identity_id) {
    return findOrCreateRandomIdentity(accountId);
  }
  return ensureDatabase().prepare('SELECT * FROM identities WHERE id = ?').get(account.current_identity_id);
}

function rotateRandomIdentity(accountId) {
  const conn = ensureDatabase();
  const account = conn.prepare('SELECT current_identity_id FROM accounts WHERE id = ?').get(accountId);
  if (!account || !account.current_identity_id) {
    return findOrCreateRandomIdentity(accountId);
  }

  const current = conn.prepare('SELECT * FROM identities WHERE id = ?').get(account.current_identity_id);
  if (!current) {
    return findOrCreateRandomIdentity(accountId);
  }
  if (current.custom_permanent) {
    throw new Error('Permanent custom identities do not rotate.');
  }

  let username;
  let attempts = 0;
  while (attempts < 100) {
    username = generateRandomUsername();
    const taken = conn.prepare('SELECT id FROM identities WHERE username = ?').get(username);
    if (!taken) {
      break;
    }
    attempts += 1;
  }
  if (!username) {
    throw new Error('A collision-free random username could not be generated.');
  }

  const newIdentityId = randomId('id');
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.prepare("UPDATE identities SET active = 0, rotated_at = datetime('now'), status = ? WHERE id = ?").run('rotated', current.id);
    conn.prepare(`
      INSERT INTO identities (id, account_id, username, kind, custom_permanent, active, status, created_at)
      VALUES (?, ?, ?, 'random', 0, 1, 'active', datetime('now'))
    `).run(newIdentityId, accountId, username);
    conn.prepare('INSERT INTO identity_history (id, account_id, old_identity_id, new_identity_id, reason) VALUES (?, ?, ?, ?, ?)')
      .run(randomId('hist'), accountId, current.id, newIdentityId, 'rotation');
    conn.prepare('UPDATE accounts SET current_identity_id = ? WHERE id = ?').run(newIdentityId, accountId);
    conn.prepare("INSERT INTO rotation_jobs (id, account_id, identity_id, next_identity_id, scheduled_for, executed_at, status) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)")
      .run(randomId('rot'), accountId, current.id, newIdentityId, new Date().toISOString(), 'completed');
    conn.exec('COMMIT');
    return conn.prepare('SELECT * FROM identities WHERE id = ?').get(newIdentityId);
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

function purchaseCustomIdentity(accountId, username) {
  const conn = ensureDatabase();
  const cleanUsername = validateUsername(username);
  const existingCustom = conn.prepare('SELECT * FROM identities WHERE account_id = ? AND custom_permanent = 1').get(accountId);
  if (existingCustom) {
    throw new Error('This account already owns a permanent custom identity.');
  }
  const inUse = conn.prepare('SELECT id FROM identities WHERE username = ?').get(cleanUsername);
  if (inUse) {
    throw new Error('Username is unavailable.');
  }

  const balance = conn.prepare('SELECT balance_cents, locked_cents FROM balances WHERE account_id = ?').get(accountId);
  const available = (balance?.balance_cents || 0) - (balance?.locked_cents || 0);
  if (available < config.customIdentityPriceCents) {
    throw new Error('Insufficient balance for permanent custom identity purchase.');
  }

  const identityId = randomId('id');
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.prepare("UPDATE balances SET balance_cents = balance_cents - ?, updated_at = datetime('now') WHERE account_id = ?").run(config.customIdentityPriceCents, accountId);
    conn.prepare("INSERT INTO identities (id, account_id, username, kind, custom_permanent, active, status, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, datetime('now'))")
      .run(identityId, accountId, cleanUsername, 'custom', 'active');
    conn.prepare('UPDATE accounts SET current_identity_id = ? WHERE id = ?').run(identityId, accountId);
    conn.prepare('INSERT INTO ledger_entries (id, account_id, entry_type, amount_cents, balance_after_cents, related_entity_type, related_entity_id, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomId('ledger'), accountId, 'debit', -config.customIdentityPriceCents, (balance?.balance_cents || 0) - config.customIdentityPriceCents, 'identity', identityId, 'custom identity purchase');
    conn.exec('COMMIT');
    return conn.prepare('SELECT * FROM identities WHERE id = ?').get(identityId);
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  RESERVED,
  createAccount,
  findOrCreateRandomIdentity,
  getActiveIdentityForAccount,
  rotateRandomIdentity,
  purchaseCustomIdentity,
  validateUsername,
  getIdentityForAccount,
  randomId
};
