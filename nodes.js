
const EventEmitter = require('bare-events')
const { Wallet, NodeWallet } = require('./wallet')
const { Network } = require('./network')
const { load, limit, save } = require('./storage')
const {hash, chunk_array, sleep} = require('./utils')
const chalk = require('chalk');
const { ONE_DAY, DAY_LIMIT, SIGNATURE_ERROR, WRONG_MESSAGE_FORMAT, MESSAGE_VERIFIED, LIMIT_REACHED, NOT_VERIFIED } = require('./constants')

class HuginNode extends EventEmitter {
  
  constructor() {
    super()
    this.pool = []
    this.network = null
  }

  async init(pub = false) {
    // Hash our private key to get a deterministic dht key pair.
    // This can be used as a trust system for stable nodes in the future?
    const seed = await hash(Wallet.spendKey())
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

    process.on('SIGTERM', async () => {
      console.log(chalk.red("Closing node..."))
      await this.save_pool()
      console.log("Closed.")
      process.exit(0);
    });
    
    process.on('SIGINT', async () => {
      console.log(chalk.red("Closing node..."))
      await this.save_pool()
      console.log("Closed.")
      process.exit(0);
    });

    setInterval( async () => this.cleaner(), 600000);
  }

  async save_pool() {
    for (const message of this.pool) {
      await save(message)
    }
    
    console.log(chalk.green("Saved messages from pool."))
  }

  async node_message(data, info, conn) {
    if ('signal' in data) {
      const add = await this.add(data.message)
      if (!add.success) {
        console.log("Failed to add message:", add.reason)
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
          this.send(conn,{response, id: data.id, chunks: true})
          await sleep(20)
        }
        this.send(conn,{id: data.id, done: true})
        return
      }
      this.send(conn,{response, id: data.id})
      return
    }

    if ('type' in data) {
      if (data.type === 'post') {
      const post = await this.post(data.message)
      if (post.success) {
        this.send(conn,{success: true, id: data.timestamp})
        return
      } else if (!post.success) {
        this.send(conn,{reason: post.reason, success: false, id: data.timestamp})
        //Temp ban user for one minute.
        this.network.timeout(info, conn)
        return
      }
      console.log(chalk.red("Invalid post request"))
      this.network.ban(info, conn)
      return
     }
    }
  }

  gossip(message) {
      this.network.signal(message)
  }

  //From a client, gossip to other nodes.
  async post(message) {
    const add = await this.add(message)
    if (!add.success) return add
    this.gossip(message)
    return add
  }

  //From a node
  async add(message) {
    //Ensure that we set the recieved timestamp as now.
    message.timestamp = Date.now()
    const verify = await this.verify(message)
    if (!verify.success) return verify
    if (this.pool.some(a => a.hash == message.hash)) return {success: true}
    this.pool.push(message)
    console.log(chalk.yellow("Pool update. Number of messages:", this.pool.length))
    return verify
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

    // Verify that the message is allowed to be sent to the network.
    async verify(message) {
      if (!this.check(message)) {
        return WRONG_MESSAGE_FORMAT
      }
      if (!await NodeWallet.verify(message.pub)) {
        return NOT_VERIFIED
      }
      if (!await Wallet.verify(message.cipher + message.hash, message.pub, message.signature)) {
       return SIGNATURE_ERROR
      }
      if (this.limit(message.pub)) {
        return LIMIT_REACHED
      }
      return MESSAGE_VERIFIED
    }

    send(conn, data) {
      conn.write(JSON.stringify(data))
    }

  check(message) {
      if (typeof message.cipher !== 'string') return false
      if (typeof message.hash !== 'string') return false
      if (typeof message.pub !== 'string') return false
      if (typeof message.timestamp !== 'number') return false
      if (typeof message.signature !== 'string') return false

      if (message.cipher.length > 3048) return false
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

  cleaner() {
    const now = Date.now()
    const clean = this.pool.filter(m => {
      return m.timestamp && m.timestamp > (now - ONE_DAY);
    });
    this.pool = clean
  }

  limit(pub) {
    const number = this.pool.filter(m => m.pub === pub);
    return number.length > DAY_LIMIT
  }

}

module.exports={HuginNode}