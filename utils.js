const DHT = require('hyperdht-hugin')
const Keychains = require('keypear');
const sodium = require('sodium-universal');
const { Crypto } = require('kryptokrona-utils')
const crypto = new Crypto()

function get_new_peer_keys(key) {
  const secret = Buffer.alloc(32).fill(key)
  const base_keys = create_peer_base_keys(secret)
  const seed = random_key()
  const dht_keys = create_keys_from_seed(seed)
  const signature = base_keys.get().sign(dht_keys.get().publicKey)
  return [base_keys, dht_keys, signature]
}

function create_peer_base_keys(buf) { 
  const keypair = DHT.keyPair(buf)
  const keys = Keychains.from(keypair) 
  return keys
}

function create_keys_from_seed(seed) {
  const random_key = Buffer.alloc(32).fill(seed)
  return create_peer_base_keys(random_key)
}

function random_key() {
  let key = Buffer.alloc(32);
  sodium.randombytes_buf(key);
  return key.toString('hex');
}

function toHex(str) {
  var result = '';
  for (var i=0; i<str.length; i++) {
    result += str.charCodeAt(i).toString(16);
  }
  return result;
}

function chunk_array(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function hash(text) {
  return await crypto.cn_fast_hash(toHex(text))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parse(data) {
  try{
      return JSON.parse(data)
  }catch(e) {
      return false
  }
}


module.exports={get_new_peer_keys, create_keys_from_seed, hash, parse, sleep, chunk_array}