
// LIMITS

const DAY_LIMIT = 100
const ONE_DAY = 24 * 60 * 60 * 1000;

// ERRORS

const WRONG_MESSAGE_FORMAT = {success: false, reason: 'Wrong message format.'}
const SIGNATURE_ERROR = {success: false, reason: 'Signature error.'}
const NOT_VERIFIED = {success: false, reason: 'Not verified.'}
const LIMIT_REACHED = {success: false, reason: 'Limit reached.'}
const MESSAGE_VERIFIED = {success: true, reason: ''}

// VERSIONS

const NODE_VERSION = '1.0.4'

module.exports={ONE_DAY, DAY_LIMIT, WRONG_MESSAGE_FORMAT, SIGNATURE_ERROR, NOT_VERIFIED, LIMIT_REACHED, MESSAGE_VERIFIED, NODE_VERSION}