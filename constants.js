
// LIMITS

const DAY_LIMIT = 100
const ONE_DAY = 24 * 60 * 60 * 1000;

// ERRORS

const WRONG_MESSAGE_FORMAT = {success: false, reason: 'Wrong message format.'}
const SIGNATURE_ERROR = {success: false, reason: 'Signature error.'}
const NOT_VERIFIED = {success: false, reason: 'Not verified.'}
const LIMIT_REACHED = {success: false, reason: 'Limit reached.'}
const MESSAGE_VERIFIED = {success: true, reason: ''}
const POW_INVALID = {success: false, reason: 'Invalid PoW shares.'}

// VERSIONS

const NODE_VERSION = '2.0.0'

// CONFIG (edit these constants to configure node behavior)
const POW_DEBUG = true

// Pool / PoW defaults
const DEFAULT_POOL_PORT = 3333
const DEFAULT_POOL_SSL = false
const POOL_ALGO = 'cn_pico'
const POOL_VARIANT = 0
const POOL_BLOBTYPE = 0
const POOL_INCLUDE_HEIGHT = false
const POOL_HASHING_UTIL = false

// Bind PoW nonces to message hash to prevent replay across messages.
// Lower bits => less CPU overhead, less replay resistance. Tune as needed.
const NONCE_TAG_BITS = 4

// PoW protocol versioning (relay only current version)
const POW_VERSION = 2

// Safety limits
const MAX_SHARES_PER_MESSAGE = 5
const MAX_MESSAGE_PAST_MS = 60 * 60 * 1000
const MAX_MESSAGE_FUTURE_MS = 5 * 60 * 1000

// Network framing / anti-DoS
const MAX_NODE_INBOUND_BYTES = 100000
const MAX_CLIENT_INBOUND_BYTES = 100000
const MAX_SYNC_MESSAGES = 1000
const MAX_JOB_BLOB_HEX_BYTES = 1024
const CLIENT_POST_COOLDOWN_MS = 1000
const CLIENT_JOB_REQUEST_MAX_PER_10S = 30
const CLIENT_POW_TAG_MAX_PER_10S = 30
const GLOBAL_JOB_REQUEST_MAX_PER_10S = 500
const GLOBAL_POW_TAG_MAX_PER_10S = 500
const REQUEST_RATE_WINDOW_MS = 10000
const CLIENT_REQUEST_SPAM_STRIKES = 3

module.exports={
  ONE_DAY,
  DAY_LIMIT,
  WRONG_MESSAGE_FORMAT,
  SIGNATURE_ERROR,
  NOT_VERIFIED,
  LIMIT_REACHED,
  MESSAGE_VERIFIED,
  POW_INVALID,
  NODE_VERSION,
  POW_DEBUG,
  DEFAULT_POOL_PORT,
  DEFAULT_POOL_SSL,
  POOL_ALGO,
  POOL_VARIANT,
  POOL_BLOBTYPE,
  POOL_INCLUDE_HEIGHT,
  POOL_HASHING_UTIL,
  NONCE_TAG_BITS,
  POW_VERSION,
  MAX_SHARES_PER_MESSAGE,
  MAX_MESSAGE_PAST_MS,
  MAX_MESSAGE_FUTURE_MS,
  MAX_NODE_INBOUND_BYTES,
  MAX_CLIENT_INBOUND_BYTES,
  MAX_SYNC_MESSAGES,
  MAX_JOB_BLOB_HEX_BYTES,
  CLIENT_POST_COOLDOWN_MS,
  CLIENT_JOB_REQUEST_MAX_PER_10S,
  CLIENT_POW_TAG_MAX_PER_10S,
  GLOBAL_JOB_REQUEST_MAX_PER_10S,
  GLOBAL_POW_TAG_MAX_PER_10S,
  REQUEST_RATE_WINDOW_MS,
  CLIENT_REQUEST_SPAM_STRIKES
}