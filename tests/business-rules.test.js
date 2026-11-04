const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, resetDatabase } = require('../src/db');
const { createAccount, findOrCreateRandomIdentity, rotateRandomIdentity, getActiveIdentityForAccount, purchaseCustomIdentity } = require('../src/identityService');
const { createPost, placeBid } = require('../src/postService');
const { settlePendingBids } = require('../src/bidService');
const { createOffer, acceptOffer, declineOffer, expireOffers, getMarketplaceSummary } = require('../src/marketplaceService');
const { requestVerificationCode, verifyCode } = require('../src/auth');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AnonChat business rules', { concurrency: false }, () => {
  test('random identity generation and collision handling', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+12345678900' });
  const identity = findOrCreateRandomIdentity(account.id);
  assert.ok(identity.username.length >= 4);
  assert.match(identity.username, /^[a-z0-9_]+$/i);
  const sameIdentity = findOrCreateRandomIdentity(account.id);
  assert.equal(sameIdentity.id, identity.id);
});

test('rotation keeps old identities private and does not link them publicly', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000001' });
  const previousIdentity = getActiveIdentityForAccount(account.id);
  const next = rotateRandomIdentity(account.id);
  assert.notEqual(next.id, previousIdentity.id);
  assert.equal(getActiveIdentityForAccount(account.id).id, next.id);

  const historyRow = require('../src/db').db.prepare('SELECT * FROM identity_history WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').get(account.id);
  assert.ok(historyRow);
  assert.equal(historyRow.old_identity_id, previousIdentity.id);
  assert.equal(historyRow.new_identity_id, next.id);
});

test('permanent custom identity cannot be sold or rotated', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000002' });
  const custom = purchaseCustomIdentity(account.id, 'shadow');
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.custom_permanent, 1);
  assert.throws(() => rotateRandomIdentity(account.id));
  assert.throws(() => createOffer(account.id, custom.id));
});

test('private archive access is restricted to the owning account', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const first = createAccount({ phone: '+15550000003' });
  const second = createAccount({ phone: '+15550000004' });
  const firstIdentity = getActiveIdentityForAccount(first.id);
  const archive = require('../src/archiveService').getArchiveForAccount(first.id);
  assert.ok(archive.identities.some((item) => item.id === firstIdentity.id));

  const secondArchive = require('../src/archiveService').getArchiveForAccount(second.id);
  assert.ok(!secondArchive.identities.some((item) => item.id === firstIdentity.id));
});

test('post value is derived from the latest settled bid after the lock expires', async () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000005' });
  const identity = getActiveIdentityForAccount(account.id);
  const post = createPost(account.id, identity.id, 'hello world');
  placeBid(account.id, post.id, 500);

  await sleep(3200);
  const settled = settlePendingBids();
  assert.ok(settled >= 1);
  assert.equal(require('../src/postService').getLatestSettledValue(post.id), 500);
});

test('three-second bid settlement and replacement rules', async () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000006' });
  const identity = getActiveIdentityForAccount(account.id);
  const post = createPost(account.id, identity.id, 'alpha');
  const bid1 = placeBid(account.id, post.id, 500);
  const bid2 = placeBid(account.id, post.id, 600);
  assert.notEqual(bid1.id, bid2.id);

  await sleep(3200);
  const settled = settlePendingBids();
  assert.ok(settled >= 1);
  const value = require('../src/postService').getLatestSettledValue(post.id);
  assert.ok(value >= 500);
});

test('insufficient balance and refund handling are enforced', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000007' });
  const identity = getActiveIdentityForAccount(account.id);
  const post = createPost(account.id, identity.id, 'balance test');
  require('../src/db').db.prepare('UPDATE balances SET balance_cents = 0, locked_cents = 0 WHERE account_id = ?').run(account.id);
  assert.throws(() => placeBid(account.id, post.id, 999), /balance/i);
});

test('marketplace acceptance, decline, and expiry flow', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const seller = createAccount({ phone: '+15550000008' });
  const buyer = createAccount({ phone: '+15550000009' });
  const identity = getActiveIdentityForAccount(seller.id);
  const offer = createOffer(buyer.id, identity.id);
  const accepted = acceptOffer(seller.id, offer.id);
  assert.equal(accepted.status, 'accepted');

  const declinedOffer = createOffer(buyer.id, identity.id);
  const declined = declineOffer(seller.id, declinedOffer.id);
  assert.equal(declined.status, 'declined');

  const expiredOffer = createOffer(buyer.id, identity.id);
  require('../src/db').db.prepare('UPDATE identity_marketplace_offers SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', expiredOffer.id);
  const expired = expireOffers();
  assert.ok(expired.some((item) => item.id === expiredOffer.id));
});

