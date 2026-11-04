const { randomUUID } = require('crypto');
const { config } = require('./config');
const { ensureDatabase } = require('./db');

function randomId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function getLatestSettledValue(postId) {
  const row = ensureDatabase().prepare('SELECT current_value_cents FROM posts WHERE id = ?').get(postId);
  return row ? Number(row.current_value_cents) : 0;
}

function getReactionSummary(postId, accountId = null) {
  const conn = ensureDatabase();
  const counts = conn.prepare(`
    SELECT
      SUM(CASE WHEN reaction = 'like' THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN reaction = 'dislike' THEN 1 ELSE 0 END) AS dislikes
    FROM post_reactions
    WHERE post_id = ?
  `).get(postId);

  const userReaction = accountId
    ? conn.prepare('SELECT reaction FROM post_reactions WHERE post_id = ? AND account_id = ?').get(postId, accountId)
    : null;

  return {
    likes: Number(counts?.likes || 0),
    dislikes: Number(counts?.dislikes || 0),
    user_reaction: userReaction ? userReaction.reaction : null
  };
}

function setPostReaction(accountId, identityId, postId, reaction) {
  const conn = ensureDatabase();
  const valid = reaction === 'like' || reaction === 'dislike';
  if (!valid) {
    throw new Error('Reaction must be like or dislike.');
  }

  const post = conn.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) {
    throw new Error('Post not found.');
  }

  const existing = conn.prepare('SELECT * FROM post_reactions WHERE post_id = ? AND account_id = ?').get(postId, accountId);
  if (existing && existing.reaction === reaction) {
    return { ...getReactionSummary(postId, accountId), action: 'unchanged' };
  }

  conn.exec('BEGIN IMMEDIATE');
  try {
    if (existing) {
      conn.prepare("UPDATE post_reactions SET reaction = ?, identity_id = ?, created_at = datetime('now') WHERE id = ?").run(reaction, identityId, existing.id);
    } else {
      conn.prepare('INSERT INTO post_reactions (id, post_id, account_id, identity_id, reaction) VALUES (?, ?, ?, ?, ?)')
        .run(randomId('react'), postId, accountId, identityId, reaction);
    }
    conn.exec('COMMIT');
    return { ...getReactionSummary(postId, accountId), action: 'updated' };
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

function removePostReaction(accountId, postId) {
  const conn = ensureDatabase();
  const deleted = conn.prepare('DELETE FROM post_reactions WHERE post_id = ? AND account_id = ?').run(postId, accountId);
  return { removed: deleted.changes > 0, ...getReactionSummary(postId, accountId) };
}

function buildNestedReplies(parentId, accountId = null) {
  const conn = ensureDatabase();
  const rows = conn.prepare(`
    SELECT p.*, i.username, i.kind, i.custom_permanent, a.phone
    FROM posts p
    JOIN identities i ON i.id = p.identity_id
    JOIN accounts a ON a.id = p.account_id
    WHERE p.parent_post_id = ?
    ORDER BY p.created_at ASC
  `).all(parentId);

  return rows.map((row) => {
    const summary = getReactionSummary(row.id, accountId);
    return {
      ...row,
      current_value_cents: Number(row.current_value_cents || 0),
      public_identity: row.username,
      kind: row.kind,
      custom_permanent: Number(row.custom_permanent) === 1,
      body: row.body,
      parent_post_id: row.parent_post_id || null,
      replies: buildNestedReplies(row.id, accountId),
      reaction_counts: {
        likes: summary.likes,
        dislikes: summary.dislikes
      },
      user_reaction: summary.user_reaction
    };
  });
}

function getThreadForPost(postId, accountId = null) {
  const conn = ensureDatabase();
  const postRow = conn.prepare(`
    SELECT p.*, i.username, i.kind, i.custom_permanent, a.phone
    FROM posts p
    JOIN identities i ON i.id = p.identity_id
    JOIN accounts a ON a.id = p.account_id
    WHERE p.id = ?
  `).get(postId);
  if (!postRow) {
    return null;
  }
  const summary = getReactionSummary(postRow.id, accountId);
  return {
    ...postRow,
    current_value_cents: Number(postRow.current_value_cents || 0),
    public_identity: postRow.username,
    kind: postRow.kind,
    custom_permanent: Number(postRow.custom_permanent) === 1,
    body: postRow.body,
    parent_post_id: postRow.parent_post_id || null,
    replies: buildNestedReplies(postRow.id, accountId),
    reaction_counts: {
      likes: summary.likes,
      dislikes: summary.dislikes
    },
    user_reaction: summary.user_reaction
  };
}

function createPost(accountId, identityId, body) {
  const conn = ensureDatabase();
  const identity = conn.prepare('SELECT * FROM identities WHERE id = ? AND account_id = ?').get(identityId, accountId);
  if (!identity) {
    throw new Error('Identity not found for this account.');
  }
  const cleanBody = String(body || '').trim();
  if (!cleanBody) {
    throw new Error('Post content is required.');
  }
  const postId = randomId('post');
  const versionId = randomId('ver');
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.prepare('INSERT INTO posts (id, account_id, identity_id, parent_post_id, body, current_value_cents, selected_version_id) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(postId, accountId, identityId, cleanBody, config.minPostBidCents, versionId);
    conn.prepare('INSERT INTO post_versions (id, post_id, kind, content, created_by_account_id) VALUES (?, ?, ?, ?, ?)')
      .run(versionId, postId, 'original', cleanBody, accountId);
    conn.exec('COMMIT');
    return conn.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

function replyToPost(accountId, identityId, postId, body) {
  const post = ensureDatabase().prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) {
    throw new Error('Post not found.');
  }
  const identity = ensureDatabase().prepare('SELECT * FROM identities WHERE id = ? AND account_id = ?').get(identityId, accountId);
  if (!identity) {
    throw new Error('You cannot reply with this identity.');
  }
  const replyId = randomId('reply');
  const versionId = randomId('ver');
  const content = String(body || '').trim();
  if (!content) {
    throw new Error('Reply content is required.');
  }
  ensureDatabase().prepare('INSERT INTO posts (id, account_id, identity_id, parent_post_id, body, current_value_cents, selected_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(replyId, accountId, identityId, postId, content, config.minPostBidCents, versionId);
  ensureDatabase().prepare('INSERT INTO post_versions (id, post_id, kind, content, created_by_account_id) VALUES (?, ?, ?, ?, ?)')
    .run(versionId, replyId, 'original', content, accountId);
  return ensureDatabase().prepare('SELECT * FROM posts WHERE id = ?').get(replyId);
}

function placeBid(accountId, postId, amountCents) {
  const conn = ensureDatabase();
  const post = conn.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) {
    throw new Error('Post not found.');
  }

  const current = getLatestSettledValue(postId);
  const minimum = current > 0 ? current + config.minBidIncrementCents : config.minPostBidCents;
  const cleanAmount = Number(amountCents);
  if (!Number.isInteger(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Bid amount must be a positive integer.');
  }
  if (cleanAmount < minimum) {
    throw new Error(`Bid must be at least ${minimum} cents.`);
  }

  const balanceRow = conn.prepare('SELECT balance_cents, locked_cents FROM balances WHERE account_id = ?').get(accountId);
  if (!balanceRow) {
    throw new Error('Account balance not found.');
  }
  const available = balanceRow.balance_cents - balanceRow.locked_cents;
  if (available < cleanAmount) {
    throw new Error('Insufficient balance for this bid.');
  }

  const latestPending = conn.prepare(`
    SELECT * FROM post_bids
    WHERE post_id = ? AND status = 'pending'
    ORDER BY amount_cents DESC, created_at DESC
    LIMIT 1
  `).get(postId);
  if (latestPending && cleanAmount <= latestPending.amount_cents) {
    throw new Error('Bid must exceed the highest pending bid.');
  }

  const bidId = randomId('bid');
  const lockWindow = new Date(Date.now() + 3000).toISOString();
  conn.prepare(`
    INSERT INTO post_bids (id, post_id, identity_id, bidder_account_id, amount_cents, status, created_at, locked_until, previous_bid_id, source_type)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), ?, ?, 'reader_revert')
  `).run(bidId, post.id, post.identity_id, accountId, cleanAmount, lockWindow, latestPending ? latestPending.id : null);
  conn.prepare("UPDATE balances SET locked_cents = locked_cents + ?, updated_at = datetime('now') WHERE account_id = ?").run(cleanAmount, accountId);
  return conn.prepare('SELECT * FROM post_bids WHERE id = ?').get(bidId);
}

function getVersionHistory(postId) {
  return ensureDatabase().prepare('SELECT * FROM post_versions WHERE post_id = ? ORDER BY created_at ASC').all(postId);
}

function createAuthorEdit(accountId, postId, newBody) {
  const conn = ensureDatabase();
  const post = conn.prepare('SELECT * FROM posts WHERE id = ? AND account_id = ?').get(postId, accountId);
  if (!post) {
    throw new Error('Post not found or you do not own it.');
  }
  const content = String(newBody || '').trim();
  if (!content) {
    throw new Error('Replacement content is required.');
  }
  const previousVersionId = post.selected_version_id || null;
  const versionId = randomId('ver');
  conn.prepare('INSERT INTO post_versions (id, post_id, previous_version_id, kind, content, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(versionId, postId, previousVersionId, 'author_edit', content, accountId);
  const bidId = randomId('bid');
  conn.prepare(`
    INSERT INTO post_bids (id, post_id, identity_id, bidder_account_id, amount_cents, status, created_at, locked_until, target_version_id, source_type)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now', '+3 seconds'), ?, 'author_edit')
  `).run(bidId, postId, post.identity_id, accountId, config.minPostBidCents, versionId);
  return conn.prepare('SELECT * FROM post_bids WHERE id = ?').get(bidId);
}

function createReaderRevert(accountId, postId) {
  const conn = ensureDatabase();
  const post = conn.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) {
    throw new Error('Post not found.');
  }
  const history = getVersionHistory(postId);
  if (history.length < 2) {
    throw new Error('This post has no previous version to revert.');
  }
  const previous = history[history.length - 2];
  const versionId = randomId('ver');
  conn.prepare('INSERT INTO post_versions (id, post_id, previous_version_id, kind, content, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(versionId, postId, previous.id, 'reader_revert', previous.content, accountId);
  const bidId = randomId('bid');
  conn.prepare(`
    INSERT INTO post_bids (id, post_id, identity_id, bidder_account_id, amount_cents, status, created_at, locked_until, target_version_id, source_type)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now', '+3 seconds'), ?, 'reader_revert')
  `).run(bidId, postId, post.identity_id, accountId, config.minPostBidCents, versionId);
  return conn.prepare('SELECT * FROM post_bids WHERE id = ?').get(bidId);
}

module.exports = {
  createPost,
  replyToPost,
  placeBid,
  getLatestSettledValue,
  getVersionHistory,
  createAuthorEdit,
  createReaderRevert,
  getReactionSummary,
  setPostReaction,
  removePostReaction,
  getThreadForPost,
  buildNestedReplies
};
