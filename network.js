const EventEmitter = require('bare-events')
const Hyperswarm = require('hyperswarm-hugin')
const { create_keys_from_seed, get_new_peer_keys, parse, sleep } = require('./utils')
const chalk = require('chalk');
const { NodeId } = require('./id');
const { NODE_VERSION, MAX_NODE_INBOUND_BYTES, MAX_CLIENT_INBOUND_BYTES } = require('./constants');

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
  if (!server) this.refresh(discovery)
}

// Node is connected to other nodes.

async node (key) {
  console.log(chalk.green("Network started ✅", key))
  return await this.swarm(key, false)

}

//Private node handles invited clients. Address is private.
async private_node(key) {
  console.log(chalk.green("Private node started ✅"))
  console.log("")
  console.log(chalk.cyan("...................."))
  console.log('NODE ADDRESS:');
  console.log(chalk.cyan("...................."))
  console.log("")
  console.log(chalk.white(NodeId.address + this.keys.publicKey.toString('hex')))
  console.log("")
  return await this.swarm(key, true, false)
}


//Public node handles clients. Address is public.
async public_node(key) {
  console.log("")
  console.log(chalk.cyan("...................."))
  console.log(chalk.green("Public node started ✅"))
  console.log(chalk.cyan("...................."))
  return await this.swarm(key, false, true)
}

node_connection(conn, info) {
  console.log(chalk.green("New node connection"))
  this.nodes.push({conn, info})

  // Send node version to other nodes
  conn.write(JSON.stringify({version: NODE_VERSION}))
  conn.on('data', (d) => {
    if (d.length > MAX_NODE_INBOUND_BYTES) {
      this.ban(info, conn)
      return
    }
    const m = d.toString()
    const data = parse(m)
    if (!data) {
      this.ban(info, conn)
      return
    }
    this.emit('node-data', {conn, info, data})
  })
  conn.on('error',() => {
    conn.end()
    conn.destroy()
    this.nodes = this.nodes.filter(a => a.info !== info)
  })
  conn.on('close',() => {
    this.nodes = this.nodes.filter(a => a.info !== info)
  })
}

async client_connection(conn, info) {
  console.log(chalk.green("Incoming client connection"))
  this.clients.push({conn, info})
  //Send our node wallet address to client.
  conn.write(JSON.stringify({address: NodeId.address, version: NODE_VERSION}))

  conn.on('data', (d) => {
    if (d.length > MAX_CLIENT_INBOUND_BYTES) {
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
  conn.on('close',() => {
    this.clients = this.clients.filter(a => a.info !== info)
  })
}

//Notify other nodes of incoming client message
signal(message) {
  for (const n of this.nodes) {
    try {
      n.conn.write(JSON.stringify({signal: true, message}))
    } catch (e) {
      // drop dead connection
      this.nodes = this.nodes.filter(a => a.conn !== n.conn)
    }
  }
}

notify(message) {
  for (const n of this.nodes) {
    try {
      n.conn.write(JSON.stringify({push: true, message}))
    } catch (e) {
      this.nodes = this.nodes.filter(a => a.conn !== n.conn)
    }
  }
}

//Notify clients of new message.
onmessage(message) {
  for (const c of this.clients) {
    try {
      c.conn.write(JSON.stringify({type: 'new-message', message}))
    } catch (e) {
      this.clients = this.clients.filter(a => a.conn !== c.conn)
    }
  }
}


ban(info, conn) {
  if (!conn) return
  conn.end()
  conn.destroy()
  if (!info) return
  info.ban(true)
}

timeout(info, conn) {
  this.ban(info, conn)
  if (!info) return
  setTimeout(() => info.ban(false), 60000)
}

async refresh(discovery) {
  await sleep(30000)
  setInterval(() => discovery.refresh({client: true, server: true}), 60000)
}

}

module.exports={Network}