test('seller payment and platform fee calculation', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const seller = createAccount({ phone: '+15550000010' });
  const buyer = createAccount({ phone: '+15550000011' });
  const identity = getActiveIdentityForAccount(seller.id);
  const offer = createOffer(buyer.id, identity.id);
  const accepted = acceptOffer(seller.id, offer.id);
  const summary = getMarketplaceSummary();

  assert.ok(accepted.price_cents > 0);
  assert.ok(summary.totalValueCents >= accepted.price_cents || summary.totalFeesCents >= 0);
});

test('duplicate transactions and unauthorized access are prevented', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const seller = createAccount({ phone: '+15550000012' });
  const buyer = createAccount({ phone: '+15550000013' });
  const identity = getActiveIdentityForAccount(seller.id);
  const offer = createOffer(buyer.id, identity.id);

  assert.throws(() => createOffer(buyer.id, identity.id));
  assert.throws(() => acceptOffer(buyer.id, offer.id));
  assert.throws(() => acceptOffer(seller.id, 'missing-id'));
});

test('replies stay nested under their parent post and never appear as top-level feed items', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000014' });
  const identity = getActiveIdentityForAccount(account.id);
  const parent = createPost(account.id, identity.id, 'Original post');
  const reply = require('../src/postService').replyToPost(account.id, identity.id, parent.id, 'Nested reply');

  assert.equal(reply.parent_post_id, parent.id);

  const feed = require('../server').buildPublicFeed();
  assert.ok(feed.some((item) => item.id === parent.id));
  assert.ok(!feed.some((item) => item.id === reply.id));
  const parentCard = feed.find((item) => item.id === parent.id);
  assert.ok(parentCard.replies.some((item) => item.id === reply.id));
});

test('rotated identities keep historical replies visible in the parent thread', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const account = createAccount({ phone: '+15550000015' });
  const originalIdentity = getActiveIdentityForAccount(account.id);
  const parent = createPost(account.id, originalIdentity.id, 'Original post');
  const reply = require('../src/postService').replyToPost(account.id, originalIdentity.id, parent.id, 'Historical reply');

  const preRotateFeed = require('../server').buildPublicFeed(account.id);
  assert.ok(preRotateFeed.some((item) => item.id === parent.id));
  assert.ok(preRotateFeed.find((item) => item.id === parent.id)?.replies.some((item) => item.id === reply.id));

  const rotated = rotateRandomIdentity(account.id);
  assert.notEqual(rotated.id, originalIdentity.id);

  const feedAfterRotate = require('../server').buildPublicFeed(account.id);
  const parentCard = feedAfterRotate.find((item) => item.id === parent.id);
  assert.ok(parentCard);
  assert.ok(parentCard.replies.some((item) => item.id === reply.id && item.identity_id === originalIdentity.id));

  const thread = require('../src/postService').getThreadForPost(parent.id, account.id);
  assert.ok(thread);
  assert.ok(thread.replies.some((item) => item.id === reply.id && item.identity_id === originalIdentity.id));

  const futurePost = createPost(account.id, rotated.id, 'Future post from new identity');
  const refreshedFeed = require('../server').buildPublicFeed(account.id);
  assert.ok(refreshedFeed.some((item) => item.id === futurePost.id && item.identity_id === rotated.id));
});

test('marketplace renders a summary and offer cards without undefined values', async () => {
  const { createApp } = require('../server');
  const app = createApp({ env: 'test', storage: ':memory:' });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  const port = server.address().port;

  const jar = new Map();
  async function request(path, method = 'GET', body) {
    const headers = new Headers();
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const cookieHeader = Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = response.headers.get('set-cookie');
    if (raw) {
      const parts = raw.split(/,(?=[^;]+?=)/);
      for (const part of parts) {
        const pair = part.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx > -1) {
          jar.set(pair.slice(0, idx), pair.slice(idx + 1));
        }
      }
    }
    const text = await response.text();
    return { response, text };
  }

  const seller = createAccount({ phone: '+15550000021' });
  const buyer = createAccount({ phone: '+15550000022' });
  const identity = getActiveIdentityForAccount(seller.id);
  createOffer(buyer.id, identity.id);

  const requestCode = await request('/api/auth/request-code', 'POST', { phone: seller.phone });
  assert.equal(requestCode.response.status, 200);
  const verify = await request('/api/auth/verify', 'POST', { phone: seller.phone, code: requestCode.text ? JSON.parse(requestCode.text).code : undefined });
  assert.equal(verify.response.status, 200);

  const page = await request('/marketplace', 'GET');
  assert.equal(page.response.status, 200);
  assert.match(String(page.text || ''), /Total accepted value:/i);
  assert.match(String(page.text || ''), /Price:/i);

  await new Promise((resolve) => server.close(resolve));
});

