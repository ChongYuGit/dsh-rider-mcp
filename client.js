/**
 * Rider MCP badge: shows the live MCP connection state in the composer and
 * opens a small panel that switches the project the tools act on.
 *
 * The Host half owns the server registration, serves the status snapshot and
 * exposes the projects currently open in Rider, so this entry only polls and
 * renders. Clicking the badge opens the panel; the panel offers "per call"
 * (no pinned project), every open project it discovered, and a free-text path.
 * Applying a project re-creates only this conversation's MCP Fiber, so another
 * session keeps its own project and connected/disconnected state.
 *
 * The seat is session-scoped, so the injected `sessionId` selects both the poll
 * snapshot and the panel mutation target; the last project also feeds the tone, which only
 * turns green once a project is known. Text comes from the Client locale
 * service.
 */

window.__ModuleLoader__.load({
  id: 'dsh-rider-mcp',
  factory(require) {
    const react = require('react')
    const h = react.createElement

    const NS = 'rider-mcp'
    const ENTRY_ID = 'rider-mcp.status'
    const STATUS_PATH = '/rider-mcp/status'
    const PROJECTS_PATH = '/rider-mcp/projects'
    const PROJECT_PATH = '/rider-mcp/project'
    const CONNECTION_PATH = '/rider-mcp/connection'
    const RESTART_PATH = '/rider-mcp/restart'
    const POLL_INTERVAL_MS = 2000
    const REQUEST_TIMEOUT_MS = 4000
    const sessionPath = (path, sessionId) => sessionId === '' ? path : `${path}?session=${encodeURIComponent(sessionId)}`
    const PANEL_WIDTH = 340
    const PANEL_MAX_HEIGHT = 380

    /** Seats in preference order; the first declared one renders the badge. */
    const SEATS = [
      { name: 'conversation.input.left', order: 40 },
      { name: 'conversation.input.right', order: 40 },
      { name: 'conversation.input.dock', order: 40 },
    ]

    const COPY = {
      zh: {
        name: 'Rider MCP',
        'state.connected': '已连接',
        'state.connecting': '连接中',
        'state.reconnecting': '重连中',
        'state.waiting-credentials': '等待凭据',
        'state.failed': '连接失败',
        'state.closed': '已断开',
        'state.disabled': '已断开',
        'state.unregistered': '未注册',
        'state.checking': '检测中',
        'state.unreachable': '无法检测',
        'tip.server': '地址',
        'tip.project': '项目',
        'tip.projectAuto': '按调用指定',
        'tip.lastTool': '最近调用',
        'tip.tools': '工具',
        'tip.attempt': '尝试',
        'tip.error': '错误',
        'tip.retry': '点击重新连接',
        'tip.panel': '点击选择项目',
        'panel.title': 'Rider 项目',
        'panel.subtitle': '选择工具作用于哪个项目',
        'panel.auto': '按调用指定',
        'panel.autoHint': '每次调用用自己的 rootFolder 选项目',
        'panel.open': 'Rider 中打开的项目',
        'panel.loading': '正在读取 Rider 的项目…',
        'panel.none': '没有读到打开的项目，可在下方手动输入路径',
        'panel.manualHint': '手动输入项目路径',
        'panel.manualPlaceholder': 'C:/Projects/YourProject',
        'panel.add': '添加',
        'panel.apply': '应用',
        'panel.applying': '应用中',
        'panel.close': '关闭',
        'panel.reconnect': '重新连接',
        'panel.disconnect': '断开连接',
        'panel.connect': '连接',
        'panel.paused': '已断开连接，Rider 工具暂时不可用',
        'panel.pinned': '已固定',
        'panel.current': '当前',
        'panel.pinHint': '所有会话的调用都作用于该项目',
        'panel.error': '切换失败，请重试',
        'panel.persistFailed': '已在本机运行期生效，但没能写回配置文件',
      },
      en: {
        name: 'Rider MCP',
        'state.connected': 'connected',
        'state.connecting': 'connecting',
        'state.reconnecting': 'reconnecting',
        'state.waiting-credentials': 'waiting for credentials',
        'state.failed': 'failed',
        'state.closed': 'disconnected',
        'state.disabled': 'disabled',
        'state.unregistered': 'not registered',
        'state.checking': 'checking',
        'state.unreachable': 'no status',
        'tip.server': 'endpoint',
        'tip.project': 'project',
        'tip.projectAuto': 'per call',
        'tip.lastTool': 'last call',
        'tip.tools': 'tools',
        'tip.attempt': 'attempt',
        'tip.error': 'error',
        'tip.retry': 'Click to reconnect',
        'tip.panel': 'Click to choose a project',
        'panel.title': 'Rider project',
        'panel.subtitle': 'Choose the project calls act on',
        'panel.auto': 'per call',
        'panel.autoHint': 'each call names its own project via rootFolder',
        'panel.open': 'Projects open in Rider',
        'panel.loading': 'Reading Rider projects…',
        'panel.none': 'No open project reported; type a path below',
        'panel.manualHint': 'Project path',
        'panel.manualPlaceholder': 'C:/Projects/YourProject',
        'panel.add': 'Add',
        'panel.apply': 'Apply',
        'panel.applying': 'Applying',
        'panel.close': 'Close',
        'panel.reconnect': 'Reconnect',
        'panel.disconnect': 'Disconnect',
        'panel.connect': 'Connect',
        'panel.paused': 'Disconnected — Rider tools are unavailable',
        'panel.pinned': 'pinned',
        'panel.current': 'current',
        'panel.pinHint': 'every session targets this project',
        'panel.error': 'Switch failed, please retry',
        'panel.persistFailed': 'Active now, but the config file could not be written',
      },
    }

    const TONE_OF_STATE = {
      connected: 'ok',
      connecting: 'pending',
      reconnecting: 'pending',
      'waiting-credentials': 'pending',
      checking: 'pending',
      failed: 'bad',
      closed: 'bad',
      unreachable: 'bad',
      disabled: 'idle',
      unregistered: 'idle',
    }

    const TONE_COLOR = {
      ok: 'var(--dsw-alias-state-success-primary)',
      pending: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const BADGE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '22px',
      margin: '0',
      padding: '0 8px',
      appearance: 'none',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '1',
      whiteSpace: 'nowrap',
    }

    const PANEL_STYLE = {
      position: 'fixed',
      width: `${PANEL_WIDTH}px`,
      maxHeight: `${PANEL_MAX_HEIGHT}px`,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1.4',
      zIndex: 2147483000,
      textAlign: 'left',
    }

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid transparent',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
      textAlign: 'left',
      cursor: 'pointer',
    }

    const SMALL_LABEL_STYLE = {
      fontSize: '10px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const INPUT_STYLE = {
      flex: '1 1 auto',
      minWidth: '0',
      height: '26px',
      boxSizing: 'border-box',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '11px',
    }

    const BUTTON_STYLE = {
      appearance: 'none',
      height: '26px',
      padding: '0 10px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '11px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /**
     * Render one status badge plus its project panel.
     * @param props - Slot-injected props carrying the bound translator and this
     *   entry's session id.
     * @returns The badge element.
     */
    function ConnectionBadge(props) {
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [status, setStatus] = react.useState(null)
      const [unreadable, setUnreadable] = react.useState(false)
      const [restarting, setRestarting] = react.useState(false)
      const [panel, setPanel] = react.useState(null)
      const [projects, setProjects] = react.useState({ loading: false, list: [], note: '' })
      const [extra, setExtra] = react.useState([])
      const [choice, setChoice] = react.useState('')
      const [manual, setManual] = react.useState('')
      const [applying, setApplying] = react.useState(false)
      const [pausing, setPausing] = react.useState(false)
      const [problem, setProblem] = react.useState('')
      const alive = react.useRef(true)
      const reading = react.useRef(false)
      const root = react.useRef(null)
      // The translator is a stable contract but its identity may change between
      // renders; keep the newest one for the project fetch so it does not refetch.
      const translate = react.useRef(t)
      translate.current = t

      react.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const read = react.useCallback(async () => {
        if (reading.current) return
        reading.current = true
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller === null ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(sessionPath(STATUS_PATH, sessionId), {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          })
          const payload = await response.json().catch(() => null)
          if (!alive.current) return
          if (response.ok && payload !== null && payload.ok === true) {
            setStatus(payload)
            setUnreadable(false)
          } else {
            setUnreadable(true)
          }
        } catch {
          if (alive.current) setUnreadable(true)
        } finally {
          if (timer !== null) clearTimeout(timer)
          reading.current = false
        }
      }, [sessionId])

      react.useEffect(() => {
        void read()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          void read()
        }, POLL_INTERVAL_MS)
        const onVisibilityChange = () => {
          if (typeof document !== 'undefined' && document.hidden === false) void read()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }, [read])

      // Load the open projects whenever the panel opens; the badge itself never
      // probes Rider, so a closed IDE costs nothing while the panel is shut.
      react.useEffect(() => {
        if (panel === null) return
        let cancelled = false
        setProjects({ loading: true, list: [], note: '' })
        void (async () => {
          try {
            const response = await fetch(sessionPath(PROJECTS_PATH, sessionId), {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const payload = await response.json().catch(() => null)
            if (cancelled) return
            const list = payload !== null && Array.isArray(payload.projects) ? payload.projects : []
            setProjects({
              loading: false,
              list,
              note: payload !== null && typeof payload.note === 'string' ? payload.note : '',
            })
          } catch {
            if (!cancelled) setProjects({ loading: false, list: [], note: translate.current('panel.none') })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [panel, sessionId])

      // Dismiss on outside click and Escape while the panel is open.
      react.useEffect(() => {
        if (panel === null) return
        const onPointerDown = (event) => {
          const node = root.current
          if (node !== null && node.contains(event.target)) return
          setPanel(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPanel(null)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [panel])

      const togglePanel = react.useCallback((event) => {
        if (panel !== null) {
          setPanel(null)
          return
        }
        const element = event !== null && typeof event === 'object' ? event.currentTarget : null
        const rect = element !== null && typeof element.getBoundingClientRect === 'function'
          ? element.getBoundingClientRect()
          : null
        const width = Math.min(PANEL_WIDTH, Math.max(240, (window.innerWidth || 1200) - 16))
        const left = rect === null ? 8 : Math.max(8, Math.min(rect.left, (window.innerWidth || 1200) - width - 8))
        const height = Math.min(PANEL_MAX_HEIGHT, (window.innerHeight || 800) - 24)
        const above = rect !== null && rect.top > height + 12
        const position = rect === null
          ? { left, top: 80 }
          : above
            ? { left, bottom: (window.innerHeight || 800) - rect.top + 6 }
            : { left, top: rect.bottom + 6 }
        setPanel(position)
        setChoice(status !== null && typeof status.projectPath === 'string' ? status.projectPath : '')
        setProblem('')
      }, [panel, status])

      const reconnect = react.useCallback(async () => {
        if (restarting) return
        setRestarting(true)
        try {
          await fetch(sessionPath(RESTART_PATH, sessionId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
        } catch {
          // A failed restart leaves the poll reporting the live state.
        } finally {
          setRestarting(false)
          void read()
        }
      }, [read, restarting, sessionId])

      // Disconnecting disposes only this session's MCP Fiber. The paused state
      // is saved per session, so its tools stay away after a restart too.
      const setConnection = react.useCallback(async (connected) => {
        if (pausing) return
        setPausing(true)
        setProblem('')
        try {
          const response = await fetch(sessionPath(CONNECTION_PATH, sessionId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ connected }),
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => null)
          if (!alive.current) return
          if (response.ok && payload !== null && payload.ok === true) {
            setStatus(payload)
          } else {
            setProblem(t('panel.error'))
          }
        } catch {
          if (alive.current) setProblem(t('panel.error'))
        } finally {
          if (alive.current) setPausing(false)
          void read()
        }
      }, [pausing, read, sessionId, t])

      const apply = react.useCallback(async () => {
        if (applying) return
        setApplying(true)
        setProblem('')
        try {
          const response = await fetch(sessionPath(PROJECT_PATH, sessionId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ projectPath: choice }),
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => null)
          if (!alive.current) return
          if (response.ok && payload !== null && payload.ok === true) {
            setStatus(payload)
            if (payload.persisted === false) {
              setProblem(t('panel.persistFailed'))
            } else {
              setPanel(null)
            }
          } else {
            setProblem(t('panel.error'))
          }
        } catch {
          if (alive.current) setProblem(t('panel.error'))
        } finally {
          if (alive.current) setApplying(false)
        }
      }, [applying, choice, sessionId, t])

      const addManual = react.useCallback(() => {
        const value = manual.trim()
        if (value === '') return
        setExtra((previous) => (previous.includes(value) ? previous : [...previous, value]))
        setChoice(value)
        setManual('')
      }, [manual])

      const reported = unreadable === true
        ? 'unreachable'
        : status === null
          ? 'checking'
          : typeof status.state === 'string' ? status.state : 'unreachable'
      const state = restarting === true ? 'reconnecting' : reported
      // A live connection is only "all good" once a project is known: either the
      // configuration pins one, or this conversation already called Rider for a
      // concrete rootFolder. Otherwise every call still names its own project.
      const hasProject = status !== null && (
        (typeof status.projectPath === 'string' && status.projectPath !== '')
        || (typeof status.lastRootFolder === 'string' && status.lastRootFolder !== '')
      )
      const tone = state === 'connected' ? (hasProject ? 'ok' : 'pending') : TONE_OF_STATE[state] ?? 'idle'
      const paused = status !== null && status.paused === true
      const summary = state === 'connected' ? t('name') : `${t('name')} · ${t(`state.${state}`)}`

      const details = []
      if (status !== null && typeof status.url === 'string' && status.url !== '') details.push(`${t('tip.server')}: ${status.url}`)
      if (status !== null) {
        const project = typeof status.projectPath === 'string' && status.projectPath !== ''
          ? status.projectPath
          : typeof status.lastRootFolder === 'string' && status.lastRootFolder !== ''
            ? status.lastRootFolder
            : status.projectMode === 'per-call' ? t('tip.projectAuto') : ''
        if (project !== '') details.push(`${t('tip.project')}: ${project}`)
        if (typeof status.lastRootFolderTool === 'string' && status.lastRootFolderTool !== '') {
          details.push(`${t('tip.lastTool')}: ${status.lastRootFolderTool}`)
        }
      }
      if (state === 'connected' && status !== null && typeof status.toolCount === 'number') details.push(`${t('tip.tools')}: ${status.toolCount}`)
      if (status !== null && typeof status.attempt === 'number' && typeof status.maxAttempts === 'number') details.push(`${t('tip.attempt')}: ${status.attempt}/${status.maxAttempts}`)
      if (status !== null && typeof status.lastError === 'string' && status.lastError !== '') details.push(`${t('tip.error')}: ${status.lastError}`)
      details.push(t('tip.panel'))

      const dot = (toneName) => h('span', {
        key: 'dot',
        'aria-hidden': 'true',
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: TONE_COLOR[toneName],
          flex: 'none',
          marginTop: '4px',
        },
      })

      const badge = h('button', {
        key: 'badge',
        type: 'button',
        title: details.join('\n'),
        'aria-label': summary,
        'aria-haspopup': 'dialog',
        'aria-expanded': panel !== null,
        'data-rider-mcp-state': state,
        onClick: togglePanel,
        style: { ...BADGE_STYLE, cursor: 'pointer' },
      }, [
        h('span', {
          key: 'dot',
          'aria-hidden': 'true',
          style: { width: '6px', height: '6px', borderRadius: '50%', background: TONE_COLOR[tone], flex: 'none' },
        }),
        h('span', { key: 'text' }, summary),
        h('span', { key: 'caret', 'aria-hidden': 'true', style: { opacity: '0.65' } }, '▾'),
      ])

      if (panel === null) return h('span', { ref: root, style: { display: 'inline-flex', position: 'relative' } }, badge)

      const candidates = []
      const pushCandidate = (value) => {
        if (typeof value !== 'string') return
        const path = value.trim()
        if (path === '' || candidates.includes(path)) return
        candidates.push(path)
      }
      projects.list.forEach(pushCandidate)
      extra.forEach(pushCandidate)
      if (status !== null) {
        pushCandidate(status.projectPath)
        pushCandidate(status.lastRootFolder)
      }

      const current = status !== null && typeof status.projectPath === 'string' ? status.projectPath : ''
      const rows = [
        h('button', {
          key: 'auto',
          type: 'button',
          'aria-pressed': choice === '',
          onClick: () => setChoice(''),
          style: {
            ...ROW_STYLE,
            borderColor: choice === '' ? 'var(--dsw-alias-brand-primary)' : 'transparent',
            background: choice === '' ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
          },
        }, [
          dot(choice === '' ? 'ok' : 'idle'),
          h('span', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '0' } }, [
            h('span', { key: 'label' }, t('panel.auto')),
            h('span', { key: 'hint', style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } }, t('panel.autoHint')),
          ]),
        ]),
      ]
      candidates.forEach((path, index) => {
        const selected = choice === path
        rows.push(h('button', {
          key: `p${index}`,
          type: 'button',
          title: path,
          'aria-pressed': selected,
          onClick: () => setChoice(path),
          style: {
            ...ROW_STYLE,
            borderColor: selected ? 'var(--dsw-alias-brand-primary)' : 'transparent',
            background: selected ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
          },
        }, [
          dot(selected ? 'ok' : 'idle'),
          h('span', {
            key: 'body',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              minWidth: '0',
              direction: 'ltr',
              overflow: 'hidden',
            },
          }, [
            h('span', {
              key: 'label',
              style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, path),
            path === current
              ? h('span', { key: 'hint', style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } }, t('panel.current'))
              : null,
          ]),
        ]))
      })

      const panelBody = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
          h('span', {
            key: 'dot',
            'aria-hidden': 'true',
            style: { width: '6px', height: '6px', borderRadius: '50%', background: TONE_COLOR[tone], flex: 'none' },
          }),
          h('span', { key: 'title', style: { fontWeight: '600' } }, t('panel.title')),
          h('span', { key: 'state', style: { color: 'var(--dsw-alias-label-secondary)' } }, t(`state.${state}`)),
          h('span', { key: 'grow', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'close',
            type: 'button',
            'aria-label': t('panel.close'),
            onClick: () => setPanel(null),
            style: { ...BUTTON_STYLE, border: 'none', background: 'transparent', padding: '0 4px', height: '20px' },
          }, '×'),
        ]),
        h('div', {
          key: 'sub',
          style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
        }, t('panel.subtitle')),
        h('div', {
          key: 'endpoint',
          title: status !== null && typeof status.url === 'string' ? status.url : '',
          style: {
            fontSize: '10px',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            direction: 'ltr',
          },
        }, status !== null && typeof status.url === 'string' ? status.url : ''),
        h('div', { key: 'sep', style: { height: '1px', background: 'var(--dsw-alias-border-l1)' } }),
        h('div', { key: 'section', style: SMALL_LABEL_STYLE }, t('panel.open')),
        ...rows,
        projects.loading === true
          ? h('div', { key: 'loading', style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('panel.loading'))
          : candidates.length === 0
            ? h('div', { key: 'none', style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('panel.none'))
            : null,
        h('div', { key: 'manual', style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [
          h('input', {
            key: 'input',
            type: 'text',
            value: manual,
            placeholder: t('panel.manualPlaceholder'),
            'aria-label': t('panel.manualHint'),
            onChange: (event) => setManual(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') addManual()
            },
            style: INPUT_STYLE,
            spellCheck: false,
          }),
          h('button', {
            key: 'add',
            type: 'button',
            onClick: addManual,
            style: BUTTON_STYLE,
          }, t('panel.add')),
        ]),
        problem === '' ? null : h('div', {
          key: 'problem',
          style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
        }, problem),
        paused === false ? null : h('div', {
          key: 'paused',
          style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
        }, t('panel.paused')),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
          h('button', {
            key: 'connection',
            type: 'button',
            disabled: pausing,
            onClick: () => void setConnection(paused),
            style: { ...BUTTON_STYLE, cursor: pausing ? 'progress' : 'pointer' },
          }, paused ? t('panel.connect') : t('panel.disconnect')),
          h('button', {
            key: 'reconnect',
            type: 'button',
            disabled: restarting,
            onClick: reconnect,
            style: { ...BUTTON_STYLE, cursor: restarting ? 'progress' : 'pointer' },
          }, restarting ? t('state.reconnecting') : t('panel.reconnect')),
          h('span', { key: 'grow', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'apply',
            type: 'button',
            disabled: applying || choice === current,
            onClick: apply,
            style: {
              ...BUTTON_STYLE,
              borderColor: 'var(--dsw-alias-brand-primary)',
              color: 'var(--dsw-alias-brand-primary)',
              background: 'transparent',
              opacity: applying || choice === current ? '0.55' : '1',
              cursor: applying ? 'progress' : choice === current ? 'default' : 'pointer',
            },
          }, applying ? t('panel.applying') : t('panel.apply')),
        ]),
      ]

      return h('span', { ref: root, style: { display: 'inline-flex', position: 'relative' } }, [
        badge,
        h('div', {
          key: 'panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
          'data-rider-mcp-panel': 'true',
          style: { ...PANEL_STYLE, ...panel },
        }, panelBody),
      ])
    }

    /**
     * Mount the badge in the first seat the composer declares.
     * @param ctx - Browser context carrying `slots` and `locale`.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, COPY), 'rider-mcp: dictionaries')
      const slots = ctx.get('slots')
      if (slots === undefined) return

      let live = null
      SEATS.forEach((seat, index) => {
        ctx.effect(() => slots.inject(seat.name, () => {
          if (live !== null && live.index <= index) return () => undefined
          if (live !== null) {
            const previous = live
            live = null
            previous.dispose()
          }
          try {
            const dispose = slots.register({
              name: seat.name,
              id: ENTRY_ID,
              order: seat.order,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            }, ConnectionBadge)
            live = { index, dispose }
            return () => {
              if (live !== null && live.index === index) live = null
              dispose()
            }
          } catch (error) {
            ctx.logger?.warn?.(`rider-mcp: ${seat.name} rejected the status badge`, error)
            return () => undefined
          }
        }), `rider-mcp: ${seat.name}`)
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
