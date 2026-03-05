
const EventEmitter = require('bare-events')
const { NodeId } = require('./id')
const { Network } = require('./network')
const Keychains = require('keypear')
const { PoolConnector, POOLS } = require('./pools')
const { load, limit, save } = require('./storage')
const {hash, chunk_array, sleep} = require('./utils')
const chalk = require('chalk');
const { extractPrevIdFromBlob } = require('hugin-utils')
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
  POW_VERSION,
  MAX_SHARES_PER_MESSAGE,
  MAX_MESSAGE_PAST_MS,
  MAX_MESSAGE_FUTURE_MS,
  MAX_SYNC_MESSAGES,
  MAX_JOB_BLOB_HEX_BYTES,
  CLIENT_POST_COOLDOWN_MS,
  CLIENT_JOB_REQUEST_MAX_PER_10S,
  GLOBAL_JOB_REQUEST_MAX_PER_10S,
  REQUEST_RATE_WINDOW_MS,
  CLIENT_REQUEST_SPAM_STRIKES } = require('./constants')

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
    this.lastPoolSwitchAt = 0
    this.poolReconnectTimer = null
    this.payoutAddress = options.payoutAddress || ''
    this.networkAddress = 'xkr96c0f8a36e951b399681d447922f6c54c28c6ef3cad1c65d3568008151337';
    this.clientPostLastAcceptedAt = new WeakMap()
    this.clientInvalidShareStrikes = new WeakMap()
    this.acceptedShareCache = new Map()
    this.acceptedShareCacheTtlMs = 10 * 60 * 1000
    this.acceptedPowAuthCache = new Map()
    this.acceptedPowAuthCacheTtlMs = 2 * 60 * 60 * 1000
    this.clientConnIds = new WeakMap()
    this.nextClientConnId = 1
    this.clientJobRequestWindows = new WeakMap()
    this.clientRequestSpamStrikes = new WeakMap()
    this.globalJobRequestWindow = { start: 0, count: 0 }
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

  normalize_pool_reject(poolRes) {
    return {
      reason: poolRes && poolRes.reason ? poolRes.reason : 'unknown',
      error: poolRes && poolRes.error
        ? (poolRes.error.message || poolRes.error.code || String(poolRes.error))
        : null
    }
  }

  share_cache_key(share) {
    if (!share || typeof share !== 'object') return null
    const jobId = typeof share.job_id === 'string' ? share.job_id : ''
    const nonce = typeof share.nonce === 'string' ? share.nonce.toLowerCase() : ''
    const result = typeof share.result === 'string' ? share.result.toLowerCase() : ''
    if (!jobId || !nonce || !result) return null
    return `${jobId}:${nonce}:${result}`
  }

  prune_accepted_share_cache(now = this.nowMs()) {
    if (!this.acceptedShareCache.size) return
    for (const [key, ts] of this.acceptedShareCache) {
      if ((now - ts) > this.acceptedShareCacheTtlMs) {
        this.acceptedShareCache.delete(key)
      }
    }
  }

  has_accepted_share(share) {
    const key = this.share_cache_key(share)
    if (!key) return false
    this.prune_accepted_share_cache()
    return this.acceptedShareCache.has(key)
  }

  mark_accepted_share(share) {
    const key = this.share_cache_key(share)
    if (!key) return
    this.prune_accepted_share_cache()
    this.acceptedShareCache.set(key, this.nowMs())
  }

  pow_auth_cache_key(hashValue, pow) {
    if (typeof hashValue !== 'string' || hashValue.length !== 64 || !isHexString(hashValue)) return null
    const auth = pow && typeof pow === 'object' ? pow.auth : null
    const sig = auth && typeof auth.sig === 'string' ? auth.sig.toLowerCase() : ''
    if (!sig || !isHexString(sig) || sig.length !== 128) return null
    return `${hashValue}:${sig}`
  }

  prune_accepted_pow_auth_cache(now = this.nowMs()) {
    if (!this.acceptedPowAuthCache.size) return
    for (const [key, ts] of this.acceptedPowAuthCache) {
      if ((now - ts) > this.acceptedPowAuthCacheTtlMs) {
        this.acceptedPowAuthCache.delete(key)
      }
    }
  }

  has_accepted_pow_auth(hashValue, pow) {
    const key = this.pow_auth_cache_key(hashValue, pow)
    if (!key) return false
    this.prune_accepted_pow_auth_cache()
    return this.acceptedPowAuthCache.has(key)
  }

  mark_accepted_pow_auth(hashValue, pow) {
    const key = this.pow_auth_cache_key(hashValue, pow)
    if (!key) return
    this.prune_accepted_pow_auth_cache()
    this.acceptedPowAuthCache.set(key, this.nowMs())
  }

  has_auth_reject(rejects) {
    if (!Array.isArray(rejects) || !rejects.length) return false
    return rejects.some((item) => {
      if (!item) return false
      if (item.reason === 'not_logged_in') return true
      return item.reason === 'pool' && typeof item.error === 'string' && /unauthenticated/i.test(item.error)
    })
  }

  is_duplicate_share_reject(poolRes) {
    if (!poolRes) return false
    const normalized = this.normalize_pool_reject(poolRes)
    const reason = typeof normalized.reason === 'string' ? normalized.reason.toLowerCase() : ''
    const error = typeof normalized.error === 'string' ? normalized.error.toLowerCase() : ''
    if (reason === 'duplicate_share' || reason === 'duplicate') return true
    return /\bduplicate\b/.test(error) && /\bshare\b/.test(error)
  }

  async wait_for_pool_login(connector, timeoutMs = 2000) {
    const started = this.nowMs()
    while ((this.nowMs() - started) < timeoutMs) {
      if (!connector) return false
      if (connector.session && connector.session.id) return true
      if (connector.socket && connector.socket.writable && !connector.reauthInFlight) {
        try {
          connector.login()
        } catch (_) {}
      }
      await sleep(100)
    }
    return !!(connector && connector.session && connector.session.id)
  }

  async submit_message_shares_with_reauth(shares, connector, { maxShares = MAX_SHARES_PER_MESSAGE } = {}) {
    const cappedShares = Array.isArray(shares) ? shares.slice(0, maxShares) : []
    if (!connector || !cappedShares.length) {
      return { accepted: false, rejects: [{ reason: 'no_pool_connector', error: null }], retriedAuth: false }
    }

    const submitBatch = async () => {
      let accepted = false
      const rejects = []
      for (const share of cappedShares) {
        if (this.has_accepted_share(share)) {
          accepted = true
          continue
        }
        const poolRes = await connector.submitShare({
          job_id: share.job_id,
          nonce: share.nonce,
          result: share.result
        })
        if (poolRes && poolRes.ok) {
          this.mark_accepted_share(share)
          accepted = true
          break
        }
        if (this.is_duplicate_share_reject(poolRes)) {
          // Idempotent submission: pool already has this share.
          this.mark_accepted_share(share)
          accepted = true
          continue
        }
        rejects.push(this.normalize_pool_reject(poolRes))
      }
      return { accepted, rejects }
    }

    const first = await submitBatch()
    if (first.accepted || !this.has_auth_reject(first.rejects)) {
      return { accepted: first.accepted, rejects: first.rejects, retriedAuth: false }
    }

    logPow('pool_reauth_retry', { status: 'start', shares: cappedShares.length })
    const relogged = await this.wait_for_pool_login(connector)
    if (!relogged) {
      logPow('pool_reauth_retry', { status: 'failed_login_wait' })
      return { accepted: false, rejects: first.rejects, retriedAuth: true }
    }

    const second = await submitBatch()
    logPow('pool_reauth_retry', { status: second.accepted ? 'ok' : 'reject', shares: cappedShares.length })
    return { accepted: second.accepted, rejects: second.accepted ? [] : second.rejects, retriedAuth: true }
  }

  allow_client_window(map, conn, now, limit, windowMs) {
    let state = map.get(conn)
    if (!state || (now - state.start) >= windowMs) {
      state = { start: now, count: 0 }
    }
    state.count += 1
    map.set(conn, state)
    return state.count <= limit
  }

  allow_global_window(state, now, limit, windowMs) {
    if (!state.start || (now - state.start) >= windowMs) {
      state.start = now
      state.count = 0
    }
    state.count += 1
    return state.count <= limit
  }

  rate_limit_request(kind, conn, info, id) {
    const now = this.nowMs()
    const perClientLimit = CLIENT_JOB_REQUEST_MAX_PER_10S
    const globalLimit = GLOBAL_JOB_REQUEST_MAX_PER_10S
    const clientMap = this.clientJobRequestWindows
    const globalState = this.globalJobRequestWindow
    const client_id = this.client_id(conn)

    const clientOk = this.allow_client_window(clientMap, conn, now, perClientLimit, REQUEST_RATE_WINDOW_MS)
    const globalOk = this.allow_global_window(globalState, now, globalLimit, REQUEST_RATE_WINDOW_MS)
    if (clientOk && globalOk) return true

    const strikes = (this.clientRequestSpamStrikes.get(conn) || 0) + 1
    this.clientRequestSpamStrikes.set(conn, strikes)
    logPow('rate_limit', {
      status: 'reject',
      type: kind,
      client_id,
      id,
      strikes,
      scope: !clientOk ? 'client' : 'global',
      windowMs: REQUEST_RATE_WINDOW_MS,
      clientLimit: perClientLimit,
      globalLimit
    })
    this.send(conn, { success: false, reason: 'rate_limit', id })
    if (strikes >= CLIENT_REQUEST_SPAM_STRIKES) {
      this.network.timeout(info, conn)
      this.clientRequestSpamStrikes.delete(conn)
      this.clientJobRequestWindows.delete(conn)
      logPow('rate_limit', { status: 'timeout', type: kind, client_id, id })
    }
    return false
  }

  // Cheap validation only
  build_pow_sig_payload(messageHash, timestamp, share, context = '') {
    const jobId = share && typeof share.job_id === 'string' ? share.job_id : ''
    const nonce = share && typeof share.nonce === 'string' ? share.nonce.toLowerCase() : ''
    const result = share && typeof share.result === 'string' ? share.result.toLowerCase() : ''
    return `powsig:v2:${messageHash}:${timestamp}:${jobId}:${nonce}:${result}:${context}`
  }

  pow_auth_context_message(message) {
    const cipher = message && typeof message.cipher === 'string' ? message.cipher : ''
    return cipher
  }

  pow_auth_context_register(payload) {
    return payload && typeof payload.data === 'string' ? payload.data : ''
  }

  verify_pow_auth(messageHash, timestamp, pow, context = '') {
    if (!pow || typeof pow !== 'object') return { ok: false, reason: 'missing_pow' }
    const auth = pow.auth
    if (!auth || typeof auth !== 'object') return { ok: false, reason: 'missing_pow_auth' }
    const pub = typeof auth.pub === 'string' ? auth.pub.toLowerCase() : ''
    const sig = typeof auth.sig === 'string' ? auth.sig.toLowerCase() : ''
    const nonce = typeof auth.nonce === 'string' ? auth.nonce.toLowerCase() : ''
    if (!pub || !sig || !isHexString(pub) || !isHexString(sig)) return { ok: false, reason: 'invalid_pow_auth' }
    if (pub.length !== 64 || sig.length !== 128) return { ok: false, reason: 'invalid_pow_auth' }
    const shares = Array.isArray(pow.shares) ? pow.shares : []
    if (!shares.length) return { ok: false, reason: 'no_shares' }
    let share = shares[0]
    if (nonce) {
      const matched = shares.find((s) => s && typeof s.nonce === 'string' && s.nonce.toLowerCase() === nonce)
      if (!matched) return { ok: false, reason: 'pow_auth_nonce_mismatch' }
      share = matched
    }
    const payload = this.build_pow_sig_payload(messageHash, timestamp, share, context)
    const verified = Keychains.verify(Buffer.from(payload), Buffer.from(sig, 'hex'), Buffer.from(pub, 'hex'))
    if (!verified) return { ok: false, reason: 'invalid_pow_signature' }
    return { ok: true }
  }

  async cheap_pow(message, conn = null) {
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


    const ok = this.pow_check_fast(message)
    if (!ok) {
      logPow('pow_precheck', { status: 'reject', reason: 'fast_check_failed', jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      return POW_INVALID
    }

    const authCheck = this.verify_pow_auth(message.hash, message.timestamp, message.pow, this.pow_auth_context_message(message))
    if (!authCheck.ok) {
      logPow('pow_precheck', { status: 'reject', reason: authCheck.reason, jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      return { success: false, reason: authCheck.reason }
    }

    logPow('pow_precheck', { status: 'ok', jobId: message && message.pow && message.pow.job && message.pow.job.job_id, shares: shares.length })
    return MESSAGE_VERIFIED
  }

  // Cheap validation for register payloads (push token registration path).
  // Mirrors cheap_pow() but validates the packet-level shape:
  // { register: true, data: <encrypted payload>, hash, pow }.
  async cheap_pow_register(payload, conn = null) {
    if (!payload || typeof payload !== 'object') {
      logPow('pow_precheck_register', { status: 'reject', reason: 'wrong_message_format' })
      return WRONG_MESSAGE_FORMAT
    }
    if (payload.register !== true) {
      logPow('pow_precheck_register', { status: 'reject', reason: 'wrong_message_format' })
      return WRONG_MESSAGE_FORMAT
    }
    if (typeof payload.data !== 'string' || payload.data.length === 0) {
      logPow('pow_precheck_register', { status: 'reject', reason: 'wrong_message_format' })
      return WRONG_MESSAGE_FORMAT
    }
    const v = payload && payload.pow && typeof payload.pow.version === 'number'
      ? payload.pow.version
      : 1
    if (v !== POW_VERSION) {
      logPow('pow_precheck_register', { status: 'reject', reason: 'wrong_pow_version', v })
      return POW_INVALID
    }

    const ok = this.pow_check_fast_payload(payload.hash, payload.pow)
    if (!ok) {
      logPow('pow_precheck_register', {
        status: 'reject',
        reason: 'fast_check_failed',
        jobId: payload && payload.pow && payload.pow.job && payload.pow.job.job_id
      })
      return POW_INVALID
    }

    const shares = payload && payload.pow && Array.isArray(payload.pow.shares)
      ? payload.pow.shares
      : []
    const authCheck = this.verify_pow_auth(payload.hash, payload.timestamp, payload.pow, this.pow_auth_context_register(payload))
    if (!authCheck.ok) {
      logPow('pow_precheck_register', { status: 'reject', reason: authCheck.reason, jobId: payload && payload.pow && payload.pow.job && payload.pow.job.job_id })
      return { success: false, reason: authCheck.reason }
    }
    logPow('pow_precheck_register', {
      status: 'ok',
      jobId: payload && payload.pow && payload.pow.job && payload.pow.job.job_id,
      shares: shares.length
    })
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

  pool_login_for() {
    const login = this.payoutAddress
    if (!login.length && login.length !== 99) {
      console.log(chalk.red("No payout address set. Set it before starting..."))
      return ''
    }
    return login
  }

  connect_pool(pool) {
    if (this.poolConnector) {
      this.poolConnector.disconnect()
      this.poolConnector = null
    }
    const login = this.pool_login_for()
    if (!login) return

    const connector = new PoolConnector({
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
    this.poolConnector = connector
    const poolConnector = connector

    poolConnector.on('connected', () => {
      if (this.poolConnector !== poolConnector) return
      this.reset_pool_reconnect()
    })

    poolConnector.on('login', () => {
      if (this.poolConnector !== poolConnector) return
      this.reset_pool_reconnect()
    })

    poolConnector.on('job', (job) => {
      if (this.poolConnector !== poolConnector) return
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

    poolConnector.on('loginFailed', () => {
      if (this.poolConnector !== poolConnector) return
      this.maybe_switch_pool('login_failed')
    })

    // Prevent hard-crash on transient socket errors (e.g. ECONNRESET / lost internet)
    poolConnector.on('poolError', (err) => {
      if (this.poolConnector !== poolConnector) return
      const code = err && err.code ? String(err.code) : 'UNKNOWN'
      const msg = err && err.message ? String(err.message) : ''
      console.log(chalk.yellow(`Pool connection error: ${code}${msg ? ` (${msg})` : ''}`))
      const outageCodes = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND'])
      const switchCodes = new Set(['ECONNREFUSED'])

      if (switchCodes.has(code)) {
        this.maybe_switch_pool('pool_error', code)
        return
      }

      const isOutage = outageCodes.has(code)
      this.schedule_pool_reconnect(isOutage ? 'network_outage' : 'pool_error', code)
    })

    poolConnector.on('disconnected', () => {
      if (this.poolConnector !== poolConnector) return
      this.schedule_pool_reconnect('disconnected')
    })

    poolConnector.connect()
  }

  reset_pool_reconnect() {
    if (this.poolReconnectTimer) {
      clearTimeout(this.poolReconnectTimer)
      this.poolReconnectTimer = null
    }
  }

  schedule_pool_reconnect(reason, code = null) {
    if (this.poolReconnectTimer) return
    const delayMs = 2000
    logPow('pool_reconnect', { reason, code, delayMs })
    this.poolReconnectTimer = setTimeout(() => {
      this.poolReconnectTimer = null
      if (!POOLS.length) return
      const currentPool = POOLS[this.poolIndex]
      if (currentPool) this.connect_pool(currentPool)
    }, delayMs)
  }

  maybe_switch_pool(reason, code = null) {
    const now = this.nowMs()
    // 2s throttle (connect_pool already has a 2s delay)
    if ((now - this.lastPoolSwitchAt) < 2000) return
    this.lastPoolSwitchAt = now
    logPow('pool_failover', { reason, code, nextIndex: (this.poolIndex + 1) % (POOLS.length || 1) })
    this.next_pool()
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

      const pre = await this.cheap_pow(message, null)
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
        if (!this.rate_limit_request('job_request', conn, info, data && data.id)) return
        logPow('client_cmd', { client_id, type: 'job_request' })
        this.job_request(conn, data)
        return
      }
      if (data.type === 'pow_tag') {
        // Backward-compatible no-op: challenge flow removed.
        this.send(conn, { success: true, id: data && data.id })
        return
      }
      if (data.type === 'register') {
        await this.client_register(data, info, conn)
        return
      }
      if (data.type === 'post') {
        logPow('client_cmd', { client_id, type: 'post', id: data && data.message && data.message.id })
        await this.client_post(data, info, conn)
        return
      } else {
        console.log(chalk.red("Unknown client request type"))
        this.send(conn, { success: false, reason: 'unknown_type', id: data && data.id })
        return
      }
     }

     if ('register' in data) {
      await this.client_register(data, info, conn)
      return
     }

  }

  async client_register(data, info, conn) {
    const client_id = this.client_id(conn)
    const now = this.nowMs()
    const id = typeof data.id === 'number' ? data.id : data.timestamp

    const lastAccepted = this.clientPostLastAcceptedAt.get(conn) || 0
    if ((now - lastAccepted) < CLIENT_POST_COOLDOWN_MS) {
      logPow('client_register', { status: 'reject', reason: 'cooldown', client_id, id })
      this.send(conn, { success: false, reason: 'cooldown', id })
      return
    }

    if (this.has_accepted_pow_auth(data && data.hash, data && data.pow)) {
      logPow('client_register', { status: 'duplicate', client_id, id })
      this.send(conn, { success: true, duplicate: true, id })
      return
    }

    const pre = await this.cheap_pow_register(data, conn)
    if (!pre.success) {
      const strikes = (this.clientInvalidShareStrikes.get(conn) || 0) + 1
      this.clientInvalidShareStrikes.set(conn, strikes)
      logPow('client_register', { status: 'reject', reason: pre.reason, client_id, strikes, id, jobId: data && data.pow && data.pow.job && data.pow.job.job_id })
      this.send(conn, { reason: pre.reason, success: false, id })
      if (strikes >= 2) {
        this.network.ban(info, conn)
      }
      return
    }

    const shares = data && data.pow && Array.isArray(data.pow.shares) ? data.pow.shares : []
    const submitRes = await this.submit_message_shares_with_reauth(shares, this.poolConnector)
    const accepted = submitRes.accepted
    const rejects = submitRes.rejects

    if (!accepted) {
      logPow('client_register', { status: 'reject', reason: 'pool_reject', client_id, id, jobId: data && data.pow && data.pow.job && data.pow.job.job_id, rejects })
      this.send(conn, { reason: 'pool_reject', success: false, id, rejects })
      if (this.poolJob) {
        try {
          this.send(conn, { type: 'job', job: this.poolJob })
        } catch (_) {}
      }
      return
    }

    this.clientPostLastAcceptedAt.set(conn, now)
    this.clientInvalidShareStrikes.delete(conn)
    this.mark_accepted_pow_auth(data && data.hash, data && data.pow)
    this.send(conn, { success: true, id })
    this.network.notify(data)
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

    if (this.has_accepted_pow_auth(message && message.hash, message && message.pow)) {
      logPow('client_post', { status: 'duplicate', client_id, id: message && message.id })
      this.send(conn, { success: true, duplicate: true, id: message && message.id })
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
    const pre = await this.cheap_pow(message, conn)
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
    const submitRes = await this.submit_message_shares_with_reauth(shares, this.poolConnector)
    const accepted = submitRes.accepted
    const rejects = submitRes.rejects
    if (POW_DEBUG) {
      logPow('pool_submit_timing', { ms: this.hrtimeMs(tPool), ok: accepted, rejects })
    }
    if (!accepted) {
      // Pool reject can happen on stale jobs (race between compute and submit).
      // Don't insta-ban; instead, push latest job so client can retry quickly.
      logPow('client_post', { status: 'reject', reason: 'pool_reject', client_id, id: message && message.id, jobId: message && message.pow && message.pow.job && message.pow.job.job_id, rejects })
      this.send(conn, { reason: 'pool_reject', success: false, id: message && message.id, rejects })
      if (this.poolJob) {
        try {
          this.send(conn, { type: 'job', job: this.poolJob })
        } catch (_) {}
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
    if (added.duplicate) {
      logPow('client_post', { status: 'duplicate', client_id, id: message && message.id })
      this.send(conn, { success: true, duplicate: true, id: message && message.id })
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
    if (add.duplicate) return add
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
    if (this.pool.has(message.hash)) return { ...MESSAGE_VERIFIED, duplicate: true }
    if (typeof message.timestamp !== 'number') {
      message.timestamp = Date.now()
    }

    //Verify and add message to pool.
    const verify = verified ? MESSAGE_VERIFIED : await this.verify(message)
    if (!verify.success) return verify
    this.pool.set(message.hash, message);
    this.mark_accepted_pow_auth(message.hash, message.pow)
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
    if (typeof message.timestamp !== 'number') return false
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
    if (message.timestamp < 0) return false
    if (message.pow.shares.length > MAX_SHARES_PER_MESSAGE) return false
    const now = Date.now()
    if (message.timestamp > (now + MAX_MESSAGE_FUTURE_MS)) return false
    if (message.timestamp < (now - MAX_MESSAGE_PAST_MS)) return false

    return true
  }

  validate_pow_payload(messageHash, pow, { requireFreshTemplate = true, prevIds = null } = {}) {
    if (!this.poolConnector) return { ok: false, reason: 'no_pool_connector' }
    const job = pow && pow.job
    const shares = pow && Array.isArray(pow.shares) ? pow.shares : []
    if (typeof messageHash !== 'string' || messageHash.length !== 64 || !isHexString(messageHash)) {
      return { ok: false, reason: 'invalid_hash' }
    }
    if (!job || typeof job !== 'object') return { ok: false, reason: 'invalid_job' }
    if (typeof job.job_id !== 'string' || job.job_id.length > 32) return { ok: false, reason: 'invalid_job_id' }
    if (!isHexString(job.blob)) return { ok: false, reason: 'invalid_blob' }
    if (job.blob.length % 2 !== 0) return { ok: false, reason: 'invalid_blob_len' }
    if ((job.blob.length / 2) > MAX_JOB_BLOB_HEX_BYTES) return { ok: false, reason: 'blob_too_large' }
    if (!isHexString(job.target) || job.target.length !== 8) return { ok: false, reason: 'invalid_target' }
    if (!Array.isArray(shares) || shares.length === 0) return { ok: false, reason: 'no_shares' }
    if (shares.length > MAX_SHARES_PER_MESSAGE) return { ok: false, reason: 'too_many_shares' }

    const prevId = extractPrevIdFromBlob(job.blob)
    if (!prevId) return { ok: false, reason: 'no_prev_id', job, shares }
    const state = prevIds || {
      currentPrevId: this.currentPrevId,
      previousPrevId: this.previousPrevId,
      twoBackPrevId: this.twoBackPrevId
    }
    if (requireFreshTemplate && !state.currentPrevId) {
      return { ok: false, reason: 'no_current_prev_id', job, shares }
    }
    if (
      requireFreshTemplate &&
      prevId !== state.currentPrevId &&
      prevId !== state.previousPrevId &&
      prevId !== state.twoBackPrevId
    ) {
      return { ok: false, reason: 'prev_id_mismatch', job, shares, prevId }
    }

    return {
      ok: true,
      job,
      shares: shares.slice(0, MAX_SHARES_PER_MESSAGE),
      prevId
    }
  }

  validate_share_fast(share, jobId) {
    if (!share || share.job_id !== jobId) return { ok: false, reason: 'job_id_mismatch' }
    if (typeof share.nonce !== 'string' || share.nonce.length !== 8 || !isHexString(share.nonce)) {
      return { ok: false, reason: 'bad_nonce' }
    }
    if (typeof share.result !== 'string' || share.result.length !== 64 || !isHexString(share.result)) {
      return { ok: false, reason: 'bad_result' }
    }
    return { ok: true }
  }

  // Cheap local checks only (no slow hash).
  // Used for client -> node precheck before pool submission.
  pow_check_fast(message, prevIds = null) {
    const validated = this.validate_pow_payload(message.hash, message.pow, { requireFreshTemplate: true, prevIds })
    if (!validated.ok) {
      logPow('pow_check_fast', { status: 'reject', reason: validated.reason, jobId: validated.job && validated.job.job_id })
      return false
    }

    const { job, shares } = validated
    let jobIdMismatch = 0
    let badNonce = 0
    let badResult = 0
    for (const share of shares) {
      const check = this.validate_share_fast(share, job.job_id)
      if (!check.ok && check.reason === 'job_id_mismatch') {
        jobIdMismatch++
        continue
      }
      if (!check.ok && check.reason === 'bad_nonce') {
        badNonce++
        continue
      }
      if (!check.ok && check.reason === 'bad_result') {
        badResult++
        continue
      }
      logPow('pow_check_fast', { status: 'ok', jobId: job.job_id })
      return true
    }
    logPow('pow_check_fast', { status: 'reject', reason: 'no_matching_share', jobId: job.job_id, counts: { jobIdMismatch, badNonce, badResult }, total: shares.length })
    return false
  }

  pow_check_fast_payload(messageHash, pow, prevIds = null) {
    const validated = this.validate_pow_payload(messageHash, pow, { requireFreshTemplate: true, prevIds })
    if (!validated.ok) {
      logPow('pow_check_fast', { status: 'reject', reason: validated.reason, jobId: validated.job && validated.job.job_id })
      return false
    }

    const { job, shares } = validated
    let jobIdMismatch = 0
    let badNonce = 0
    let badResult = 0
    for (const share of shares) {
      const check = this.validate_share_fast(share, job.job_id)
      if (!check.ok && check.reason === 'job_id_mismatch') {
        jobIdMismatch++
        continue
      }
      if (!check.ok && check.reason === 'bad_nonce') {
        badNonce++
        continue
      }
      if (!check.ok && check.reason === 'bad_result') {
        badResult++
        continue
      }
      logPow('pow_check_fast', { status: 'ok', jobId: job.job_id })
      return true
    }
    logPow('pow_check_fast', { status: 'reject', reason: 'no_matching_share', jobId: job.job_id, counts: { jobIdMismatch, badNonce, badResult }, total: shares.length })
    return false
  }

  // Node-to-node gossip check: validate message/share shapes.
  // Does NOT check prev_id freshness against our pool template (nodes can use different pools/templates).
  async pow_check_gossip(message) {
    if (!message || !message.pow) return false
    const authCheck = this.verify_pow_auth(message.hash, message.timestamp, message.pow, this.pow_auth_context_message(message))
    if (!authCheck.ok) return false
    const validated = this.validate_pow_payload(message.hash, message.pow, { requireFreshTemplate: false })
    if (!validated.ok) return false
    const { job, shares: cappedShares } = validated
    const candidates = []
    for (const share of cappedShares) {
      const check = this.validate_share_fast(share, job.job_id)
      if (!check.ok) continue
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
    const authCheck = this.verify_pow_auth(message.hash, message.timestamp, message.pow, this.pow_auth_context_message(message))
    if (!authCheck.ok) {
      logPow('pow_check_stale', { reason: authCheck.reason, jobId: message && message.pow && message.pow.job && message.pow.job.job_id })
      return false
    }
    const validated = this.validate_pow_payload(message.hash, message.pow, { requireFreshTemplate: true })
    if (!validated.ok) {
      logPow('pow_check_stale', { reason: validated.reason, jobId: validated.job && validated.job.job_id })
      return false
    }

    const { job, shares: cappedShares } = validated
    const required = this.pow_target(message.hash)
    
    // Slow verification (random-sampled)
    let valid = 0
    const toCheck = cappedShares.length
      ? [cappedShares[Math.floor(Math.random() * cappedShares.length)]]
      : []
    let checked = 0
    let jobIdMismatch = 0
    let badNonce = 0
    let badResult = 0
    let verifyFail = 0
    for (const share of toCheck) {
      checked++
      const check = this.validate_share_fast(share, job.job_id)
      if (!check.ok && check.reason === 'job_id_mismatch') {
        jobIdMismatch++
        continue
      }
      if (!check.ok && check.reason === 'bad_nonce') {
        badNonce++
        continue
      }
      if (!check.ok && check.reason === 'bad_result') {
        badResult++
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
      total: cappedShares.length,
      checked,
      counts: { jobIdMismatch, badNonce, badResult, verifyFail }
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