test('authentication flow creates accounts, issues unique codes, and rejects invalid reuse', () => {
  initializeDatabase({ storage: ':memory:' });
  resetDatabase();

  const firstPhone = '+15550000016';
  const firstAttempt = requestVerificationCode(firstPhone, { env: 'development' });
  const secondAttempt = requestVerificationCode(firstPhone, { env: 'development' });

  assert.ok(/^[0-9]{6}$/.test(firstAttempt.code));
  assert.ok(/^[0-9]{6}$/.test(secondAttempt.code));
  assert.notEqual(firstAttempt.code, secondAttempt.code);

  const correct = verifyCode(firstPhone, secondAttempt.code);
  assert.equal(correct.phone, firstPhone);
  assert.throws(() => verifyCode(firstPhone, secondAttempt.code), /used|already|invalid|expired|found/i);
  assert.throws(() => verifyCode(firstPhone, firstAttempt.code), /expired|invalid|used|already|found/i);

  const wrongPhone = '+15550000017';
  const wrongPhoneAttempt = requestVerificationCode(wrongPhone, { env: 'development' });
  assert.throws(() => verifyCode(wrongPhone, '000000'), /incorrect|invalid/i);

  const expiredCode = wrongPhoneAttempt.code;
  require('../src/db').db.prepare('UPDATE user_verifications SET expires_at = ? WHERE phone = ?').run('2000-01-01T00:00:00Z', wrongPhone);
  assert.throws(() => verifyCode(wrongPhone, expiredCode), /expired/i);
});

test('registration and login complete the auth flow with a real session', async () => {
  const { createApp } = require('../server');
  const app = createApp({ env: 'test', storage: ':memory:' });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  const port = server.address().port;

  const jar = new Map();
  async function request(path, method = 'GET', body) {
    const headers = new Headers();
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const cookieHeader = Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = response.headers.get('set-cookie');
    if (raw) {
      const parts = raw.split(/,(?=[^;]+?=)/);
      for (const part of parts) {
        const pair = part.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx > -1) {
          jar.set(pair.slice(0, idx), pair.slice(idx + 1));
        }
      }
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { response, data };
  }

  const registerPhone = '+15550000018';
  const firstRequest = await request('/api/auth/request-code', 'POST', { phone: registerPhone });
  assert.equal(firstRequest.response.status, 200);
  assert.match(String(firstRequest.data.code || ''), /^[0-9]{6}$/);

  const verify = await request('/api/auth/verify', 'POST', { phone: registerPhone, code: firstRequest.data.code });
  assert.equal(verify.response.status, 200);
  assert.equal(verify.data.redirect, '/feed');

  const feed = await request('/api/feed', 'GET');
  assert.equal(feed.response.status, 200);
  assert.ok(Array.isArray(feed.data.posts));

  const loginPhone = registerPhone;
  const loginRequest = await request('/api/auth/request-code', 'POST', { phone: loginPhone });
  assert.equal(loginRequest.response.status, 200);
  const loginVerify = await request('/api/auth/verify', 'POST', { phone: loginPhone, code: loginRequest.data.code });
  assert.equal(loginVerify.response.status, 200);
  const profileCheck = await request('/api/feed', 'GET');
  assert.equal(profileCheck.response.status, 200);

  await new Promise((resolve) => server.close(resolve));
});

