
const chalk = require('chalk');
const readline = require('readline');
const { Address } = require('kryptokrona-utils');
const { NodeId } = require('./id')
const fs = require('fs');
const { HuginNode } = require('./nodes');
const { sleep } = require('./utils');
const { NODE_VERSION } = require('./constants');

const CONFIG_PATH = './config.json'

const DEFAULT_CONFIG = {
  payoutAddress: '',
  private: false,
  nodeId: ''
}
const ADDRESS_LENGTH = 99;

function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return false
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
  return true
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function save_config(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2))
}

async function is_valid_payout_address(address) {
  if (typeof address !== 'string') return false
  const value = address.trim()
  if (value.length !== ADDRESS_LENGTH) return false
  try {
    await Address.fromAddress(value)
    return true
  } catch (e) {
    return false
  }
}

async function prompt_for_payout_address() {
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const question = (prompt) => new Promise((resolve) => input.question(prompt, resolve))
  while (true) {
    const value = await question(chalk.yellow('Enter payoutAddress: '))
    const payoutAddress = String(value || '').trim()

    if (!payoutAddress) {
      console.log(chalk.red('payoutAddress cannot be empty. Please try again.'))
      continue
    }

    if (payoutAddress.length !== ADDRESS_LENGTH) {
      console.log(chalk.red(`payoutAddress must be exactly ${ADDRESS_LENGTH} characters.`))
      continue
    }

    if (!await is_valid_payout_address(payoutAddress)) {
      console.log(chalk.red('Invalid payoutAddress. Please enter a valid SEKR address.'))
      continue
    }

    input.close()
    return payoutAddress
  }
}

async function ensure_payout_address() {
  const config = loadConfig()
  const payoutAddress = String(config.payoutAddress || '').trim()
  if (await is_valid_payout_address(payoutAddress)) return

  console.log(chalk.yellow('No valid payoutAddress found in config.'))
  const enteredAddress = await prompt_for_payout_address()
  save_config({
    ...config,
    payoutAddress: enteredAddress
  })
  console.log(chalk.green('Saved payoutAddress to config.json.'))
}

async function start_check() {
  console.log(chalk.green("You are running Hugin Node version", NODE_VERSION))
  if (!fs.existsSync('./db')) {
      fs.mkdirSync('./db');
  }
  const created = ensureConfigExists()
  if (created) {
    console.log(chalk.yellow('Created `config.json`.'))
  }
  await ensure_payout_address()
  return start_node();
}


async function start(pub) {
  const config = loadConfig();
  const node = new HuginNode({
    payoutAddress: config.payoutAddress || ''
  })
  await node.init(pub)
  //More events here?
  commands(node)
}

async function start_node() {
  console.log(huginArt)
  console.log(chalk.white('Starting Hugin Node...'));

  if(!await NodeId.init()) {
    console.log(chalk.red("Error importing node wallet."))
  }
  const config = loadConfig();
  if (!NodeId.address && config.nodeId) {
    NodeId.address = String(config.nodeId).slice(0, 99);
  }

  const pub = !(config.private === true);

  start(pub);
}

async function commands(node) {
 
  const com = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  async function handle(command) {
    switch (command) {
      
      case 'stats':
        SHOW_STATS(node)
        break;
  
      case 'info':
        SHOW_INFO(node)
        break;

      default:
        console.log(`Unknown command: ${command}`)
    }
  }

  com.on('line', (input) => {
    handle(input);
  });
}


const huginArt = `
${chalk.white('██╗  ██╗██╗   ██╗ ██████╗ ██╗███╗   ██╗')}
${chalk.white('██║  ██║██║   ██║██╔════╝ ██║████╗  ██║')}
${chalk.white('███████║██║   ██║██║  ███╗██║██╔██╗ ██║')}
${chalk.white('██╔══██║██║   ██║██║   ██║██║██║╚██╗██║')}
${chalk.white('██║  ██║╚██████╔╝╚██████╔╝██║██║ ╚████║')}
${chalk.white('╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝╚═╝  ╚═══╝')}`


const SHOW_INFO = (node) => {
  console.log(chalk.blue.bold('::::::::::::::::::::::'))
  console.log(chalk.blue.bold(':::::::::INFO:::::::::'))
  console.log('Running hugin node version', NODE_VERSION)
  console.log(chalk.blue.bold('............'))
  console.log(chalk.green('Node address:'))
  const config = loadConfig();
  const nodeAddress = NodeId.address || config.nodeAddress || '';
  console.log(nodeAddress + node.network.keys.publicKey.toString('hex'))
  console.log(chalk.blue.bold('............'))
  console.log(chalk.green('Payout address:'))
  console.log(config.payoutAddress || 'n/a')
  console.log(chalk.blue.bold('............'))
  console.log(chalk.green('Auto payments:'))
  console.log('n/a')
  console.log(chalk.blue.bold('::::::::::::::::::::::'))
  console.log(chalk.blue.bold('::::::::::::::::::::::'))
}

const SHOW_STATS = async (node) => {
   // More stats?
   console.log(chalk.blue.bold(':::::::::::::::::::::::'))
   console.log(chalk.blue.bold(':::::::::STATS:::::::::'))
   console.log(`${chalk.green('Active clients:')} ${chalk.yellow(node.network.clients.length)}`)
   console.log(`${chalk.green('Nodes:')} ${chalk.yellow(node.network.nodes.length)}`)
   console.log(`${chalk.green('Messages in Pool:')} ${chalk.yellow(node.pool.size)}`)
   console.log(chalk.blue.bold(':::::::::::::::::::::::'))
   console.log(chalk.blue.bold(':::::::::::::::::::::::'))
   //Number of relayed messages?
}

process.on('uncaughtException', (err) => {
  console.log('Caught an unhandled exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

start_check()