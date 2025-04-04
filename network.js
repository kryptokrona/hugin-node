const EventEmitter = require('bare-events')
const Hyperswarm = require('hyperswarm-hugin')
const { create_keys_from_seed, get_new_peer_keys, parse } = require('./utils')
const chalk = require('chalk');
const { Wallet } = require('./wallet');

class Network extends EventEmitter {
  constructor(seed) {
    super()
    this.keys = create_keys_from_seed(seed) //Seed from private xkr wallet. Static
    this.nodes = []
    this.clients = []
  }

async swarm(key, server = false) {
  let [base_keys, dhtKeys, sig] = get_new_peer_keys(key)
  const topicHash = base_keys.publicKey.toString('hex')
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

//Server handles clients

async server(key) {
  console.log(chalk.green("Node started ✅"))
  console.log("")
  console.log(chalk.cyan("...................."))
  console.log('NODE PUBLIC ADDRESS:');
  console.log(chalk.cyan("...................."))
  console.log("")
  console.log(chalk.white(Wallet.address + this.keys.publicKey.toString('hex')))
  console.log("")
  return await this.swarm(key, true)

}



node_connection(conn, info) {
  console.log(chalk.green("New node connection"))
  this.nodes.push({conn, info})
  conn.on('data', (d) => {
    const m = d.toString()
    const data = parse(m)
    if (!data) return
    this.emit('node-data', {conn, info, data})
  })
  conn.on('error',() => {
    console.log("Got error connection signal")
    conn.end()
    conn.destroy()
  })
}

async client_connection(conn, info) {
  console.log(chalk.green("Incoming client connection"))
  this.clients.push({conn, info})
  conn.on('data', (d) => {
    if (d.length > 5000) return
    const m = d.toString()
    const data = parse(m)
    if (!data) return
    this.emit('client-data', {conn, info, data})
  })
  conn.on('error',() => {
    conn.end()
    conn.destroy()
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

}

module.exports={Network}