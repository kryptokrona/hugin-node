
const chalk = require('chalk');
const readline = require('readline');
const { NodeId } = require('./id')
const fs = require('fs');
const { HuginNode } = require('./nodes');
const { sleep } = require('./utils');
const { NODE_VERSION } = require('./constants');

function loadConfig() {
  try {
    const raw = fs.readFileSync('./config.json', 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

async function start_check() {
  console.log(chalk.green("You are running Hugin Node version", NODE_VERSION))
  if (!fs.existsSync('./db')) {
      fs.mkdirSync('./db');
  }
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

start_check()