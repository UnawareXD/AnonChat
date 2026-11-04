const { randomUUID } = require('crypto');
const { config } = require('./config');
const { ensureDatabase } = require('./db');
const { getActiveIdentityForAccount, getIdentityForAccount, findOrCreateRandomIdentity } = require('./identityService');

function randomId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function getIdentityValue(identityId) {
  const conn = ensureDatabase();
  const rows = conn.prepare('SELECT current_value_cents FROM posts WHERE identity_id = ?').all(identityId);
  const total = rows.reduce((sum, row) => sum + Number(row.current_value_cents || 0), 0);
  return total > 0 ? total : config.minPostBidCents;
}

function createOffer(buyerAccountId, identityId) {
  const conn = ensureDatabase();
  const identity = conn.prepare('SELECT * FROM identities WHERE id = ?').get(identityId);
  if (!identity) {
    throw new Error('Identity not found.');
  }
  if (identity.custom_permanent) {
    throw new Error('Permanent custom identities are not eligible for sale.');
  }
  if (identity.kind !== 'random' || identity.active !== 1) {
    throw new Error('Only active random identities can be listed for sale.');
  }
  const existing = conn.prepare('SELECT * FROM identity_marketplace_offers WHERE identity_id = ? AND status = ?').get(identityId, 'pending');
  if (existing) {
    throw new Error('There is already a pending offer for this identity.');
  }

  const value = getIdentityValue(identityId);
  const fee = Math.round((value * config.platformFeePercent) / 100);
  const price = value + fee;
  const offerId = randomId('offer');
  conn.prepare(`
    INSERT INTO identity_marketplace_offers (id, identity_id, buyer_account_id, seller_account_id, offer_value_cents, fee_cents, price_cents, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now', '+1 day'))
  `).run(offerId, identityId, buyerAccountId, identity.account_id, value, fee, price);

  return conn.prepare('SELECT * FROM identity_marketplace_offers WHERE id = ?').get(offerId);
}

function acceptOffer(sellerAccountId, offerId) {
  const conn = ensureDatabase();
  const offer = conn.prepare('SELECT * FROM identity_marketplace_offers WHERE id = ?').get(offerId);
  if (!offer) {
    throw new Error('Offer not found.');
  }
  if (offer.seller_account_id !== sellerAccountId) {
    throw new Error('Only the current owner can accept this offer.');
  }
  if (offer.status !== 'pending') {
    throw new Error('This offer is no longer pending.');
  }
  if (offer.expires_at && new Date(offer.expires_at).getTime() <= Date.now()) {
    conn.prepare('UPDATE identity_marketplace_offers SET status = ? WHERE id = ?').run('expired', offerId);
    throw new Error('This offer expired before it was accepted.');
  }

  const identity = conn.prepare('SELECT * FROM identities WHERE id = ?').get(offer.identity_id);
  if (!identity || identity.custom_permanent || identity.kind !== 'random') {
    conn.prepare('UPDATE identity_marketplace_offers SET status = ? WHERE id = ?').run('declined', offerId);
    throw new Error('This identity is no longer eligible for transfer.');
  }

  conn.exec('BEGIN IMMEDIATE');
  try {
    const buyer = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(offer.buyer_account_id);
    const seller = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(offer.seller_account_id);
    if (!buyer || !seller) {
      throw new Error('The buyer or seller account is missing.');
    }
    if (offer.buyer_account_id === offer.seller_account_id) {
      throw new Error('You cannot buy your own identity.');
    }

    const replacementIdentity = getActiveIdentityForAccount(sellerAccountId);
    if (replacementIdentity && replacementIdentity.id === offer.identity_id) {
      const nextIdentity = findOrCreateRandomIdentity(sellerAccountId, { force: true });
      conn.prepare('UPDATE accounts SET current_identity_id = ? WHERE id = ?').run(nextIdentity.id, sellerAccountId);
    }

    conn.prepare("UPDATE identity_marketplace_offers SET status = ?, accepted_at = datetime('now'), transferred_at = datetime('now') WHERE id = ?").run('accepted', offerId);
    conn.prepare("INSERT INTO marketplace_transactions (id, offer_id, identity_id, buyer_account_id, seller_account_id, price_cents, fee_cents, seller_paid_cents, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
      .run(randomId('tx'), offerId, offer.identity_id, offer.buyer_account_id, offer.seller_account_id, offer.price_cents, offer.fee_cents, offer.price_cents - offer.fee_cents, 'completed');
    conn.exec('COMMIT');

    return conn.prepare('SELECT * FROM identity_marketplace_offers WHERE id = ?').get(offerId);
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

function declineOffer(sellerAccountId, offerId) {
  const conn = ensureDatabase();
  const offer = conn.prepare('SELECT * FROM identity_marketplace_offers WHERE id = ?').get(offerId);
  if (!offer) {
    throw new Error('Offer not found.');
  }
  if (offer.seller_account_id !== sellerAccountId) {
    throw new Error('Only the current owner can decline this offer.');
  }
  conn.prepare('UPDATE identity_marketplace_offers SET status = ? WHERE id = ?').run('declined', offerId);
  return conn.prepare('SELECT * FROM identity_marketplace_offers WHERE id = ?').get(offerId);
}

function expireOffers() {
  const conn = ensureDatabase();
  const expired = conn.prepare(`
    SELECT * FROM identity_marketplace_offers WHERE status = 'pending' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
  `).all();
  for (const offer of expired) {
    conn.prepare('UPDATE identity_marketplace_offers SET status = ? WHERE id = ?').run('expired', offer.id);
  }
  return expired;
}

function getMarketplaceSummary() {
  const conn = ensureDatabase();
  const rows = conn.prepare("SELECT SUM(price_cents) AS total, SUM(fee_cents) AS fees FROM identity_marketplace_offers WHERE status IN (?, ?)").get('accepted', 'transferred');
  return {
    totalValueCents: Number(rows?.total || 0),
    totalFeesCents: Number(rows?.fees || 0),
    count: conn.prepare('SELECT COUNT(*) AS count FROM identity_marketplace_offers').get().count
  };
}

module.exports = {
  createOffer,
  acceptOffer,
  declineOffer,
  expireOffers,
  getMarketplaceSummary,
  getIdentityValue
};
