
const chalk = require('chalk');
const readline = require('readline');
const {Wallet, NodeWallet} = require('./wallet')
const fs = require('fs');
const { HuginNode } = require('./nodes');
const { sleep } = require('./utils');

const HUGIN_VERSION = '1.0.0'

async function start_check() {
  console.log(chalk.green("You are running Hugin Node version", HUGIN_VERSION))
  if (!fs.existsSync('./db')) {
      fs.mkdirSync('./db');

      return init()
  } else {
      return login()
  } 
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


async function start(pub) {
  const node = new HuginNode()
  await node.init(pub)
  //More events here?
  commands(node)
}

async function login(retry = false) {
 
  if (!retry) {
    console.log(huginArt)
    console.log(chalk.white('Welcome back to Hugin Node!'));
  }
  const password = await input_pass(chalk.white('Enter your password:'))

  if (!await Wallet.init(password)) {
    console.log(chalk.red("Error starting your wallet."));
    login(true)
    return
  }

  if(!await NodeWallet.init()) {
    console.log(chalk.red("Error importing node wallet."))
  }
  
  const pub = await public_or_private()
  
  rl.close()
  
  start(pub)
}

async function init() {

  console.log(huginArt)
  console.log(chalk.white('Welcome to the Hugin Node setup wizard!'));
  console.log(chalk.green('Lets get started...'));

  const password = await input_pass(chalk.white('Step 1. Choose a password: '));

  console.log(chalk.white("......................................."))
  console.log(chalk.yellow("**NOTE**"))
  console.log(chalk.yellow("Make sure to remember your password!"))
  console.log(chalk.white("......................................."))

  await sleep(500)
  console.log(chalk.green('Password set successfully!'));


  if (!await Wallet.create(password)) {
      console.log(chalk.red("Error creating your wallet."))
  }

  if (!await NodeWallet.import()) {
      console.log(chalk.red("Error importing node wallet."))
  }
  
  //Create wallet
  console.log(chalk.blue("Loading...."))
  
  await sleep(200)

  const pub = await public_or_private()
  
  
  rl.close()

  console.log(chalk.magenta('🎉 Setup complete! You are ready to go.'));

  start(pub)
}

async function commands(node) {
 
  const com = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  function handle(command) {
    switch (command) {
      case 'stats':
        // More stats?
        console.log(chalk.blue.bold(':::::::::::::::::::::::'))
        console.log(chalk.blue.bold(':::::::::STATS:::::::::'))
        console.log(`${chalk.green('Active clients:')} ${chalk.yellow(node.network.clients.length)}`)
        console.log(`${chalk.green('Nodes:')} ${chalk.yellow(node.network.nodes.length)}`)
        console.log(`${chalk.green('Messages in Pool:')} ${chalk.yellow(node.pool.length)}`)
        console.log(chalk.blue.bold(':::::::::::::::::::::::'))
        console.log(chalk.blue.bold(':::::::::::::::::::::::'))
        //Number of relayed messages?

        break;
  
      case 'info':
        //Do something for info
        console.log('Running hugin node version', HUGIN_VERSION)
        break;
  
      default:
        console.log(`Unknown command: ${command}`)
    }
  }

  com.on('line', (input) => {
    handle(input);
  });
}

const question = 'Is this a public node?'
const pub = 'yes/no'

function public_or_private() {
  return new Promise((resolve, reject) => {

    rl.question(chalk.green(`Step 2. ${question}\n. ${pub}\n`), (answer) => {
      let val
      if (answer === 'Y' || answer === 'y' || answer === 'Yes' || answer === 'yes') {
        val = true
      } else if (answer === 'N' || answer === 'n' || answer === 'No' || answer === 'no') {
        val = false
      } else {
        console.log('Invalid input. Please enter Y or N.')
        return resolve(public_or_private())
      }

      resolve(val)
    });
  });
}

function input_pass(query) {
    return new Promise((resolve) => {

        let password = '';
        let done = false
        rl.input.on('data', (char) => {
          if (done) return
            char = char.toString();
            switch (char) {
                case '\n':
                case '\r':
                    console.log('');
                    resolve(password);
                    done = true
                    break;
                case '\x03':
                    process.exit();
                    break;
                  case '\x03': // Ctrl+C
                    console.log('^C');
                    process.exit();
                    break;
                case '\b': // Backspace (Windows)
                break;
                case '\x7f': // Backspace (Linux/macOS)
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    break;
                default:
                    process.stdout.write('\b \b');
                    process.stdout.write('*');
                    password += char;
                    break;
            }
        });

        rl.question(query, () => {});
    });
}

const huginArt = `
${chalk.white('██╗  ██╗██╗   ██╗ ██████╗ ██╗███╗   ██╗')}
${chalk.white('██║  ██║██║   ██║██╔════╝ ██║████╗  ██║')}
${chalk.white('███████║██║   ██║██║  ███╗██║██╔██╗ ██║')}
${chalk.white('██╔══██║██║   ██║██║   ██║██║██║╚██╗██║')}
${chalk.white('██║  ██║╚██████╔╝╚██████╔╝██║██║ ╚████║')}
${chalk.white('╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝╚═╝  ╚═══╝')}`

start_check()