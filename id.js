const { Address, KeyPair } = require('kryptokrona-utils');
const fs = require('fs');

const CONFIG_PATH = './config.json';
const ADDRESS_LENGTH = 99;

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeConfig(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

class NodeIdentity {
  constructor() {
    this.address = null;
    this.viewkey = null;
  }

  async init() {
    const config = readConfig();

    if (config.nodeId) {
      const raw = String(config.nodeId);
      if (raw.length >= ADDRESS_LENGTH) {
        this.address = raw.slice(0, ADDRESS_LENGTH);
        this.viewkey = raw.slice(ADDRESS_LENGTH);
        return true;
      }
    }

    const spend = await KeyPair.from();
    const view = await KeyPair.from();
    const addr = await Address.fromPublicKeys(spend.publicKey, view.publicKey);
    const address = await addr.address();

    this.address = address;
    this.viewkey = view.privateKey;

    writeConfig({
      ...config,
      nodeId: `${this.address}${this.viewkey}`,
    });

    return true;
  }
}

const NodeId = new NodeIdentity();

module.exports = { NodeId };
