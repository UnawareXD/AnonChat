const express = require('express');
const path = require('path');
const os = require('os');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { config } = require('./src/config');
const { initializeDatabase, ensureDatabase, resetDatabase } = require('./src/db');
const {
  createAccount,
  getActiveIdentityForAccount,
  findOrCreateRandomIdentity,
  purchaseCustomIdentity,
  rotateRandomIdentity,
  validateUsername
} = require('./src/identityService');
const {
  createPost,
  replyToPost,
  getReactionSummary,
  setPostReaction,
  removePostReaction,
  getThreadForPost,
  buildNestedReplies
} = require('./src/postService');
const { getArchiveForAccount } = require('./src/archiveService');
const { requestVerificationCode, verifyCode } = require('./src/auth');
const { createOffer, acceptOffer, declineOffer, getMarketplaceSummary } = require('./src/marketplaceService');

const sseClients = new Set();

function randomId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function getPreferredLanIPv4() {
  const interfaces = os.networkInterfaces ? os.networkInterfaces() : {};
  const candidates = [];

  for (const [name, details] of Object.entries(interfaces)) {
    if (!details || !Array.isArray(details)) {
      continue;
    }

    for (const detail of details) {
      if (!detail || detail.internal || detail.family !== 'IPv4') {
        continue;
      }
      if (detail.address === '127.0.0.1' || detail.address.startsWith('169.254.')) {
        continue;
      }
      if (/docker|virtual|vmware|vbox|loopback|tun|tap|wsl|hamachi|br-/i.test(name)) {
        continue;
      }
      candidates.push(detail.address);
    }
  }

  const preferredOrder = [
    (value) => /^10\./.test(value),
    (value) => /^192\.168\./.test(value),
    (value) => /^172\.(1[6-9]|2\d|3[01])\./.test(value),
    () => true
  ];

  for (const predicate of preferredOrder) {
    const match = candidates.find(predicate);
    if (match) {
      return match;
    }
  }

  return null;
}

function serializePost(post, accountId = null) {
  if (!post) {
    return null;
  }
  const summary = getReactionSummary(post.id, accountId);
  const identity = ensureDatabase().prepare('SELECT username, kind, custom_permanent FROM identities WHERE id = ?').get(post.identity_id);

  return {
    ...post,
    public_identity: identity ? identity.username : 'Anonymous',
    kind: identity ? identity.kind : 'post',
    custom_permanent: identity ? Number(identity.custom_permanent) : 0,
    current_value_cents: Number(post.current_value_cents || 0),
    replies: buildNestedReplies(post.id, accountId),
    reaction_counts: {
      likes: summary.likes,
      dislikes: summary.dislikes
    },
    user_reaction: summary.user_reaction
  };
}

