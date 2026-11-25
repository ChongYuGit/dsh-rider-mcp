/**
 * Rider MCP, isolated per conversation.
 *
 * Each Agent gets its own mcp-client Fiber under the public name `rider`.
 * Consequently mcp__rider__* can target project A in one session and project B
 * in another; no process-global Rider registration remains. The badge's routes
 * always take `?session=<SessionId>` and operate only on that session's Fiber.
 *
 * The composition config supplies initial defaults. Session choices and their
 * disconnected state live in rider-mcp.sessions.json beside the active profile,
 * so switching a session neither rewrites cordis.patch.yml nor reloads the
 * plugin. Rider is contacted over streamable-http; DSH does not use its /sse
 * endpoint. With an empty projectPath no IJ_MCP_SERVER_PROJECT_PATH header is
 * sent and each tool call selects an open project through rootFolder.
 */

import { fileURLToPath } from 'node:url'
import { createSessionRuntime } from './session-runtime.js'

const SERVER_NAME = 'rider'
const SERVER_URL = 'http://127.0.0.1:64482/stream'
const PROJECT_PATH_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH'
const TOOL_CALL_TIMEOUT_MS = 300000
const ROUTE_PREFIX = '/rider-mcp'
const CLIENT_TOOL_PREFIX = 'mcp__rider__'
const RECENT_LIMIT = 64
const DEFAULT_ORIGIN = 'http://localhost'
const PROBE_TIMEOUT_MS = 4000
const BODY_LIMIT_BYTES = 64 * 1024

export const name = 'rider-mcp'
export const inject = []

export async function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const runtime = await createSessionRuntime(ctx, {
    serverName: SERVER_NAME,
    storageFile: fileURLToPath(new URL('rider-mcp.sessions.json', ctx.baseUrl)),
    defaults: {
      url: typeof settings.url === 'string' && settings.url !== '' ? settings.url : SERVER_URL,
      projectPath: typeof settings.projectPath === 'string' ? settings.projectPath.trim() : '',
      toolCallTimeoutMs: Number.isFinite(settings.toolCallTimeoutMs) ? settings.toolCallTimeoutMs : TOOL_CALL_TIMEOUT_MS,
    },
    normalize: normalizeSettings,
    makeConfig(value) {
      return {
        serverName: SERVER_NAME,
        transport: 'streamable-http',
        url: value.url,
        ...(value.projectPath === '' ? {} : { headers: { [PROJECT_PATH_HEADER]: value.projectPath } }),
        toolCallTimeoutMs: value.toolCallTimeoutMs,
        failOnStartupError: false,
      }
    },
    snapshot(value) {
      return {
        url: value.url,
        projectMode: value.projectPath === '' ? 'per-call' : 'pinned',
        ...(value.projectPath === '' ? {} : { projectPath: value.projectPath }),
      }
    },
  })

  // Tool arguments never come back from Rider, so remember the project named by
  // this session's own tool/call event for the badge tooltip.
  const recent = new Map()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') return
    if (typeof event.name !== 'string' || !event.name.startsWith(CLIENT_TOOL_PREFIX)) return
    const rootFolder = rootFolderOf(event.arguments)
    if (rootFolder === '') return
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '') return
    recent.delete(sessionId)
    recent.set(sessionId, { rootFolder, tool: event.name.slice(CLIENT_TOOL_PREFIX.length), at: Date.now() })
    while (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value)
  }), 'rider-mcp: recent tool-call project')

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const server = scope.get('webServer')
      if (server === undefined) return () => undefined
      return server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          void handleRoute(runtime, recent, req, res).catch((error) => {
            sendJson(res, 500, { ok: false, error: 'request-failed', message: error instanceof Error ? error.message : String(error) })
          })
        },
      })
    }, 'rider-mcp: session badge routes')
  })
}

function normalizeSettings(value) {
  return {
    url: typeof value.url === 'string' && value.url.trim() !== '' ? value.url.trim() : SERVER_URL,
    projectPath: typeof value.projectPath === 'string' ? value.projectPath.trim() : '',
    toolCallTimeoutMs: Number.isFinite(value.toolCallTimeoutMs) ? value.toolCallTimeoutMs : TOOL_CALL_TIMEOUT_MS,
  }
}

