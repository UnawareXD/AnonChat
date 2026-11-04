const bcrypt = require('bcryptjs');
const { randomUUID, randomInt } = require('crypto');
const { ensureDatabase } = require('./db');
const { createAccount } = require('./identityService');

const requestTimestamps = new Map();
const MAX_REQUESTS_PER_WINDOW = 3;
const REQUEST_WINDOW_MS = 60 * 1000;

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function randomCode() {
  return String(randomInt(100000, 1000000)).padStart(6, '0');
}

function makeHash(value) {
  return bcrypt.hashSync(String(value), 10);
}

function enforceRequestLimit(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('Phone number is required.');
  }

  const now = Date.now();
  const recent = (requestTimestamps.get(normalized) || []).filter((time) => now - time < REQUEST_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error('Too many verification requests. Please wait a moment and try again.');
  }

  recent.push(now);
  requestTimestamps.set(normalized, recent);
}

function requestVerificationCode(phone, { env = 'development', logger = console } = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('Phone number is required.');
  }

  enforceRequestLimit(normalized);

  const conn = ensureDatabase();
  const existingAccount = conn.prepare('SELECT id FROM accounts WHERE phone = ?').get(normalized);
  const account = existingAccount ? { id: existingAccount.id } : createAccount({ phone: normalized });
  conn.prepare('UPDATE user_verifications SET invalidated_at = datetime(\'now\') WHERE phone = ? AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > datetime(\'now\')').run(normalized);

  const code = randomCode();
  const verificationId = randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  conn.prepare('INSERT INTO user_verifications (id, account_id, phone, code_hash, expires_at, invalidated_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .run(verificationId, account.id, normalized, makeHash(code), expiresAt);

  if (env === 'development') {
    logger.log(`[dev-sms] ${normalized}: ${code}`);
  }

  return {
    accountId: account.id,
    code,
    development: env === 'development'
  };
}

function verifyCode(phone, code) {
  const normalized = normalizePhone(phone);
  const codeValue = String(code || '').trim();
  if (!normalized || !codeValue) {
    throw new Error('Phone and code are required.');
  }

  const conn = ensureDatabase();
  const verification = conn.prepare(`
    SELECT *
    FROM user_verifications
    WHERE phone = ?
      AND used_at IS NULL
      AND invalidated_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(normalized);

  if (!verification) {
    throw new Error('No valid verification code was found for this phone number.');
  }

  if (Date.now() > new Date(verification.expires_at).getTime()) {
    throw new Error('Verification code expired.');
  }

  if (!bcrypt.compareSync(codeValue, verification.code_hash)) {
    throw new Error('Incorrect verification code.');
  }

  conn.prepare("UPDATE user_verifications SET used_at = datetime('now'), invalidated_at = datetime('now') WHERE id = ?").run(verification.id);

  const account = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(verification.account_id);
  if (!account) {
    throw new Error('Account for this verification code could not be found.');
  }

  return account;
}

module.exports = {
  requestVerificationCode,
  verifyCode,
  makeHash,
  randomCode,
  normalizePhone
};
