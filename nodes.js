
const EventEmitter = require('bare-events')
const { NodeId } = require('./id')
const { Network } = require('./network')
const { PoolConnector, POOLS } = require('./pools')
const { load, limit, save } = require('./storage')
const {hash, chunk_array, sleep} = require('./utils')
const chalk = require('chalk');
const { extractPrevIdFromBlob, nonceTagFromMessageHash, nonceMatchesTag } = require('hugin-utils')
const { 
  ONE_DAY, DAY_LIMIT, 
  SIGNATURE_ERROR, 
  WRONG_MESSAGE_FORMAT, 
  MESSAGE_VERIFIED, 
  LIMIT_REACHED, 
  POW_INVALID,
  NOT_VERIFIED,
  POW_DEBUG,
  POOL_ALGO,
  POOL_VARIANT,
  POOL_BLOBTYPE,
  POOL_INCLUDE_HEIGHT,
  POOL_HASHING_UTIL,
  NONCE_TAG_BITS,
  POW_VERSION,
  MAX_SHARES_PER_MESSAGE,
  MAX_MESSAGE_PAST_MS,
  MAX_MESSAGE_FUTURE_MS,
  MAX_SYNC_MESSAGES,
  MAX_JOB_BLOB_HEX_BYTES,
  CLIENT_POST_COOLDOWN_MS } = require('./constants')

const logPow = (...args) => {
  if (POW_DEBUG) {
    console.log('[pow]', ...args)
  }
}

function isHexString(value) {
  return typeof value === 'string' && /^[0-9a-f]+$/i.test(value)
}

class HuginNode extends EventEmitter {
  
  constructor(options = {}) {
    super()
    this.pool = new Map()
    this.network = null
    this.poolConnector = null
    this.poolJob = null
    this.pendingJobRequests = new Set()
    this.jobSubscribers = new Set()
    this.currentPrevId = null
    this.previousPrevId = null
    this.twoBackPrevId = null
    this.poolIndex = 0
    this.payoutAddress = options.payoutAddress || ''
    this.networkAddress = 'xkr96c0f8a36e951b399681d447922f6c54c28c6ef3cad1c65d3568008151337';
    this.clientPostLastAcceptedAt = new WeakMap()
    this.clientInvalidShareStrikes = new WeakMap()
    this.clientConnIds = new WeakMap()
    this.nextClientConnId = 1
  }

  client_id(conn) {
    if (!conn) return null
    let id = this.clientConnIds.get(conn)
    if (!id) {
      id = this.nextClientConnId++
      this.clientConnIds.set(conn, id)
    }
    return id
  }

  nowMs() {
    return Date.now()
  }

  hrtimeMs(startNs) {
    const diff = process.hrtime.bigint() - startNs
    return Number(diff) / 1e6
  }

