
const HyperDB = require('hyperdb')
const def = require('./spec/hyperdb/index.js');
const { DAY_LIMIT, ONE_DAY } = require('./constants.js');

const db = HyperDB.rocks('./db/messages.db', def)
/**
 * Verify limit of this sender.
 * @param {string} pubKey - The public key of the sender.
 * @returns {Promise<boolean>}
 */

async function limit(pubKey) {
  const endTime = Date.now()
  const startTime = endTime - ONE_DAY;

  const queryStream = db.find('@messages/messages', {
    eq: { pub: pubKey },
    gte: { timestamp: startTime }, 
    lt: { timestamp: endTime }
  })

  const messages = await queryStream.toArray()
  return messages.length > DAY_LIMIT
}

/**
 * Add a new message to the database.
 * @param {string} message - The message object.
 * @returns {Promise<void>}
 */
async function save(message) {
  const cipher = message.cipher
  const timestamp = message.timestamp
  const hash = message.hash
  const pub = message.pub
  const signature = message.signature

  await db.insert('@messages/messages', {
    cipher,
    timestamp,
    pub,
    hash,
    signature
  });

  await db.flush();
}

/**
 * Delete a message from the database.
 * @param {number} timestamp - The timestamp of the message to delete.
 * @returns {Promise<void>}
 */
async function remove(timestamp) {
  await db.delete('@messages/messages', { timestamp });
  await db.flush();
  console.log('Message deleted with timestamp:', timestamp);
}

/**
 * Load all messages from the database.
 * @returns {Promise<Array>} - List of all messages.
 */
async function load() {
  await delete_old()
  const queryStream = db.find('@messages/messages', {});
  const messages = await queryStream.toArray();
  console.log('Loaded messages:', messages.length);
  const pool = new Map();
  for (const message of messages) {
    pool.set(message.hash, message);
  }

  return pool
}


/**
 * Deletes all older messages from the database.
 * @returns {Promise<void>}
 */
async function delete_old() {
  const older = Date.now() - ONE_DAY;
  const stream = db.find('@messages/messages', { lt: { timestamp: older } });
  const old = await stream.toArray();

  for (const msg of old) {
    await db.delete('@messages/messages', { timestamp: msg.timestamp });
  }

  await db.flush();
}


module.exports={load, remove, save, limit}