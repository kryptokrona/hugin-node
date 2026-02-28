/**
 * Pools module: configured pool list + pool connector implementation.
 *
 * Merged from previous `poolConfig.js` and `poolConnector.js` so consumers can:
 *   const { POOLS, PoolConnector } = require('./pools')
 */
const net = require('net')
const tls = require('tls')
const EventEmitter = require('bare-events')
const { Crypto } = require('kryptokrona-utils')
const { insertNonce, meetsTarget } = require('hugin-utils')
const { DEFAULT_POOL_PORT, DEFAULT_POOL_SSL, POW_DEBUG } = require('./constants')

const crypto = new Crypto()

const logPow = (...args) => {
  if (POW_DEBUG) {
    console.log('[pow]', ...args)
  }
}

// ---- Pool list config ----

const POOL_HOSTS = [
  'techypool.ddns.net',
  'pool-pay.com',
  'fastpool.xyz',
  'pool-pay.com',
  'kalf.org'
]

function parsePoolHost(value) {
  if (!value) return null
  if (value.includes(':')) {
    const [host, port] = value.split(':')
    return {
      host,
      port: parseInt(port, 10),
      ssl: DEFAULT_POOL_SSL
    }
  }
  return {
    host: value,
    port: DEFAULT_POOL_PORT,
    ssl: DEFAULT_POOL_SSL
  }
}

const POOLS = POOL_HOSTS.map(parsePoolHost).filter(Boolean)

// ---- Pool connector (stratum-ish JSON-RPC) ----

function createMessage(id, method, params) {
  return (
    JSON.stringify({
      id,
      jsonrpc: '2.0',
      method,
      params
    }) + '\n'
  )
}

class PoolConnector extends EventEmitter {
  constructor(options) {
    super()
    this.options = options || {}
    this.socket = null
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.session = { id: null, job: null }
    this.validJobs = []
    this.cn = crypto.cn_turtle_lite_slow_hash_v2
    this.reauthInFlight = false
  }

  connect() {
    const host = this.options.host
    const port = this.options.port
    const ssl = !!this.options.ssl
    const socket = ssl ? tls.connect({ host, port }) : net.connect({ host, port })
    this.socket = socket
    socket.setEncoding('utf8')
    socket.setKeepAlive(true)

    socket.on('connect', () => {
      this.emit('connected')
      logPow('pool_connected', { host, port, ssl })
      this.login()
    })

    socket.on('data', (data) => {
      this.buffer += data
      let newlineIndex
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex)
        this.buffer = this.buffer.slice(newlineIndex + 1)
        if (!line.trim()) continue
        this.handleMessage(line)
      }
    })

    socket.on('error', (err) => {
      logPow('pool_error', { code: err && err.code, message: err && err.message })
      this.emit('poolError', err)
      // Do NOT emit the special 'error' event here.
      // Emitting 'error' without a listener can hard-crash the process; consumers
      // should use 'poolError' to decide whether to reconnect / failover / exit.
    })

    socket.on('close', () => {
      logPow('pool_disconnected')
      this.buffer = ''
      this.pending.clear()
      this.session.id = null
      this.emit('disconnected')
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.end()
      this.socket.destroy()
      this.socket = null
    }
    this.buffer = ''
    this.pending.clear()
    this.session.id = null
    this.session.job = null
  }

  login() {
    if (this.reauthInFlight) return
    this.reauthInFlight = true
    const login = this.options.login
    const pass = this.options.pass || 'x'
    const agent = this.options.agent || 'hugin-node'

    this.send('login', { login, pass, agent }, (error, result) => {
      this.reauthInFlight = false
      if (error || !result || !result.id) {
        logPow('pool_login_failed', { error: error && error.message })
        this.emit('loginFailed', error || new Error('login failed'))
        return
      }
      logPow('pool_login_ok', { id: result.id })
      this.session.id = result.id
      if (result.job) {
        this.onJob(result.job)
      }
      this.emit('login', result)
    })
  }

  send(method, params, callback) {
    if (!this.socket || !this.socket.writable) {
      if (callback) {
        process.nextTick(() => callback(new Error('socket_not_writable'), null))
      }
      return false
    }
    const id = this.nextId++
    if (callback) {
      this.pending.set(id, callback)
    }
    try {
      this.socket.write(createMessage(id, method, params))
      return true
    } catch (err) {
      if (callback) {
        this.pending.delete(id)
        process.nextTick(() => callback(err, null))
      }
      return false
    }
  }

  handleMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch (err) {
      this.emit('parseError', err)
      return
    }

    if (message.id && this.pending.has(message.id)) {
      const callback = this.pending.get(message.id)
      this.pending.delete(message.id)
      callback(message.error || null, message.result)
      return
    }

    if (message.method === 'job' && message.params) {
      this.onJob(message.params)
    }
  }

  onJob(job) {
    this.session.job = job
    this.validJobs.push(job.job_id)
    if (this.validJobs.length > 8) {
      this.validJobs.shift()
    }
    logPow('pool_job', { jobId: job.job_id, target: job.target })
    this.emit('job', job)
  }

  async verifyShare(job, nonce, result) {
    try {
      if (!job || !job.blob || !nonce || !result) return false
      if (!/^[0-9a-fA-F]{8}$/.test(nonce)) return false

      const { blobHex, offset } = insertNonce(job.blob, nonce)
      logPow('nonce_offset', { jobId: job.job_id, offset })
      const hashHex = await crypto.cn_turtle_lite_slow_hash_v2(blobHex)

      if (hashHex !== result) {
        logPow('share_mismatch', { jobId: job.job_id, nonce })
        return false
      }

      const ok = meetsTarget(hashHex, job.target)
      if (!ok) {
        logPow('share_low_diff', { jobId: job.job_id, nonce })
      }
      return ok
    } catch (err) {
      logPow('verify_share_error', { code: err && err.code, message: err && err.message })
      return false
    }
  }

  async submitShare(share) {
    if (!share || !share.job_id || !share.nonce || !share.result) {
      return { ok: false, reason: 'invalid_share' }
    }
    if (!this.session.id) return { ok: false, reason: 'not_logged_in' }
    if (this.validJobs.indexOf(share.job_id) === -1) {
      return { ok: false, reason: 'stale_job' }
    }

    return await new Promise((resolve) => {
      const sent = this.send(
        'submit',
        {
          id: this.session.id,
          job_id: share.job_id,
          nonce: share.nonce,
          result: share.result
        },
        (error, result) => {
          if (error) {
            const errorText = String(
              (error && (error.message || error.code)) || error
            )
            if (/unauthenticated/i.test(errorText)) {
              // Pool lost our auth/session; clear and re-login.
              this.session.id = null
              this.emit('unauthenticated', { error })
              if (this.socket && this.socket.writable) {
                this.login()
              }
            }
            this.emit('shareRejected', { reason: 'pool', error, share })
            logPow('share_reject', { reason: 'pool', jobId: share.job_id })
            return resolve({ ok: false, reason: 'pool', error })
          }
          this.emit('shareAccepted', { result, share })
          logPow('share_accept', { jobId: share.job_id })
          return resolve({ ok: true, result })
        }
      )
      if (!sent) {
        return resolve({ ok: false, reason: 'socket_not_writable' })
      }
    })
  }

  keepAlive() {
    if (!this.session.id) return
    this.send('keepalived', { id: this.session.id })
  }
}

module.exports = {
  DEFAULT_POOL_PORT,
  DEFAULT_POOL_SSL,
  POOLS,
  PoolConnector
}

