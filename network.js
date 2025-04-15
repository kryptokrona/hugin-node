const EventEmitter = require('bare-events')
const Hyperswarm = require('hyperswarm-hugin')
const { create_keys_from_seed, get_new_peer_keys, parse } = require('./utils')
const chalk = require('chalk');
const { Wallet } = require('./wallet');
const { NODE_VERSION } = require('./constants');

class Network extends EventEmitter {
  constructor(seed) {
    super()
    this.keys = create_keys_from_seed(seed) //Deterministic dht keys.
    this.nodes = []
    this.clients = []
  }

async swarm(key, priv = false, pub = false) {
  let [base_keys, dhtKeys, sig] = get_new_peer_keys(key)
  const topicHash = base_keys.publicKey.toString('hex')
  const server = priv || pub
  const dht_keys = server ? this.keys : dhtKeys
  if (server) {
    sig =  base_keys.get().sign(dht_keys.get().publicKey)
  }
  let swarm
  try {
     swarm = new Hyperswarm({}, sig, dht_keys, base_keys)
  } catch (e) {
    console.log('Error starting swarm', e)
    return [false, false]
  }


  swarm.on('connection', (conn, info) => {
      if (server) this.client_connection(conn, info)
      else this.node_connection(conn, info)
  })

  process.once('SIGINT', function () {
      swarm.on('close', function () {
          process.exit();
      });
      swarm.destroy();
      setTimeout(() => process.exit(), 2000);
  });

  const topic = Buffer.alloc(32).fill(topicHash)
  const discovery = swarm.join(topic, {server: true, client: server ? false : true})
  await discovery.flushed()
}

// Node is connected to other nodes. 

async node (key) {
  console.log(chalk.green("Network started ✅"))
  return await this.swarm(key, false)

}

//Private node handles invited clients. Address is private.
async private_node(key) {
  console.log(chalk.green("Private node started ✅"))
  console.log("")
  console.log(chalk.cyan("...................."))
  console.log('NODE PRIVATE ADDRESS:');
  console.log(chalk.cyan("...................."))
  console.log("")
  console.log(chalk.white(Wallet.address + this.keys.publicKey.toString('hex')))
  console.log("")
  return await this.swarm(key, true, false)
}


//Public node handles clients. Address is public.
async public_node(key) {
  console.log("")
  console.log(chalk.cyan("...................."))
  console.log(chalk.green("Public node started ✅"))
  console.log(chalk.cyan("...................."))
  console.log('NODE PUBLIC ADDRESS:');
  console.log(chalk.cyan("...................."))
  console.log("")
  console.log(chalk.white(Wallet.address + this.keys.publicKey.toString('hex')))
  console.log("")
  console.log("")
  return await this.swarm(key, false, true)
}

node_connection(conn, info) {
  console.log(chalk.green("New node connection"))
  this.nodes.push({conn, info})

  // Send node version to other nodes
  conn.write(JSON.stringify({version: NODE_VERSION}))
  conn.on('data', (d) => {
    const m = d.toString()
    const data = parse(m)
    if (!data) {
      this.ban(info, conn)
      return
    }
    this.emit('node-data', {conn, info, data})
  })
  conn.on('error',() => {
    console.log("Got error connection signal")
    conn.end()
    conn.destroy()
    this.nodes = this.nodes.filter(a => a.info !== info)
  })
}

async client_connection(conn, info) {
  console.log(chalk.green("Incoming client connection"))
  this.clients.push({conn, info})
  //Send our node wallet address to client.
  conn.write(JSON.stringify({address: Wallet.address, version: NODE_VERSION}))

  conn.on('data', (d) => {
    if (d.length > 5000) {
        this.ban(info, conn)
        return
    }
    const m = d.toString()
    const data = parse(m)
    if (!data) {
      this.ban(info, conn)
      return
    }
    this.emit('client-data', {conn, info, data})
  })
  conn.on('error',() => {
    conn.end()
    conn.destroy()
    this.clients = this.clients.filter(a => a.info !== info)
  })
}

//Notify other nodes of incoming client message
signal(message) {
  for (const n of this.nodes) {
    n.conn.write(JSON.stringify({signal: true, message}))
  }
}


ban(info, conn) {
  info.ban(true)
  conn.end()
  conn.destroy()
}

timeout(info, conn) {
  this.ban(info, conn)
  setTimeout(() => info.ban(false), 60000)
}

}

module.exports={Network}