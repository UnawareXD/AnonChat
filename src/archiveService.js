const { ensureDatabase } = require('./db');

function getArchiveForAccount(accountId) {
  const conn = ensureDatabase();
  const identities = conn.prepare('SELECT * FROM identities WHERE account_id = ? ORDER BY created_at ASC').all(accountId);
  const results = identities.map((identity) => {
    const topLevelPosts = conn.prepare('SELECT * FROM posts WHERE identity_id = ? AND parent_post_id IS NULL ORDER BY created_at ASC').all(identity.id);
    const posts = topLevelPosts.map((post) => ({
      ...post,
      replies: conn.prepare('SELECT * FROM posts WHERE identity_id = ? AND parent_post_id = ? ORDER BY created_at ASC').all(identity.id, post.id).map((reply) => ({
        id: reply.id,
        body: reply.body,
        current_value_cents: Number(reply.current_value_cents || 0),
        created_at: reply.created_at,
        identity_id: reply.identity_id,
        parent_post_id: reply.parent_post_id
      }))
    }));
    const values = posts.flatMap((post) => [Number(post.current_value_cents || 0), ...post.replies.map((reply) => Number(reply.current_value_cents || 0))]);
    const total = values.reduce((s, v) => s + v, 0);
    return {
      ...identity,
      read_only: identity.active === 0 || identity.custom_permanent === 1,
      posts: posts.map((post) => ({
        id: post.id,
        body: post.body,
        current_value_cents: Number(post.current_value_cents || 0),
        created_at: post.created_at,
        replies: post.replies
      })),
      aggregate_value_cents: total
    };
  });

  return { account_id: accountId, identities: results };
}

module.exports = {
  getArchiveForAccount
};