  // Cheap validation only
  cheap_pow(message) {
    if (!this.check(message)) {
      logPow('pow_precheck', { status: 'reject', reason: 'wrong_message_format' })
      return WRONG_MESSAGE_FORMAT
    }
    const v = message && message.pow && typeof message.pow.version === 'number'
      ? message.pow.version
      : 1
    if (v !== POW_VERSION) {
      logPow('pow_precheck', { status: 'reject', reason: 'wrong_pow_version', v })
      return POW_INVALID
    }

    const shares = message && message.pow && Array.isArray(message.pow.shares)
      ? message.pow.shares
      : []
    if (!shares.length) {
      logPow('pow_precheck', { status: 'reject', reason: 'no_shares' })
      return POW_INVALID
    }

    // Freshness + nonce-tag prefilter (low CPU, NO slow-hash verification).
    const ok = this.pow_check_fast(message)
    if (!ok) {
      logPow('pow_precheck', { status: 'reject', reason: 'fast_check_failed', jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      return POW_INVALID
    }

    logPow('pow_precheck', { status: 'ok', jobId: message && message.pow && message.pow.job && message.pow.job.job_id, shares: shares.length })
    return MESSAGE_VERIFIED
  }

  async init(pub = false) {
    // Hash our random generated viewkey to get a deterministic dht key pair.
    // This can be used as a trust system for stable nodes in the future?
    this.network = new Network(await hash(NodeId.viewkey))
    this.pool = await load()
    // Start a node with our network common address (to find other nodes).
    this.network.node(await hash(this.networkAddress))

    // Always start a private to gain access with Node address.
    this.network.private_node(NodeId.address)
    // Public nodes are automatically found with fastest connection.
    if (pub) this.network.public_node(this.networkAddress)

    
    //Event listeners
    this.network.on('client-data', ({conn, info, data}) => {
      this.client_message(data, info, conn)
     }) 

    this.network.on('node-data', ({conn, info, data}) => { 
      this.node_message(data, info, conn)
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

    this.init_pool()
  }

  init_pool() {
    if (!POOLS.length) {
      console.log(chalk.red("No pools configured."))
      return
    }
    this.connect_pool(POOLS[this.poolIndex])
  }

  connect_pool(pool) {
    if (this.poolConnector) {
      this.poolConnector.disconnect()
      this.poolConnector = null
    }
    const login = this.payoutAddress
    if (!login) {
      console.log(chalk.red("No payout address set. Set it before starting..."))
      return
    }
    this.poolConnector = new PoolConnector({
      host: pool.host,
      port: pool.port,
      ssl: pool.ssl,
      login,
      pass: 'x',
      agent: 'hugin-node',
      cnAlgorithm: POOL_ALGO,
      cnVariant: POOL_VARIANT,
      cnBlobType: POOL_BLOBTYPE,
      includeHeight: POOL_INCLUDE_HEIGHT,
      hashingUtil: POOL_HASHING_UTIL
    })

    this.poolConnector.on('job', (job) => {
      this.poolJob = job
      const prevId = job && job.blob ? extractPrevIdFromBlob(job.blob) : null
      logPow('job_received', {
        jobId: job && job.job_id,
        target: job && job.target,
        hasPrevId: !!prevId,
        subscribers: this.jobSubscribers.size,
        pending: this.pendingJobRequests.size
      })
      if (prevId) {
        this.twoBackPrevId = this.previousPrevId
        this.previousPrevId = this.currentPrevId
        this.currentPrevId = prevId
      }
      this.flush_jobs()
    })

    this.poolConnector.on('loginFailed', () => {
      this.next_pool()
    })

    // Prevent hard-crash on transient socket errors (e.g. ECONNRESET / lost internet)
    this.poolConnector.on('poolError', (err) => {
      const code = err && err.code ? String(err.code) : 'UNKNOWN'
      const msg = err && err.message ? String(err.message) : ''
      console.log(chalk.yellow(`Pool connection error: ${code}${msg ? ` (${msg})` : ''}`))
    })

    this.poolConnector.on('disconnected', () => {
      this.next_pool()
    })

    this.poolConnector.connect()
  }

  next_pool() {
    if (!POOLS.length) return
    this.poolIndex = (this.poolIndex + 1) % POOLS.length
    const nextPool = POOLS[this.poolIndex]
    console.log(chalk.yellow(`Switching pool to ${nextPool.host}:${nextPool.port}`))
    setTimeout(() => this.connect_pool(nextPool), 2000)
  }

  flush_jobs() {
    if (!this.poolJob) return
    // Broadcast latest job to all subscribers (unsolicited push),
    // so clients can immediately switch mining to newest job.
    logPow('job_broadcast', {
      jobId: this.poolJob && this.poolJob.job_id,
      target: this.poolJob && this.poolJob.target,
      subscribers: this.jobSubscribers.size,
      pending: this.pendingJobRequests.size
    })
    for (const conn of this.jobSubscribers) {
      try {
        this.send(conn, { type: 'job', job: this.poolJob })
      } catch (e) {
        this.jobSubscribers.delete(conn)
      }
    }
    for (const conn of this.pendingJobRequests) {
      this.send(conn, { type: 'job', job: this.poolJob })
    }
    this.pendingJobRequests.clear()
  }

  async save_pool() {
    for (const [, message] of this.pool) {
      await save(message);
    }

    console.log(chalk.green("Saved messages from pool."));
  }

  async node_message(data, info, conn) {
    // Node-to-node propagation (gossip)
    if ('signal' in data) {
      const message = data && data.message
      if (!message || typeof message !== 'object') return
      // We can't reliably verify pool shares from other nodes (they may use a different pool/template).
      // Do a cheap gossip validation instead and store without slow-check.
      if (!this.check(message)) return
      if (!(await this.pow_check_gossip(message))) {
        console.log("Failed to add message:", POW_INVALID.reason)
        console.log(chalk.red("Invalid node signal message, ban node"))
        this.network.ban(info, conn)
        return
      }
      const add = await this.add(message, true)
      if (!add.success) return
      return
    }

    if ('push' in data) {
      // only do cheap checks here (push server will do full verification).
      const message = data && data.message
      if (!message || typeof message !== 'object') return
      // Some forwarded node payloads (e.g. register) are not PoW messages.
      // Ignore them here instead of banning the peer.
      if (!this.check(message)) return

      const pre = this.cheap_pow(message)
      if (!pre.success) {
        console.log("Failed to add message:", pre.reason)
        console.log(chalk.red("Invalid node push message, ban node"))
        this.network.ban(info, conn)
        return
      }
      const add = await this.add(message, true)
      if (!add.success) {
        console.log("Failed to add message:", add.reason)
        console.log(chalk.red("Invalid node push message, ban node"))
        this.network.ban(info, conn)
      }
      return
    }

  } 

  async client_message(data, info, conn) {
    const client_id = this.client_id(conn)

    if ('request' in data) {
      const response = this.onrequest(data)
      if (!response) {
          console.log(chalk.red("Invalid request command, ban user"))
          this.network.ban(info, conn)
          return
      }

      if (response.length > 500) {
        const parts = chunk_array(response, 500)
        for (const res of parts) {
          this.send(conn,{response: res, id: data.id, chunks: true})
          await sleep(20)
        }
        this.send(conn,{id: data.id, done: true})
        return
      }
      this.send(conn,{response, id: data.id})
      return
    }

    if ('type' in data) {
      if (data.type === 'job_request') {
        logPow('client_cmd', { client_id, type: 'job_request' })
        this.job_request(conn, data)
        return
      }
      if (data.type === 'share') {
        logPow('client_cmd', { client_id, type: 'share', count: Array.isArray(data.shares) ? data.shares.length : 1 })
        await this.submit_shares(conn, data)
        return
      }
      if (data.type === 'post') {
        logPow('client_cmd', { client_id, type: 'post', id: data && data.message && data.message.id })
        await this.client_post(data, info, conn)
        return
      } else {
        console.log(chalk.red("Invalid post request"))
        this.network.ban(info, conn)
        return
      }
     }

     //Forward encrypted register requests.
     if ('register' in data) {
       this.network.notify(data)
     } 

  }

  async client_post(data, info, conn) {
    // 1s cooldown per client between ACCEPTED propagated messages
    const now = this.nowMs()
    const message = data.message
    const client_id = this.client_id(conn)
    if (POW_DEBUG) {
      logPow('client_post', {
        status: 'received',
        client_id,
        id: message && message.id,
        jobId: message && message.pow && message.pow.job && message.pow.job.job_id,
        shares: message && message.pow && Array.isArray(message.pow.shares) ? message.pow.shares.length : 0
      })
    }
    const lastAccepted = this.clientPostLastAcceptedAt.get(conn) || 0
    if ((now - lastAccepted) < CLIENT_POST_COOLDOWN_MS) {
      logPow('client_post', { status: 'reject', reason: 'cooldown', client_id, id: message && message.id })
      this.send(conn, { success: false, reason: 'cooldown', id: message && message.id })
      return
    }

    // Client flow (low CPU): cheap precheck -> submit shares to pool -> store -> relay
    const shares = message && message.pow && Array.isArray(message.pow.shares) ? message.pow.shares : []
    if (!shares || shares.length === 0) {
      logPow('client_post', { status: 'reject', reason: 'no_share', client_id, id: message && message.id })
      this.send(conn, { reason: 'no_share', success: false, id: message && message.id })
      this.network.timeout(info, conn)
      return
    }

    // Cheap check is to prevent wasting pool submits + avoid CPU slow-hash on nodes.
    const pre = this.cheap_pow(message)
    if (!pre.success) {
      const strikes = (this.clientInvalidShareStrikes.get(conn) || 0) + 1
      this.clientInvalidShareStrikes.set(conn, strikes)
      logPow('client_post', { status: 'reject', reason: 'cheap_pow', client_id, strikes, id: message && message.id, jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      this.send(conn, { reason: pre.reason, success: false, id: message && message.id })
      if (strikes >= 2) {
        this.network.ban(info, conn)
      }
      return
    }

    const tPool = process.hrtime.bigint()
    let accepted = false
    for (const share of shares.slice(0, MAX_SHARES_PER_MESSAGE)) {
      const poolRes = await this.poolConnector.submitShare({
        job_id: share.job_id,
        nonce: share.nonce,
        result: share.result
      })
      if (poolRes && poolRes.ok) {
        accepted = true
        break
      }
    }
    if (POW_DEBUG) {
      logPow('pool_submit_timing', { ms: this.hrtimeMs(tPool), ok: accepted })
    }
    if (!accepted) {
      const strikes = (this.clientInvalidShareStrikes.get(conn) || 0) + 1
      this.clientInvalidShareStrikes.set(conn, strikes)
      logPow('client_post', { status: 'reject', reason: 'pool_reject', client_id, strikes, id: message && message.id, jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      this.send(conn, { reason: 'pool_reject', success: false, id: message && message.id })
      if (strikes >= 2) {
        this.network.ban(info, conn)
      }
      return
    }
    logPow('client_post', { status: 'pool_ok', client_id, id: message && message.id, jobId: message && message.pow && message.pow.job && message.pow.job.job_id })

    // Pool accepted at least one share => store without re-verifying, then relay
    const added = await this.add(message, true)
    if (!added.success) {
      logPow('client_post', { status: 'reject', reason: 'store_failed', client_id, id: message && message.id })
      this.send(conn, { reason: added.reason, success: false, id: message && message.id })
      return
    }

    this.clientPostLastAcceptedAt.set(conn, now)
    this.clientInvalidShareStrikes.delete(conn)
    logPow('client_post', { status: 'ok', client_id, id: message && message.id })
    this.send(conn, { success: true, id: message && message.id })

    const v = message && message.pow && typeof message.pow.version === 'number'
      ? message.pow.version
      : 1
    if (v === POW_VERSION) {
      this.gossip(message)
    }

    if ('push' in message) {
      this.network.notify(data)
    }
  }

  job_request(conn, data) {
    const client_id = this.client_id(conn)
    this.jobSubscribers.add(conn)
    if (this.poolJob) {
      logPow('job_request', { status: 'ok', client_id, jobId: this.poolJob.job_id, subscribers: this.jobSubscribers.size })
      this.send(conn, { type: 'job', job: this.poolJob, id: data.id })
      return
    }
    logPow('job_request', { status: 'pending', client_id, subscribers: this.jobSubscribers.size })
    this.pendingJobRequests.add(conn)
    this.send(conn, { type: 'job_pending', id: data.id })
  }

  async submit_shares(conn, data) {
    const client_id = this.client_id(conn)
    if (!this.poolConnector || !this.poolJob) {
      logPow('submit_shares', { status: 'reject', client_id, reason: 'no_job' })
      this.send(conn, { type: 'share_result', status: 'reject', reason: 'no_job', id: data.id })
      return
    }
    const shares = Array.isArray(data.shares)
      ? data.shares
      : [data.share || data]

    const cappedShares = shares.slice(0, 50)
    logPow('submit_shares', { client_id, count: cappedShares.length, id: data && data.id })
    const results = await Promise.all(cappedShares.map((share) => {
      return this.poolConnector.submitShare({
        job_id: share.job_id,
        nonce: share.nonce,
        result: share.result
      })
    }))

    const failed = results.filter(r => !r.ok).length
    const total = results.length || 1
    const failedRatio = failed / total
    const status = failedRatio > 0.1 ? 'reject' : 'ok'
    logPow('submit_shares_result', { status, client_id, failed, total, id: data && data.id })

    this.send(conn, {
      type: 'share_result',
      status,
      failed,
      total,
      reason: status === 'reject' ? 'too_many_failed_shares' : null,
      id: data.id
    })
  }



 async on_message(data, conn, info) {
    const post = await this.post(data.message)
    if (post.success) {
      this.send(conn, {
        success: true, 
        id: data.message.id
      })
      return true
    } else if (!post.success) {
      this.send(conn, { 
          reason: post.reason, 
          success: false, 
          id: data.message.id
        })
      // Cooldown is not wrongdoing; don't disconnect/ban.
      if (post.reason === 'cooldown') {
        return false
      }
      //Temp ban user for one minute.
      await sleep(500)
      this.network.timeout(info, conn)
      return false
    }
  }

  gossip(message) {
      this.network.onmessage(message)
      this.network.signal(message)
  }

  //From a client, gossip to other nodes.
  async post(message) {
    const add = await this.add(message)
    if (!add.success) return add
    const v = message && message.pow && typeof message.pow.version === 'number'
      ? message.pow.version
      : 1
    if (v === POW_VERSION) {
      this.gossip(message)
    }
    return add
  }

  async add(message, verified = false) {
    //Check early if we already have the message before we try to verify it.
    if (typeof message.hash !== 'string') return WRONG_MESSAGE_FORMAT
    if (this.pool.has(message.hash)) return MESSAGE_VERIFIED
    
    //Ensure that we set the recieved timestamp as now.
    message.timestamp = Date.now()

    //Verify and add message to pool.
    const verify = verified ? MESSAGE_VERIFIED : await this.verify(message)
    if (!verify.success) return verify
    this.pool.set(message.hash, message);
    console.log(chalk.yellow("Pool update. Number of messages:", this.pool.size))
    return verify
  }

  // Got a request from client
  onrequest(req) {
    if (!this.isrequest(req)) return false;

    if (req.type === "some") {
      const out = []
      for (const msg of this.pool.values()) {
        if (msg && msg.timestamp > req.timestamp) {
          out.push(msg)
          if (out.length >= MAX_SYNC_MESSAGES) break
        }
      }
      return out.sort((a, b) => a.timestamp - b.timestamp)
    }
  }

  // Verify that the message is allowed to be sent to the network.
  // Slow PoW verification here is always random-sampled to reduce CPU load.
  async verify(message) {
    if (!this.check(message)) {
      return WRONG_MESSAGE_FORMAT
    }
    // Require PoW shares instead of pub-key allowlist
    const powValid = await this.pow_check(message)
    if (!powValid) {
      return POW_INVALID
    }
    // if (!await NodeId.verify(message.pub)) {
    //   return NOT_VERIFIED
    // }
    // if (!await Wallet.verify(message.cipher + message.hash, message.pub, message.signature)) {
    //   return SIGNATURE_ERROR
    // }
    // if (this.limit(message.pub)) {
    //   return LIMIT_REACHED
    // }
    return MESSAGE_VERIFIED
  }

  send(conn, data) {
    conn.write(JSON.stringify(data))
  }

  confirm(conn, payload) {
    this.send(conn, { type: 'ok', payload })
  }

  check(message) {
    if (typeof message.cipher !== 'string') return false
    if (typeof message.hash !== 'string') return false
    if (typeof message.pub !== 'string') return false
    if (typeof message.timestamp !== 'number') return false
    if (typeof message.signature !== 'string') return false
    if (typeof message.pow !== 'object') return false
    if (!message.pow) return false
    if (!message.pow.job || !message.pow.shares) return false
    if (!Array.isArray(message.pow.shares)) return false
    if (message.pow.version !== undefined && typeof message.pow.version !== 'number') return false

    // Cheap validation of embedded job/share shapes
    const job = message.pow.job
    if (!job || typeof job !== 'object') return false
    if (typeof job.job_id !== 'string' || job.job_id.length > 32) return false
    if (!isHexString(job.blob)) return false
    if (job.blob.length % 2 !== 0) return false
    if ((job.blob.length / 2) > MAX_JOB_BLOB_HEX_BYTES) return false
    if (!isHexString(job.target) || job.target.length !== 8) return false

    if (message.cipher.length > 4096) return false
    if (!isHexString(message.cipher)) return false
    if (message.hash.length > 64) return false
    if (!isHexString(message.hash)) return false
    if (message.pub.length !== 64) return false
    if (!isHexString(message.pub)) return false
    if (message.signature.length !== 128) return false
    if (!isHexString(message.signature)) return false
    if (message.timestamp < 0) return false
    if (message.pow.shares.length > MAX_SHARES_PER_MESSAGE) return false
    const now = Date.now()
    if (message.timestamp > (now + MAX_MESSAGE_FUTURE_MS)) return false
    if (message.timestamp < (now - MAX_MESSAGE_PAST_MS)) return false

    return true
  }

  // Cheap local checks only (no slow hash).
  // Used for client -> node precheck before pool submission.
  pow_check_fast(message) {
    if (!this.poolConnector) return false
    const job = message.pow.job
    const shares = message.pow.shares || []
    if (!job || !job.job_id || !job.blob || !job.target) return false
    if (!Array.isArray(shares) || shares.length === 0) return false

    const prevId = extractPrevIdFromBlob(job.blob)
    if (!prevId || !this.currentPrevId) {
      logPow('pow_check_fast', { status: 'reject', reason: 'no_prev_id', jobId: job.job_id })
      return false
    }
    if (prevId !== this.currentPrevId && prevId !== this.previousPrevId && prevId !== this.twoBackPrevId) {
      logPow('pow_check_fast', { status: 'reject', reason: 'prev_id_mismatch', jobId: job.job_id })
      return false
    }

    const tagValue = nonceTagFromMessageHash(message.hash, NONCE_TAG_BITS)
    let jobIdMismatch = 0
    let badNonce = 0
    let badResult = 0
    let tagMismatch = 0
    for (const share of shares.slice(0, MAX_SHARES_PER_MESSAGE)) {
      if (!share || share.job_id !== job.job_id) {
        jobIdMismatch++
        continue
      }
      if (typeof share.nonce !== 'string' || share.nonce.length !== 8 || !isHexString(share.nonce)) {
        badNonce++
        continue
      }
      if (typeof share.result !== 'string' || share.result.length !== 64 || !isHexString(share.result)) {
        badResult++
        continue
      }
      if (!nonceMatchesTag(share.nonce, tagValue, NONCE_TAG_BITS)) {
        tagMismatch++
        continue
      }
      logPow('pow_check_fast', { status: 'ok', jobId: job.job_id })
      return true
    }
    logPow('pow_check_fast', { status: 'reject', reason: 'no_matching_share', jobId: job.job_id, counts: { jobIdMismatch, badNonce, badResult, tagMismatch }, total: shares.length })
    return false
  }

  // Node-to-node gossip check: validate message/share shapes + nonce-tag binding.
  // Does NOT check prev_id freshness against our pool template (nodes can use different pools/templates).
  async pow_check_gossip(message) {
    if (!message || !message.pow) return false
    if (!this.poolConnector) return false
    const job = message.pow.job
    const shares = message.pow.shares || []
    if (!job || !job.job_id || !job.blob || !job.target) return false
    if (!Array.isArray(shares) || shares.length === 0) return false

    const prevId = extractPrevIdFromBlob(job.blob)
    if (!prevId) return false

    const tagValue = nonceTagFromMessageHash(message.hash, NONCE_TAG_BITS)
    const cappedShares = shares.slice(0, MAX_SHARES_PER_MESSAGE)
    const candidates = []
    for (const share of cappedShares) {
      if (!share || share.job_id !== job.job_id) continue
      if (typeof share.nonce !== 'string' || share.nonce.length !== 8 || !isHexString(share.nonce)) continue
      if (typeof share.result !== 'string' || share.result.length !== 64 || !isHexString(share.result)) continue
      if (!nonceMatchesTag(share.nonce, tagValue, NONCE_TAG_BITS)) continue
      candidates.push(share)
    }
    if (!candidates.length) return false

    // Do one slow verification (random-sampled) to ensure the share is actually valid PoW for this job.
    const share = candidates[Math.floor(Math.random() * candidates.length)]
    return await this.poolConnector.verifyShare(job, share.nonce, share.result)
  }

  pow_target(messageHash) {
    return 1
  }

  async pow_check(message) {
    if (!this.poolConnector) return false
    const job = message.pow.job
    const shares = message.pow.shares || []
    if (!job || !job.job_id || !job.blob || !job.target) return false
    if (!Array.isArray(shares) || shares.length === 0) return false

    // Freshness check: accept only current/previous block templates (last 3 prev_ids).
    const prevId = extractPrevIdFromBlob(job.blob)
    if (!prevId || !this.currentPrevId) {
      logPow('pow_check_stale', { reason: 'no_prev_id', jobId: job.job_id })
      return false
    }
    if (prevId !== this.currentPrevId && prevId !== this.previousPrevId && prevId !== this.twoBackPrevId) {
      logPow('pow_check_stale', { reason: 'prev_id_mismatch', jobId: job.job_id })
      return false
    }

    const required = this.pow_target(message.hash)
    const tagValue = nonceTagFromMessageHash(message.hash, NONCE_TAG_BITS)
    
    // Slow verification (random-sampled)
    let valid = 0
    const cappedShares = shares.slice(0, MAX_SHARES_PER_MESSAGE)
    const toCheck = cappedShares.length
      ? [cappedShares[Math.floor(Math.random() * cappedShares.length)]]
      : []
    let checked = 0
    let jobIdMismatch = 0
    let badNonce = 0
    let badResult = 0
    let tagMismatch = 0
    let verifyFail = 0
    for (const share of toCheck) {
      checked++
      if (!share || share.job_id !== job.job_id) {
        jobIdMismatch++
        continue
      }
      if (typeof share.nonce !== 'string' || share.nonce.length !== 8 || !isHexString(share.nonce)) {
        badNonce++
        continue
      }
      if (typeof share.result !== 'string' || share.result.length !== 64 || !isHexString(share.result)) {
        badResult++
        continue
      }
      if (!nonceMatchesTag(share.nonce, tagValue, NONCE_TAG_BITS)) {
        tagMismatch++
        continue
      }
      const ok = await this.poolConnector.verifyShare(job, share.nonce, share.result)
      if (ok) {
        valid++
        logPow('pow_check_share', { status: 'ok', jobId: job.job_id, nonce: share.nonce })
        if (valid >= required) return true
      }
      verifyFail++
    }
    logPow('pow_check_full', {
      valid,
      required,
      total: shares.length,
      checked,
      counts: { jobIdMismatch, badNonce, badResult, tagMismatch, verifyFail }
    })
    return false
  }

  isrequest(req) {
    if (typeof req.timestamp !== 'number') return false
    if (typeof req.type !== 'string') return false

    if (req.type.length > 10) return false

    return true
  }

  cleaner() {
    const now = Date.now();
    for (const [hash, message] of this.pool) {
      if (!message.timestamp || message.timestamp <= now - ONE_DAY) {
        this.pool.delete(hash)
      }
    }
  }

  limit(pub) {
    let count = 0;
    for (const [, message] of this.pool) {
      if (message.pub === pub) {
        count++
        if (count > DAY_LIMIT) return true
      }
    }

    return false;
  }


}

module.exports={HuginNode}