function broadcastFeedEvent(type, payload) {
  const event = {
    type,
    ...payload
  };
  const body = `event: feed-update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(body);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function buildPublicFeed(accountId = null) {
  const conn = ensureDatabase();
  const rows = conn.prepare(`
    SELECT p.*, i.username, i.kind, i.custom_permanent, a.phone
    FROM posts p
    JOIN identities i ON i.id = p.identity_id
    JOIN accounts a ON a.id = p.account_id
    WHERE p.parent_post_id IS NULL
    ORDER BY p.created_at DESC
  `).all();

  return rows.map((row) => serializePost(row, accountId));
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }
  next();
}

function createApp(options = {}) {
  const app = express();
  const appEnv = options.env || config.appEnv || 'development';
  const storage = options.storage || config.dbPath;
  initializeDatabase({ storage });

  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  }));

  app.get('/', (req, res) => {
    if (req.session?.userId) {
      return res.redirect('/feed');
    }
    return res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    if (req.session?.userId) {
      return res.redirect('/feed');
    }
    res.render('login', { activeNav: 'feed' });
  });

  app.get('/register', (req, res) => {
    if (req.session?.userId) {
      return res.redirect('/feed');
    }
    res.render('register', { activeNav: 'feed' });
  });

  app.post('/api/auth/request-code', (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim();
      const result = requestVerificationCode(phone, { env: appEnv });
      return res.json({
        ok: true,
        accountId: result.accountId,
        ...(appEnv === 'production' ? {} : { code: result.code })
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Unable to request verification code.' });
    }
  });

  app.post('/api/auth/verify', (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim();
      const code = String(req.body?.code || '').trim();
      const account = ensureDatabase().prepare('SELECT * FROM accounts WHERE phone = ?').get(phone);
      if (!account) {
        return res.status(400).json({ ok: false, error: 'Account not found. Request a code first.' });
      }

      const verifiedAccount = verifyCode(phone, code);
      req.session.userId = verifiedAccount.id;
      req.session.identityId = getActiveIdentityForAccount(verifiedAccount.id)?.id || null;
      req.session.save((error) => {
        if (error) {
          return res.status(500).json({ ok: false, error: 'Unable to establish session.' });
        }
        return res.json({ ok: true, redirect: '/feed' });
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Unable to verify code.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      return res.json({ ok: true, redirect: '/login' });
    });
  });

  app.get('/api/feed', requireAuth, (req, res) => {
    const posts = buildPublicFeed(req.session.userId);
    res.json({ posts });
  });

  app.get('/feed', requireAuth, (req, res) => {
    const posts = buildPublicFeed(req.session.userId);
    res.render('feed', { posts, activeNav: 'feed' });
  });

  app.get('/archive', requireAuth, (req, res) => {
    const archive = getArchiveForAccount(req.session.userId);
    res.render('archive', { archive, activeNav: 'archive' });
  });

  app.get('/marketplace', requireAuth, (req, res) => {
    const summary = getMarketplaceSummary();
    const offers = ensureDatabase().prepare('SELECT * FROM identity_marketplace_offers ORDER BY created_at DESC').all();
    res.render('marketplace', { activeNav: 'marketplace', summary, offers });
  });

  app.post('/api/marketplace/offers/:offerId/accept', requireAuth, (req, res) => {
    try {
      const offer = acceptOffer(req.session.userId, req.params.offerId);
      return res.json({ ok: true, offer });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/marketplace/offers/:offerId/decline', requireAuth, (req, res) => {
    try {
      const offer = declineOffer(req.session.userId, req.params.offerId);
      return res.json({ ok: true, offer });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get('/settings', requireAuth, (req, res) => {
    const user = ensureDatabase().prepare('SELECT * FROM accounts WHERE id = ?').get(req.session.userId);
    const identity = getActiveIdentityForAccount(user.id);
    res.render('settings', { user, identity, activeNav: 'settings' });
  });

  app.get('/identities/:id', requireAuth, (req, res) => {
    const identity = ensureDatabase().prepare('SELECT * FROM identities WHERE id = ?').get(req.params.id);
    if (!identity) {
      return res.status(404).send('Identity not found.');
    }
    const posts = ensureDatabase().prepare('SELECT * FROM posts WHERE identity_id = ? AND parent_post_id IS NULL ORDER BY created_at DESC').all(req.params.id);
    const body = `
      <h1>${identity.username}</h1>
      <p>Identity: ${identity.kind}</p>
      <ul>${posts.map((post) => `<li>${post.body}</li>`).join('')}</ul>
    `;
    return res.send(body);
  });

  app.get('/posts/:id', requireAuth, (req, res) => {
    const thread = getThreadForPost(req.params.id, req.session.userId);
    if (!thread) {
      return res.status(404).send('Post not found.');
    }
    return res.render('thread', { thread, activeNav: 'feed' });
  });

  app.post('/api/posts', requireAuth, (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ ok: false, error: 'Post content is required.' });
    }
    const identity = getActiveIdentityForAccount(req.session.userId);
    const post = createPost(req.session.userId, identity.id, body);
    const payload = serializePost(post, req.session.userId);
    broadcastFeedEvent('post', { post: payload });
    return res.json({ ok: true, post: payload });
  });

  app.post('/api/posts/:postId/replies', requireAuth, (req, res) => {
    const postId = req.params.postId;
    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ ok: false, error: 'Reply content is required.' });
    }
    const identity = getActiveIdentityForAccount(req.session.userId);
    const reply = replyToPost(req.session.userId, identity.id, postId, body);
    const payload = serializePost(reply, req.session.userId);
    broadcastFeedEvent('reply', { reply: payload, parent_post_id: postId, postId });
    res.json({ ok: true, post: payload, reply: payload });
  });

  app.post('/api/posts/:postId/reactions', requireAuth, (req, res) => {
    const postId = req.params.postId;
    const reaction = String(req.body?.reaction || '').trim();
    const remove = Boolean(req.body?.remove);
    if (!['like', 'dislike'].includes(reaction) && !remove) {
      return res.status(400).json({ ok: false, error: 'Reaction must be like or dislike.' });
    }

    try {
      let result;
      if (remove) {
        result = removePostReaction(req.session.userId, postId);
      } else {
        const identity = getActiveIdentityForAccount(req.session.userId);
        result = setPostReaction(req.session.userId, identity.id, postId, reaction);
      }
      broadcastFeedEvent('reaction', { postId, reaction: result });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/account/custom-identity', requireAuth, async (req, res) => {
    try {
      const username = req.body?.username ?? '';
      const identity = purchaseCustomIdentity(req.session.userId, username);
      return res.json({ ok: true, identity });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/account/rotate', requireAuth, (req, res) => {
    try {
      const identity = rotateRandomIdentity(req.session.userId);
      return res.json({ ok: true, identity });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    sseClients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, connected: true })}\n\n`);
    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.use((error, req, res, next) => {
    if (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Unexpected server error.' });
    }
    return next();
  });

  return app;
}

module.exports = {
  createApp,
  buildPublicFeed,
  sseClients
};

if (require.main === module) {
  const app = createApp({ env: config.appEnv, storage: config.dbPath });
  app.listen(config.port, config.host, () => {
    const lanIPv4 = getPreferredLanIPv4();
    const localUrl = `http://localhost:${config.port}`;
    const networkUrl = lanIPv4 ? `http://${lanIPv4}:${config.port}` : 'http://[no-LAN-ip-detected]';

    console.log('AnonChat ready.');
    console.log(`Local URL: ${localUrl}`);
    console.log(`Network URL: ${networkUrl}`);
  });
}
