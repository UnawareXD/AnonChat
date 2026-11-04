const { ensureDatabase } = require('./db');
const { config } = require('./config');

function releaseBidLock(accountId, amountCents) {
  const conn = ensureDatabase();
  const row = conn.prepare('SELECT * FROM balances WHERE account_id = ?').get(accountId);
  if (!row) {
    return;
  }
  conn.prepare("UPDATE balances SET locked_cents = MAX(0, locked_cents - ?), updated_at = datetime('now') WHERE account_id = ?").run(amountCents, accountId);
}

function settlePendingBids() {
  const conn = ensureDatabase();
  const nowIso = new Date().toISOString();
  const pending = conn.prepare(`
    SELECT * FROM post_bids
    WHERE status = 'pending' AND locked_until IS NOT NULL AND datetime(locked_until) <= datetime(?)
    ORDER BY created_at ASC
  `).all(nowIso);

  let settled = 0;
  for (const bid of pending) {
    const newerPending = conn.prepare(`
      SELECT * FROM post_bids
      WHERE post_id = ? AND status = 'pending' AND id != ?
      ORDER BY amount_cents DESC, created_at DESC
      LIMIT 1
    `).get(bid.post_id, bid.id);

    if (newerPending && newerPending.amount_cents >= bid.amount_cents) {
      conn.prepare('UPDATE post_bids SET status = ?, settled_at = ?, locked_until = NULL WHERE id = ?').run('superseded', nowIso, bid.id);
      releaseBidLock(bid.bidder_account_id, bid.amount_cents);
      continue;
    }

    const post = conn.prepare('SELECT * FROM posts WHERE id = ?').get(bid.post_id);
    if (!post) {
      continue;
    }
    conn.prepare('UPDATE post_bids SET status = ?, settled_at = ?, locked_until = NULL WHERE id = ?').run('settled', nowIso, bid.id);
    conn.prepare('UPDATE posts SET current_value_cents = ?, selected_version_id = COALESCE(?, selected_version_id) WHERE id = ?').run(bid.amount_cents, bid.target_version_id, bid.post_id);
    conn.prepare('UPDATE balances SET locked_cents = MAX(0, locked_cents - ?), balance_cents = balance_cents - ? WHERE account_id = ?')
      .run(bid.amount_cents, bid.amount_cents, bid.bidder_account_id);
    conn.prepare('INSERT INTO ledger_entries (id, account_id, entry_type, amount_cents, balance_after_cents, related_entity_type, related_entity_id, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`, bid.bidder_account_id, 'bid_settlement', -bid.amount_cents, 0, 'post_bid', bid.id, 'settled bid');
    settled += 1;
  }

  return settled;
}

module.exports = {
  settlePendingBids,
  releaseBidLock
};
