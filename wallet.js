
const WB = require('kryptokrona-wallet-backend-js');
const { Address, CryptoNote } = require('kryptokrona-utils');
const xkrUtils = new CryptoNote();
const fs = require('fs');
const chalk = require('chalk');

class ViewWallet {
  constructor() {
    this.address = "SEKReVsk6By22AuCcRnQGkSjY6r4AxuXxSV9ygAXwnWxGAhSPinP7AsYUdqPNKmsPg2M73FiA19JT3oy31WDZq1jBkfy3kxEMNM"
    this.viewkey = "cd196c0f8a36e951b399681d447922f6c54c28c6ef3cad1c65d356c33657ab0b"
    this.wallet = null
    this.txs = [],
    this.daemon = new WB.Daemon('node.xkr.network', 443);// TODO ** set custom node.
  }

async init(password) {
  if (!(await this.load(password))) return false;
  return true;
}

async import(password) {
  const [wallet, err] = await WB.WalletBackend.importViewWallet(this.daemon, 2055000, this.viewkey, this.address);
  if (err) {
    console.log('Failed to load wallet: ' + err.toString());
    return false
  
  }
  this.wallet = wallet
  save(password, 'nodewallet', wallet)
  this.start()
  return true
}

  async loadtxs() {
    if (!this.wallet) return
    this.txs = []
    for (const tx of await this.wallet.getTransactions()) {
      console.log(`Transaction ${tx.hash} - ${WB.prettyPrintAmount(tx.totalAmount())} - ${tx.timestamp}`);
      console.log("Whole tx:", tx)
      this.txs.push(tx)
    }
  }

  async verify(pub) {
    return this.txs.some(a => a.paymentID === pub && a.totalAmount() >= 9900000)
  }


  async start() {
    this.wallet.enableAutoOptimization(false);
    this.wallet.scanPoolTransactions(false);
    await this.wallet.start()
    this.wallet.on('incomingtx', async (transaction) => {
      console.log('Incoming tx!', transaction);
      this.txs.push(transaction)
    });
    await this.loadtxs()
    console.log("Loaded txs:", this.txs.length)
    return true
  }


  async load(password) {
    const wallet = await open(password, 'nodewallet', this.daemon)
    if (!open) return false
    this.wallet = wallet
    await this.start()
    return true
  }

}

//Todo ** Add relay of tx's ?
  // sendPreparedTx()

class UserWallet {
  constructor() {
    this.wallet = null;
    this.loaded = false;
    this.address = null;
    this.started = false;
    this.daemon = new WB.Daemon('node.xkr.network', 443);// TODO ** set custom node.
  }

  async init(password) {
    if (!(await this.load(password))) return false;
    this.loaded = true;
    return true;
  }

  async create(password) {
    this.wallet = await WB.WalletBackend.createWallet(this.daemon);
    this.address = this.addresses()[0];
    this.loaded = true;
    return await this.start(password)
  }

  async load(password) {
    console.log('Starting wallet...');
    const loadedWallet = await open(password, 'mywallet', this.daemon)

    if (!loadedWallet) {
      console.log('Error loading wallet');
      return false;
    }

    this.wallet = loadedWallet;
    this.address = this.addresses()[0];

    await this.start(password);
    return true;
  }

  addresses() {
    return this.wallet.getAddresses();
  }
  spendKey() {
    return this.wallet.getPrimaryAddressPrivateKeys()[0];
  }

  privateKeys() {
    return this.wallet.getPrimaryAddressPrivateKeys();
  }

  async sign(message) {
    return await xkrUtils.signMessage(message, this.spendKey());
  }

  async verify(message, address, signature) {
    try {
      const verify = await xkrUtils.verifyMessageSignature(
        message,
        address,
        signature,
      );
      return verify;
    } catch (e) {
      return false;
    }
  }

  async start(password) {
    this.wallet.enableAutoOptimization(false);
    this.wallet.scanPoolTransactions(false);

    await this.wallet.start();
    this.started = true;
    
    save(password, 'mywallet', this.wallet);
    setInterval( async () => save(password, 'mywallet', this.wallet), 200000);
    //Incoming transaction event
    this.wallet.on('incomingtx', async (transaction) => {
      console.log('Incoming tx!');
      console.log(chalk.green("$ Your node got paid $"))
    });
    return true
  }
  
  }

  async function open(password, wallet, daemon){
    const file = await readfile(wallet)
    const [js_wallet, error] = await WB.WalletBackend.openWalletFromEncryptedString(
        daemon,
        file,
        password
    )
    if (error) {
        console.log('Failed to open wallet: ' + error.toString())
        return false
    }
    return js_wallet
  }



 function save(password, walletname, wallet) {
    const save = wallet.encryptWalletToString(password)
    try {
      fs.writeFileSync('./' + walletname + '.json', save)
    //Write file
    } catch(e) {
      return false
    }
}

  async function readfile(wallet) {
    try {
      const data = fs.readFileSync('./' + wallet + '.json')
      return data.toString()
    } catch (err) {
      console.log('Json wallet error, try backup wallet file', err)
      return false
  }
  }


  const Wallet = new UserWallet()
  const NodeWallet = new ViewWallet()

  module.exports={NodeWallet, Wallet}