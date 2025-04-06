
const EventEmitter = require('bare-events')
const { Wallet, NodeWallet } = require('./wallet')
const { Network } = require('./network')
const { load, limit, save } = require('./storage')
const {hash, chunk_array, sleep} = require('./utils')
const chalk = require('chalk');

class HuginNode extends EventEmitter {
  
  constructor() {
    super()
    this.pool = []
    this.network = null
  }

  async init(pub = false) {
    // This can be used as a trust system for stable nodes in the future?
    
    // If we have a private node
    // Hash our private key to get a determenistic dht key pair.
    const seed = pub ? '' : await hash(Wallet.spendKey())
    
    this.network = new Network(seed)
    this.pool = await load()
    this.network.node(NodeWallet.viewkey)
    if (pub) this.network.public_node(await hash(NodeWallet.viewkey))
    else this.network.private_node(Wallet.address)
    
    this.network.on('client-data', ({conn, info, data}) => {
      this.client_message(data, info, conn)

  }) 

  this.network.on('node-data', ({conn, info, data}) => { 
      this.node_message(data)
  })

      console.log(chalk.white("......................................."))
      console.log(chalk.yellow("........Waiting for connections........"))
      console.log(chalk.white("......................................."))
  }

  async node_message(data, info, conn) {
    if ('signal' in data) {
      if (!this.add(data.message)) {
        console.log(chalk.red("Invalid node signal message, ban node"))
        this.network.ban(info, conn)
      }
    }
  } 

  async client_message(data, info, conn) {
    if ('request' in data) {
      const response = this.onrequest(data)
      if (!response) {
          console.log(chalk.red("Invalid request command, ban user"))
          this.network.ban(info, conn)
          return
      }

      if (response.length > 500) {
        const parts = chunk_array(pool, 500)
        for (const response of parts) {
          conn.write(JSON.stringify({response, id: data.id, chunks: true}))
          await sleep(50)
        }
        conn.write(JSON.stringify({id: data.id, done: true}))
        return
      }
      conn.write(JSON.stringify({response, id: data.id}))
      return
    }

    if ('type' in data) {
      if (data.type === 'post') {
      if (!await this.post(data.message)) {
        console.log(chalk.red("Invalid post request"))
        this.network.ban(info, conn)
        return
      }
     }
    }
  }

  gossip(message) {
      this.network.signal(message)
  }

  // Verify that the message is allowed to be sent to the network.
  async verify(message) {
    if (!this.check(message)) return false
    if (!await Wallet.verify(message.cipher + message.hash, message.pub, message.signature)) return false
    if (!await NodeWallet.verify(message.pub)) return false
    if (await limit(message.pub)) return false
    return true
  }

  //From a client, gossip to other nodes.
  async post(message) {
    if (!await this.add(message)) return false
    this.gossip(message)
    return true
  }

  //From a node
  async add(message) {
    if (!await this.verify(message)) return false
    if (this.pool.some(a => a.hash == message.hash)) return true
    this.pool.push(message)
    console.log(chalk.yellow("Pool update. Number of messages:", this.pool.length))
    save(message)
    return true
  }

  // Got a request from client
  onrequest(req) {
    if (!this.isrequest(req)) return false
    if (req.type === "all") {
      return this.pool
    } else if (req.type === 'some') {
      return this.pool.filter(msg => msg.timestamp > req.timestamp - 500)
      .sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  check(message) {
      if (typeof message.cipher !== 'string') return false
      if (typeof message.hash !== 'string') return false
      if (typeof message.pub !== 'string') return false
      if (typeof message.timestamp !== 'number') return false
      if (typeof message.signature !== 'string') return false

      if (message.cipher.length > 2048) return false
      if (message.hash.length > 64) return false
      if (message.pub.length !== 64) return false
      if (message.timestamp.length > 30) return false
      if (message.signature.length !== 128) return false

      return true
  }

  isrequest(req) {
    if (typeof req.timestamp !== 'number') return false
    if (typeof req.type !== 'string') return false

    if (req.type.length > 10) return false
    if (req.timestamp.length > 30) return false

    return true
  }

}

module.exports={HuginNode}