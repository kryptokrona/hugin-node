const { Address, KeyPair } = require('kryptokrona-utils');
const fs = require('fs');

const CONFIG_PATH = './config.json';
const ADDRESS_LENGTH = 99;
const DEFAULT_CONFIG = {
  payoutAddress: '',
  private: false,
  nodeId: '',
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      writeConfig({ ...DEFAULT_CONFIG });
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
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
    let changed = false;

    if (isNonEmptyString(config.nodeId)) {
      const raw = String(config.nodeId).trim();
      if (raw.length >= ADDRESS_LENGTH) {
        this.address = raw.slice(0, ADDRESS_LENGTH);
        this.viewkey = raw.slice(ADDRESS_LENGTH);
      }
    }

    if (!this.address || !this.viewkey) {
      const spend = await KeyPair.from();
      const view = await KeyPair.from();
      const addr = await Address.fromPublicKeys(spend.publicKey, view.publicKey);
      const address = await addr.address();

      this.address = address;
      this.viewkey = view.privateKey;
      config.nodeId = `${this.address}${this.viewkey}`;
      changed = true;
    }

    if (!isNonEmptyString(config.payoutAddress)) {
      config.payoutAddress = this.address;
      changed = true;
    }

    if (changed) {
      writeConfig(config);
    }

    return true;
  }
}

const NodeId = new NodeIdentity();

module.exports = { NodeId };
