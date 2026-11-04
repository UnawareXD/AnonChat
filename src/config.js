const dotenv = require('dotenv');

dotenv.config();

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  appEnv: process.env.APP_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'anonchat-dev-secret',
  dbPath: process.env.DB_PATH || './data/anonchat.db',
  smsProvider: process.env.SMS_PROVIDER || 'dev',
  platformFeePercent: Number(process.env.PLATFORM_FEE_PERCENT || 5),
  customIdentityPriceCents: Number(process.env.DEFAULT_CUSTOM_IDENTITY_PRICE_CENTS || 15000),
  minPostBidCents: Number(process.env.MIN_POST_BID_CENTS || 50),
  minBidIncrementCents: Number(process.env.MIN_BID_INCREMENT_CENTS || 50),
  identityRotationMinMinutes: Number(process.env.IDENTITY_ROTATION_MIN_MINUTES || 30),
  identityRotationMaxMinutes: Number(process.env.IDENTITY_ROTATION_MAX_MINUTES || 240),
  defaultBalanceCents: Number(process.env.DEFAULT_BALANCE_CENTS || 1000000)
};

module.exports = { config };
