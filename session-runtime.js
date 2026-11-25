/**
 * Per-agent MCP client runtime shared by the local connection badges.
 *
 * A server name is reused deliberately: Cordis scopes the registration and the
 * tool namespace to each Agent, so mcp__rider__* in session A and session B can
 * belong to different connections without shadowing one another.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const STATUS_FIELDS = ['toolCount', 'connectedAt', 'attempt', 'maxAttempts', 'nextRetryAtMs', 'lastError', 'reason']

/**
 * Mount one mcp-client instance per Agent and keep each session's target in a
 * small profile-local JSON file. The composition config supplies defaults only;
 * session changes never rewrite cordis.patch.yml or restart this plugin.
 */
export async function createSessionRuntime(ctx, options) {
  const mcpClient = await ctx.loader.internal.import('@deepseek-ai/dsh-mcp-client', ctx.baseUrl, {})
  const log = ctx.logger(`${options.serverName}-sessions`)
  const normalize = options.normalize ?? (value => value)
  const defaults = Object.freeze(normalize(options.defaults ?? {}))
  const saved = await readStore(options.storageFile)
  const records = new Map()
  let agents
  let disposed = false
  let writeQueue = Promise.resolve()

  const findAgent = sessionId => agents?.list().find(agent => agent.id === sessionId)

  function ensureRecord(sessionId) {
    let record = records.get(sessionId)
    if (record !== undefined) return record
    const entry = saved[sessionId]
    record = {
      sessionId,
      settings: normalize({ ...defaults, ...(entry?.settings ?? {}) }),
      paused: entry?.paused === true,
      agent: findAgent(sessionId),
      fiber: undefined,
      handle: undefined,
      queue: Promise.resolve(),
      lastError: '',
    }
    records.set(sessionId, record)
    return record
  }

  function enqueue(record, operation) {
    const result = record.queue.then(operation, operation)
    record.queue = result.then(() => undefined, () => undefined)
    return result
  }

  function persist() {
    const body = JSON.stringify({ version: 1, sessions: saved }, null, 2) + '\n'
    const task = writeQueue.then(() => writeStore(options.storageFile, body))
    writeQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async function disconnect(record) {
    const fiber = record.fiber
    record.fiber = undefined
    record.handle = undefined
    if (fiber === undefined) return
    try {
      await Promise.resolve(fiber.dispose())
    } catch (error) {
      record.lastError = messageOf(error)
      log.warn('disposing %s failed: %s', record.sessionId, record.lastError)
    }
  }

  async function connect(record) {
    await disconnect(record)
    if (disposed || record.paused || record.agent === undefined) return
    try {
      const fiber = record.agent.ctx.plugin(mcpClient, options.makeConfig(record.settings))
      record.fiber = fiber
      // The status cell is registered by the instance during startup, so it is
      // only readable once the fiber has resolved. Reading it before the await
      // returns undefined and the badge would stay "connecting" forever.
      await Promise.resolve(fiber)
      record.handle = mcpClient.connectionStatusOf(fiber)
    } catch (error) {
      // failOnStartupError is false, so this normally means invalid local
      // configuration or disposal during startup, not an unreachable editor.
      record.lastError = messageOf(error)
      log.warn('connecting %s failed: %s', record.sessionId, record.lastError)
    }
  }

  function snapshot(sessionId) {
    const record = ensureRecord(sessionId)
    const snapshot = {
      ok: true,
      server: options.serverName,
      at: Date.now(),
      ...options.snapshot(record.settings),
      paused: record.paused,
    }
    if (record.paused) return { ...snapshot, state: 'disabled', configured: false }
    const status = record.handle?.current()
    if (status === undefined) {
      return {
        ...snapshot,
        state: record.agent === undefined ? 'unregistered' : 'connecting',
        configured: false,
        ...(record.lastError === '' ? {} : { lastError: record.lastError }),
      }
    }
    for (const field of STATUS_FIELDS) {
      if (status[field] !== undefined) snapshot[field] = status[field]
    }
    snapshot.state = status.state
    snapshot.configured = record.fiber !== undefined
    if (status.state === 'closed') snapshot.closeConfirmed = record.handle.closure().closeConfirmed === true
    return snapshot
  }

  async function attach(agent) {
    if (disposed || typeof agent?.id !== 'string') return
    const record = ensureRecord(agent.id)
    record.agent = agent
    await enqueue(record, async () => {
      record.agent = agent
      if (!record.paused && record.fiber === undefined) await connect(record)
    })
  }

  function detach(agent) {
    const record = records.get(agent?.id)
    if (record === undefined) return
    record.agent = undefined
    record.fiber = undefined
    record.handle = undefined
  }

  async function update(sessionId, patch) {
    const record = ensureRecord(sessionId)
    return enqueue(record, async () => {
      record.settings = normalize({ ...record.settings, ...patch })
      record.paused = false
      record.lastError = ''
      saved[sessionId] = { settings: record.settings, paused: false }
      const persisted = await persist()
      await connect(record)
      return { ...snapshot(sessionId), persisted }
    })
  }

  async function setConnected(sessionId, connected) {
    const record = ensureRecord(sessionId)
    return enqueue(record, async () => {
      record.paused = !connected
      record.lastError = ''
      saved[sessionId] = { settings: record.settings, paused: record.paused }
      const persisted = await persist()
      if (connected) await connect(record)
      else await disconnect(record)
      return { ...snapshot(sessionId), persisted }
    })
  }

  async function restart(sessionId) {
    const record = ensureRecord(sessionId)
    return enqueue(record, async () => {
      record.lastError = ''
      await connect(record)
      return snapshot(sessionId)
    })
  }

  async function dispose() {
    disposed = true
    await Promise.all([...records.values()].map(record => enqueue(record, () => disconnect(record))))
    await writeQueue
  }

  ctx.inject(['agentPresets', 'agents', 'tools'], (presetCtx) => {
    presetCtx.effect(() => {
      agents = presetCtx.agents
      const offCreated = presetCtx.on('agent/created', ({ agent }) => {
        void attach(agent).catch(error => log.warn('attaching %s failed: %s', agent?.id, messageOf(error)))
      })
      const offDisposed = presetCtx.on('agent/disposed', ({ agent }) => detach(agent))
      for (const agent of agents.list()) {
        void attach(agent).catch(error => log.warn('attaching %s failed: %s', agent?.id, messageOf(error)))
      }
      return async () => {
        offCreated()
        offDisposed()
        agents = undefined
        await dispose()
      }
    }, `${options.serverName}: per-session MCP clients`)
  })

  return {
    snapshot,
    update,
    setConnected,
    restart,
    settings(sessionId) { return { ...ensureRecord(sessionId).settings } },
    attach,
    detach,
    dispose,
  }
}

async function readStore(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object'
      ? parsed.sessions
      : {}
  } catch {
    return {}
  }
}

async function writeStore(file, body) {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, file)
    return true
  } catch {
    try { await writeFile(file, body, 'utf8'); return true } catch { return false }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