async function handleRoute(runtime, recent, req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin-denied' })
    return
  }
  const request = new URL(req.url ?? '/', DEFAULT_ORIGIN)
  const sessionId = request.searchParams.get('session')?.trim() ?? ''
  const sub = request.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const snapshot = () => withRecent(runtime.snapshot(sessionId), recent.get(sessionId))

  if (req.method === 'GET' && (sub === '' || sub === 'status')) {
    sendJson(res, 200, snapshot())
    return
  }
  if (req.method === 'GET' && sub === 'projects') {
    const settings = runtime.settings(sessionId)
    const probe = await probeOpenProjects(settings.url)
    sendJson(res, 200, {
      ok: true,
      url: settings.url,
      projectMode: settings.projectPath === '' ? 'per-call' : 'pinned',
      ...(settings.projectPath === '' ? {} : { projectPath: settings.projectPath }),
      projects: probe.projects,
      ...(probe.note === '' ? {} : { note: probe.note }),
    })
    return
  }
  if (req.method === 'POST' && ['restart', 'project', 'connection'].includes(sub) && sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'session-required', message: 'append ?session=<SessionId>' })
    return
  }
  if (req.method === 'POST' && sub === 'restart') {
    sendJson(res, 200, withRecent(await runtime.restart(sessionId), recent.get(sessionId)))
    return
  }
  if (req.method === 'POST' && sub === 'project') {
    const body = await readJsonBody(req)
    if (body === null || typeof body.projectPath !== 'string') {
      sendJson(res, 400, { ok: false, error: 'invalid-project', message: 'expected { projectPath: string }' })
      return
    }
    sendJson(res, 200, withRecent(await runtime.update(sessionId, { projectPath: body.projectPath }), recent.get(sessionId)))
    return
  }
  if (req.method === 'POST' && sub === 'connection') {
    const body = await readJsonBody(req)
    if (body === null || typeof body.connected !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'invalid-connection', message: 'expected { connected: boolean }' })
      return
    }
    sendJson(res, 200, withRecent(await runtime.setConnected(sessionId, body.connected), recent.get(sessionId)))
    return
  }
  if (sub === '' || sub === 'status' || sub === 'projects' || sub === 'restart' || sub === 'project' || sub === 'connection') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  sendJson(res, 404, { ok: false, error: 'not-found' })
}

function withRecent(snapshot, last) {
  if (last === undefined) return snapshot
  return { ...snapshot, lastRootFolder: last.rootFolder, lastRootFolderTool: last.tool, lastRootFolderAt: last.at }
}

/** Ask Rider which projects are open through a throwaway, header-free session. */
async function probeOpenProjects(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const initialized = await rpcPost(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rider-mcp-badge', version: '1.0.0' } },
    }, '', controller?.signal)
    if (initialized.status !== 200) return { projects: [], note: `initialize failed (${initialized.status})` }
    const session = initialized.sessionId
    await rpcPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, controller?.signal)
    const called = await rpcPost(url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_all_open_file_paths', arguments: {} },
    }, session, controller?.signal)
    const projects = projectPathsOf(called.text)
    return { projects, note: projects.length === 0 ? 'no open projects reported' : '' }
  } catch (error) {
    return { projects: [], note: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function rpcPost(url, payload, session, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session === '' ? {} : { 'mcp-session-id': session }),
    },
    body: JSON.stringify(payload),
    ...(signal === undefined || signal === null ? {} : { signal }),
  })
  return { status: response.status, sessionId: response.headers.get('mcp-session-id') ?? '', text: await response.text() }
}

/** Rider nests the open-project list as JSON text inside the JSON-RPC result. */
function projectPathsOf(text) {
  const projects = []
  const seen = new Set()
  const pattern = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  for (const payload of parsePayloads(text)) {
    for (const string of stringsOf(payload)) {
      let match = pattern.exec(string)
      while (match !== null) {
        const path = decodeJsonString(match[1]).trim()
        if (path !== '' && !seen.has(path)) {
          seen.add(path)
          projects.push(path)
        }
        match = pattern.exec(string)
      }
      pattern.lastIndex = 0
    }
  }
  return projects
}

function parsePayloads(text) {
  try { return [JSON.parse(text)] } catch {
    const payloads = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const body = trimmed.slice(5).trim()
      if (body === '' || body === '[DONE]') continue
      try { payloads.push(JSON.parse(body)) } catch { /* ignore incomplete SSE lines */ }
    }
    return payloads
  }
}

function stringsOf(value, out = []) {
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const item of value) stringsOf(item, out); return out }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringsOf(item, out)
  }
  return out
}

function decodeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`) } catch { return '' }
}

function rootFolderOf(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return ''
    return typeof parsed.rootFolder === 'string' ? parsed.rootFolder.trim() : ''
  } catch { return '' }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) return null
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