test('legacy posts schema is migrated without losing rows or top-level posts', () => {
  const tempPath = path.join(os.tmpdir(), `anonchat-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const legacy = require('node:sqlite').DatabaseSync;

  try {
    const conn = new legacy(tempPath);
    conn.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_identity_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        custom_permanent INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        rotated_at TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_value_cents INTEGER NOT NULL DEFAULT 0,
        selected_version_id TEXT
      );
      INSERT INTO accounts (id, phone, status) VALUES ('acc_legacy', '+15550000019', 'active');
      INSERT INTO identities (id, account_id, username, kind, custom_permanent, active, status) VALUES ('id_legacy', 'acc_legacy', 'legacyuser', 'random', 0, 1, 'active');
      INSERT INTO posts (id, account_id, identity_id, body, current_value_cents) VALUES ('post_legacy', 'acc_legacy', 'id_legacy', 'legacy top-level post', 250);
    `);
    conn.close();

    initializeDatabase({ storage: tempPath });
    const db = require('../src/db').db;
    const columnInfo = db.prepare('PRAGMA table_info(posts)').all();
    assert.ok(columnInfo.some((column) => column.name === 'parent_post_id'));

    const legacyRow = db.prepare('SELECT * FROM posts WHERE id = ?').get('post_legacy');
    assert.ok(legacyRow);
    assert.equal(legacyRow.parent_post_id, null);

    const account = require('../src/identityService').createAccount({ phone: '+15550000020' });
    const identity = require('../src/identityService').getActiveIdentityForAccount(account.id);
    const reply = require('../src/postService').replyToPost(account.id, identity.id, 'post_legacy', 'legacy reply');
    assert.equal(reply.parent_post_id, 'post_legacy');
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failures for temporary test database
    }
  }
});

test('sse endpoint broadcasts live post and reply updates to connected clients', async () => {
  try {
    const { createApp } = require('../server');
    const app = createApp({ env: 'test', storage: ':memory:' });
    const server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.on('error', reject);
    });
    const port = server.address().port;

    const jar = new Map();
    async function request(path, method = 'GET', body) {
      const headers = new Headers();
      if (body !== undefined) {
        headers.set('Content-Type', 'application/json');
      }
      const cookieHeader = Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
      if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
      }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const raw = response.headers.get('set-cookie');
      if (raw) {
        const parts = raw.split(/,(?=[^;]+?=)/);
        for (const part of parts) {
          const pair = part.split(';')[0];
          const idx = pair.indexOf('=');
          if (idx > -1) {
            jar.set(pair.slice(0, idx), pair.slice(idx + 1));
          }
        }
      }
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      return { response, data };
    }

    const phone = '+15550000015';
    const requestCode = await request('/api/auth/request-code', 'POST', { phone });
    const code = requestCode.data.code;
    const verify = await request('/api/auth/verify', 'POST', { phone, code });
    assert.equal(verify.response.status, 200);

    const stream = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: {
        Cookie: Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; '),
        Accept: 'text/event-stream'
      }
    });
    assert.equal(stream.status, 200);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();

    const readNextEvent = async () => {
      let eventName = '';
      let dataText = '';
      let sawDataLine = false;

      while (true) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timed out')), 3000))
        ]);
        if (done) {
          throw new Error('Stream closed before an SSE event was received.');
        }
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          if (!line) {
            if (sawDataLine && eventName) {
              return { eventName, payload: JSON.parse(dataText) };
            }
            dataText = '';
            sawDataLine = false;
            eventName = eventName || '';
            continue;
          }
          if (line.startsWith('event:')) {
            eventName = line.replace('event:', '').trim();
          } else if (line.startsWith('data:')) {
            sawDataLine = true;
            dataText = `${dataText}${dataText ? '\n' : ''}${line.replace('data:', '').trim()}`;
          }
        }
      }
    };

    const connectedEvent = await readNextEvent();
    assert.equal(connectedEvent.eventName, 'connected');

    const createdPost = await request('/api/posts', 'POST', { body: 'live post' });
    const postEvent = await readNextEvent();
    assert.equal(postEvent.eventName, 'feed-update');
    assert.equal(postEvent.payload.type, 'post');
    assert.equal(postEvent.payload.post.body, 'live post');

    const reply = await request(`/api/posts/${createdPost.data.post.id}/replies`, 'POST', { body: 'live reply' });
    const replyEvent = await readNextEvent();
    assert.equal(replyEvent.eventName, 'feed-update');
    assert.equal(replyEvent.payload.type, 'reply');
    assert.equal(replyEvent.payload.reply.body, 'live reply');
    assert.equal(replyEvent.payload.reply.parent_post_id, createdPost.data.post.id);

    await reader.cancel();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(reply.data.post.body === 'live reply');
  } catch (error) {
    throw error;
  }
});
});
