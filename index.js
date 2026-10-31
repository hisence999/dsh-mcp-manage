/**
 * Host half of the MCP manage bundle.
 *
 * The visible product is the「MCP管理」page in the settings panel (Client half,
 * `client.js`). This half answers the three questions a browser cannot answer on
 * its own, plus one capability the Loader cannot express:
 *
 *   GET  /mcp-manage/api/state   every mcp-client row, its tool inventory, the
 *                                schema bytes those tools cost, and whether the
 *                                row is session-lazy;
 *   POST /mcp-manage/api/toggle  { id, enabled } -> pluginManager.setPluginEnabled
 *   POST /mcp-manage/api/lazy    { server, lazy } -> configEditor.edit
 *   POST /mcp-manage/api/add     { mode, server | json } -> a new mcp-client row
 *
 *   mcp_tools                    a Host tool that loads a lazy MCP server's tools
 *                                into the CURRENT session (see below).
 *
 * ── Why a Host route ────────────────────────────────────────────────────────
 * The tool registry and the Loader row list both live on the Host; a Client
 * module has no MCP-related service to read them from.
 *
 * ── Why session-lazy needs a Host hook ──────────────────────────────────────
 * `mcp-client` registers its tools eagerly on its own context and keeps the
 * returned disposers to itself, so this bundle can neither skip nor undo that
 * registration from the outside. `tools.restrict()` only masks GLOBAL tools
 * ("scoped registrations remain visible"), so it cannot hide an agent-scoped
 * registration either. What this bundle CAN do is shape one assemble pass:
 * `dsh-agent-loop` builds every request from `systemPrompt.assemble(...)` and
 * its `system-prompt/assemble` waterfall result is authoritative, so a listener
 * that drops the unwanted `mcp__<server>__*` schemas from `assembly.tools`
 * shrinks the tool block the model is actually sent — which is the whole point
 * of the feature (token cost), not access control.
 *
 * The gate is per agent object (`context.agent === context.scope === Agent`) and
 * the loaded set lives in a WeakMap keyed by that object, so a load lasts for
 * the session and disappears with it. `mcp_tools` mutates that set, and the tool
 * block is rebuilt on every step, so a load takes effect on the model's NEXT
 * step — which is exactly how browser-control's lazy tools behave.
 *
 * Two access rules this file follows, both learned from the live composition:
 *
 *   - Optional services are read with `ctx.get(name)`, never `ctx.name`.
 *     Cordis throws when a non-injected service is read through the proxy, so
 *     a plain `ctx.pluginManager` turns a missing service into a 500.
 *   - Tool schemas must be read PER AGENT SCOPE. `tools.schemas()` with no
 *     scope returns only the global view, and mcp-client registers its tools
 *     in the calling agent's scope — so the global view alone reports every
 *     MCP server with zero tools.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Route prefix; the Client panel fetches below this path. */
const PREFIX = '/mcp-manage/api'

/** Tools contributed by an mcp-client row are named `mcp__<server>__<tool>`. */
const TOOL_PREFIX = 'mcp__'

/** The one package whose rows this panel manages. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** This bundle's package name, and the patch id of its own Loader row. */
const SELF_PACKAGE = 'dsh-mcp-manage'
const SELF_PATCH_ID = 'mcp-manage'

/** Characters per token, the same rough divisor the panel's footnote cites. */
const CHARS_PER_TOKEN = 4

/** The loader tool that pulls a lazy server's tools into the current session. */
const LOADER_TOOL_NAME = 'mcp_tools'

/** Sanity cap on the persisted lazy list; the panel never writes this many. */
const MAX_LAZY = 64

/** Upper bound for one hand-written server note (characters). */
const MAX_NOTE = 600

/**
 * mcp-client accepts this pattern for `serverName` and the Loader row id, and a
 * name outside it fails validation *after* the write, which would leave a broken
 * row behind. Reject it here instead.
 */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Rejected before touching the profile: a row that huge is a mistake, not intent. */
const MAX_ADD_BYTES = 32 * 1024

/** Cap on one paste; a config with more servers than this is a mistake. */
const MAX_NEW_ROWS = 16

/** `webServer` is required (the route); everything else is resolved at use. */
export const inject = ['webServer', 'tools', 'systemPrompt']

export function apply(ctx, config) {
  const lazy = new Set(readLazyServers(config))

  /**
   * Hand-written per-server notes (`{ exa: '联网搜索与网页抓取' }`).
   *
   * Only the lazy path reads them: a lazy server's tools are invisible, so the
   * loader tool is the one place the model can learn what that server is for.
   * Rebuilt from the profile row on every reload, exactly like `lazy`.
   */
  const notes = readServerNotes(config)

  /** Per-session load ledger: agent object -> servers whose tools it may see. */
  const loadedByAgent = new WeakMap()

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => handle(ctx, req, res, lazy, notes),
    }),
    'dsh-mcp-manage: state, toggle, lazy and note route',
  )

  // The lazy gate. `next()` returns the assembly every other listener agreed
  // on; returning a different object is the supported way to rewrite it.
  ctx.effect(
    () => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (lazy.size === 0) return assembled
      const tools = assembled?.tools
      if (!Array.isArray(tools)) return assembled
      const agent = context?.agent
      // No agent object means no session to be lazy in (composite dispatch and
      // run_code nesting); fail open rather than hide tools from a caller that
      // could never load them back.
      if (agent === undefined || agent === null) return assembled
      const loaded = loadedByAgent.get(agent)
      const kept = tools.filter((schema) => !hidesTool(schema?.name, lazy, loaded))
      if (kept.length === tools.length) return assembled
      return { ...assembled, tools: kept }
    }),
    'dsh-mcp-manage: session-lazy tool gate',
  )

  // A finished session's ledger is dropped with the agent object anyway; the
  // listener keeps a recycled object from inheriting an old load.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent !== undefined && agent !== null) loadedByAgent.delete(agent)
  })

  // The loader only exists when something is actually lazy: a tool that can
  // never load anything is pure noise in the model's tool block.
  //
  // Its description names the mounted lazy servers, and that set moves without
  // this entry reloading: enabling or disabling a row in the panel is a manager
  // operation, not a config edit of *this* plugin, so `apply` does not run
  // again and a description baked here would keep advertising servers that are
  // gone. Rebuild the registration whenever the manager reports a change —
  // dispose first, because two live registrations of one name in one layer is a
  // hard error.
  if (lazy.size > 0) {
    let disposeLoader = null

    const unmountLoader = () => {
      if (disposeLoader === null) return
      const dispose = disposeLoader
      disposeLoader = null
      try {
        dispose()
      } catch {
        // Already gone; nothing to unwind.
      }
    }

    const mountLoader = () => {
      if (disposeLoader !== null) return
      // Nothing mounted right now: leave the tool out entirely rather than ship
      // a description that cannot load anything.
      if (liveLazyServers(ctx, lazy).size === 0) return
      disposeLoader = ctx.tools.register(loaderTool(ctx, lazy, loadedByAgent, notes))
    }

    ctx.effect(() => {
      mountLoader()
      return unmountLoader
    }, 'dsh-mcp-manage: mcp_tools loader')

    // Deliberately not `tools/change`: registering the loader emits that, and a
    // rebuild on it would ring. A manager operation is the coarse signal we want.
    ctx.on('plugin-manager/changed', () => {
      unmountLoader()
      mountLoader()
    })
  }
}

/* ── configuration ────────────────────────────────────────────────────── */

/**
 * The persisted lazy list.
 *
 * This bundle deliberately ships no `Config` schema: the installed copy is a
 * junction of this directory and carries no dependencies, so it cannot import
 * the Host's schema library. Validation is therefore hand-written and lenient —
 * anything unusable is dropped, never thrown, so one bad string in the profile
 * patch cannot take the whole panel (and its route) down.
 */
function readLazyServers(config) {
  const raw = config?.lazyServers
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name.length === 0 || name.length > 64) continue
    if (out.includes(name)) continue
    out.push(name)
    if (out.length >= MAX_LAZY) break
  }
  return out
}

/** Trim a note to the shape that is safe to persist and to inject. */
function normaliseNote(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_NOTE)
}

/**
 * The persisted notes, keyed by server name.
 *
 * Same lenient policy as `readLazyServers`: a malformed entry is dropped, never
 * thrown — the panel and its route must survive a hand-edited profile row.
 * Empty notes are simply absent, which is what "the user wrote nothing" means.
 */
function readServerNotes(config) {
  const raw = config?.serverNotes
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (typeof rawValue !== 'string') continue
    const server = String(rawKey).trim()
    if (server.length === 0 || server.length > 64) continue
    const note = normaliseNote(rawValue)
    if (note.length === 0) continue
    out[server] = note
    count += 1
    if (count >= MAX_LAZY) break
  }
  return out
}

/* ── tool names ───────────────────────────────────────────────────────── */

/** The server segment of `mcp__<server>__<tool>`, or null for any other tool. */
function serverOfToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return null
  const rest = name.slice(TOOL_PREFIX.length)
  const split = rest.indexOf('__')
  if (split <= 0) return null
  return rest.slice(0, split)
}

/**
 * Whether one tool schema must stay out of this session's tool block.
 *
 * A lazy server contributes nothing until the session loads it; a non-lazy
 * server, a non-MCP tool, and a server the session already loaded all pass.
 */
function hidesTool(name, lazy, loaded) {
  const server = serverOfToolName(name)
  if (server === null || !lazy.has(server)) return false
  return !(loaded !== undefined && loaded.has(server))
}

/** This agent's ledger, created on first write. */
function loadedSetOf(loadedByAgent, agent) {
  let loaded = loadedByAgent.get(agent)
  if (loaded === undefined) {
    loaded = new Set()
    loadedByAgent.set(agent, loaded)
  }
  return loaded
}

/** Per-server tool count and schema bytes as this agent currently sees them. */
function serverStats(ctx, agent) {
  const stats = new Map()
  let schemas = []
  try {
    schemas = ctx.tools.schemas(agent) ?? []
  } catch {
    schemas = []
  }
  if (schemas.length === 0) {
    // An unscoped caller (or a scope that owns nothing) still deserves a
    // catalog; the global view is the best answer available then.
    try {
      schemas = ctx.tools.schemas() ?? []
    } catch {
      schemas = []
    }
  }
  for (const schema of schemas) {
    const server = serverOfToolName(schema?.name)
    if (server === null) continue
    let chars = 0
    try {
      chars = JSON.stringify(schema).length
    } catch {
      chars = 0
    }
    const bucket = stats.get(server) ?? { tools: 0, chars: 0 }
    bucket.tools += 1
    bucket.chars += chars
    stats.set(server, bucket)
  }
  return stats
}

/* ── the loader tool ──────────────────────────────────────────────────── */

function loaderDescription(live, notes = {}) {
  // Each *mounted* lazy server is listed with the user's own description of what
  // it is for. A lazy row that is disabled registers no tools at all, so listing
  // it would advertise something the model could never load.
  const names = [...live].sort()
  const listed = names.map((server) => {
    const note = notes[server]
    return note ? `${server} — ${note}` : `${server} — (no description configured)`
  })
  return [
    'Load MCP tools into THIS session.',
    `Lazy MCP servers are configured for session-lazy startup: their tools (${TOOL_PREFIX}<server>__<tool>)`,
    'are registered but are deliberately kept OUT of your tool block until you load them here.',
    names.length === 0
      ? 'No lazy MCP server is mounted right now — being lazy is not enough, the server also has to be enabled in Settings → MCP管理, so there is nothing to load at the moment.'
      : `Lazy servers: ${listed.join('; ')}.`,
    'The text after each name is the user\'s description of what that server is for —',
    'read it to decide which server the current task needs.',
    'Call with no `servers` to list what can be loaded (name, description, tool count, token cost).',
    'Call with `servers: ["<name>"]` — or ["*"] for all — to load them for this session;',
    'they become callable from your NEXT step on, and only in this session.',
    'Load everything you need in ONE call: each load changes the tool list, so batching beats loading one server at a time.',
  ].join(' ').replace(/\s+/g, ' ')
}

/**
 * The lazy servers that are mounted right now (lazy *and* enabled).
 *
 * Read from the Loader on every call instead of caching at apply time: the row
 * switches are flipped live, and the loader must not keep advertising a server
 * that has been turned off — or omit one that was just turned on.
 */
function liveLazyServers(ctx, lazy) {
  const live = new Set()
  for (const row of readRows(ctx)) {
    if (row.enabled && lazy.has(row.serverName)) live.add(row.serverName)
  }
  return live
}

/**
 * `mcp_tools` — the only MCP-adjacent tool a lazy session starts with.
 *
 * It never registers anything: the tools already exist, it only flips a marker
 * in the session's ledger so the assemble gate stops filtering them.
 */
function loaderTool(ctx, lazy, loadedByAgent, notes = {}) {
  /** Lazy servers this session has not loaded yet, with their cost and note. */
  const availableFor = (loaded, agent) => {
    const live = liveLazyServers(ctx, lazy)
    const stats = serverStats(ctx, agent)
    return [...live]
      .filter((server) => !loaded.has(server))
      .sort()
      .map((server) => {
        const bucket = stats.get(server)
        const row = {
          server,
          tools: bucket?.tools ?? 0,
          tokens: Math.round((bucket?.chars ?? 0) / CHARS_PER_TOKEN),
        }
        // `output.schema` declares `note` optional, but the validator also
        // rejects unknown keys, so an absent note must be an absent property.
        if (notes[server]) row.note = notes[server]
        return row
      })
  }

  return {
    name: LOADER_TOOL_NAME,
    description: loaderDescription(liveLazyServers(ctx, lazy), notes),
    parameters: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Server names to load into this session, or ["*"] for every lazy server. Omit to list what can be loaded.',
        },
      },
      additionalProperties: false,
    },
    output: {
      // Plain JSON Schema: `tools.register` validates the declaration and rejects
      // the flat defineTool dialect (`required: true` on a non-object node), so
      // `required` is the object-level array of property names here.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: { type: 'array', items: { type: 'string' } },
          activated: { type: 'array', items: { type: 'string' } },
          already: { type: 'array', items: { type: 'string' } },
          unknown: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          available: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string' },
                tools: { type: 'number' },
                tokens: { type: 'number' },
                note: { type: 'string' },
              },
              required: ['server', 'tools', 'tokens'],
            },
          },
          note: { type: 'string' },
        },
        required: ['loaded', 'activated', 'already', 'unknown', 'scope'],
      },
      render: (_args, value) => {
        const lines = []
        if (value.note !== undefined) lines.push(value.note)
        if (value.activated.length > 0) {
          lines.push(`Loaded for this session: ${value.activated.join(', ')} — callable from your next step on.`)
          for (const server of value.activated) {
            if (notes[server]) lines.push(`- ${server}: ${notes[server]}`)
          }
        }
        if (value.already.length > 0) lines.push(`Already loaded: ${value.already.join(', ')}.`)
        if (value.unknown.length > 0) {
          lines.push(`Nothing loaded for these: ${value.unknown.join(', ')} — either the name is wrong or that server is disabled; call with no \`servers\` to see what is loadable right now.`)
        }
        if (value.available !== undefined && value.available.length > 0) {
          lines.push(`Lazy servers not loaded in this session (${value.available.length}):`)
          for (const row of value.available) {
            const purpose = row.note === undefined ? '' : ` — ${row.note}`
            lines.push(`- ${row.server} — ${row.tools} tools, ~${row.tokens} tokens${purpose}`)
          }
          lines.push('Load with mcp_tools {servers: [...]} — exact names or "*".')
        } else if (value.available !== undefined) {
          lines.push('Nothing left to load in this session — every mounted lazy server is already loaded, or none is mounted.')
        }
        if (lines.length === 0) lines.push('Loaded:', value.loaded.length === 0 ? 'none' : value.loaded.join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const wanted = readServersArg(args?.servers)
      const agent = exec?.agent
      const nothing = {
        loaded: [],
        activated: [],
        already: [],
        unknown: [...wanted.list],
        scope: 'none',
        available: availableFor(new Set(), undefined),
        note: 'This call had no session scope (exec.agent), so nothing could be loaded. Run mcp_tools from an ordinary agent turn.',
      }
      if (agent === undefined || agent === null) return nothing

      const loaded = loadedSetOf(loadedByAgent, agent)

      if (wanted.list.length === 0 && !wanted.star) {
        return {
          loaded: [...loaded].sort(),
          activated: [],
          already: [],
          unknown: [],
          scope: 'session',
          available: availableFor(loaded, agent),
        }
      }

      // Only mounted servers can be loaded: a lazy-but-disabled row has no tools
      // to reveal, so it is reported as not loadable instead of pretending.
      const live = liveLazyServers(ctx, lazy)
      const target = wanted.star ? new Set(live) : new Set(wanted.list.filter((server) => live.has(server)))
      const unknown = wanted.star ? [] : wanted.list.filter((server) => !live.has(server))
      const activated = []
      const already = []
      for (const server of [...target].sort()) {
        if (loaded.has(server)) already.push(server)
        else {
          loaded.add(server)
          activated.push(server)
        }
      }
      return {
        loaded: [...loaded].sort(),
        activated,
        already,
        unknown,
        scope: 'session',
        available: availableFor(loaded, agent),
      }
    },
  }
}

/** Normalise the `servers` argument; `'*'` is a set flag, not a name. */
function readServersArg(value) {
  const list = []
  let star = false
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const name = item.trim()
      if (name.length === 0) continue
      if (name === '*') {
        star = true
        continue
      }
      if (!list.includes(name)) list.push(name)
    }
  }
  return { list, star }
}

/* ── panel data ───────────────────────────────────────────────────────── */

/** Loader entries as an array; a Loader that is missing or wedged yields none. */
function loaderEntries(ctx) {
  try {
    return [...(ctx.get('loader')?.entries?.() ?? [])]
  } catch {
    return []
  }
}

/** Every enabled-or-disabled mcp-client row, running ones first. */
function readRows(ctx) {
  const rows = []
  for (const entry of loaderEntries(ctx)) {
    const options = entry?.options
    if (!options || options.name !== MCP_CLIENT_PACKAGE) continue
    const config = options.config ?? {}
    rows.push({
      id: String(options.id ?? ''),
      serverName: String(config.serverName ?? options.id ?? ''),
      transport: String(config.transport ?? 'stdio'),
      enabled: !entry.disabled,
    })
  }
  return rows.sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || a.id.localeCompare(b.id))
}

/**
 * Every visible tool schema, de-duplicated by name across the global view and
 * every live agent scope.
 *
 * An agent's view already includes the global tools, so the union of the
 * global view and each agent view is the full set; de-duplicating by name
 * keeps a tool shared by several agents from being counted twice.
 */
function collectSchemas(ctx) {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.schemas !== 'function') return { schemas: [], agents: 0 }

  const seen = new Set()
  const schemas = []
  const push = (list) => {
    for (const schema of list ?? []) {
      const name = schema?.name
      if (typeof name !== 'string' || seen.has(name)) continue
      seen.add(name)
      schemas.push(schema)
    }
  }

  try {
    push(tools.schemas())
  } catch {
    // A scoped-only composition may expose no global view at all.
  }

  let agents = []
  try {
    agents = ctx.get('agents')?.list?.() ?? []
  } catch {
    agents = []
  }
  for (const agent of agents) {
    try {
      push(tools.schemas(agent))
    } catch {
      // One unreadable scope must not hide the others.
    }
  }

  return { schemas, agents: agents.length }
}

/**
 * Group the live MCP tool schemas by server name.
 *
 * A server's size is the serialized length of its schemas — the same bytes the
 * model would be sent. Tools resolve by server name parsed out of the tool
 * name, because that is the only place the link between a row and its tools
 * is stated.
 */
function readTools(collected) {
  const byServer = new Map()
  let allChars = 0
  for (const schema of collected.schemas) {
    let chars = 0
    try {
      chars = JSON.stringify(schema).length
    } catch {
      chars = 0
    }
    // Every tool counts toward the context denominator, MCP or not.
    allChars += chars
    const server = serverOfToolName(schema?.name)
    if (server === null) continue
    const rest = schema.name.slice(TOOL_PREFIX.length)
    const split = rest.indexOf('__')
    let bucket = byServer.get(server)
    if (!bucket) {
      bucket = { chars: 0, tools: [] }
      byServer.set(server, bucket)
    }
    bucket.chars += chars
    bucket.tools.push({ name: rest.slice(split + 2), chars })
  }
  return { byServer, allChars }
}

/** The panel's whole payload. */
function buildState(ctx, lazy, notes = {}) {
  const collected = collectSchemas(ctx)
  const { byServer, allChars } = readTools(collected)
  const rows = readRows(ctx).map((row) => {
    const bucket = byServer.get(row.serverName)
    const chars = bucket?.chars ?? 0
    return {
      ...row,
      lazy: lazy.has(row.serverName),
      // The user's own description of the server; '' when nothing was written.
      note: notes[row.serverName] ?? '',
      chars,
      tokens: Math.round(chars / CHARS_PER_TOKEN),
      tools: bucket?.tools ?? [],
    }
  })
  const chars = rows.reduce((total, row) => total + row.chars, 0)
  const lazyRows = rows.filter((row) => row.lazy)
  return {
    rows,
    totals: {
      rows: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      tools: rows.reduce((total, row) => total + row.tools.length, 0),
      chars,
      tokens: Math.round(chars / CHARS_PER_TOKEN),
      allChars,
      // Share of every registered tool's schema bytes that MCP accounts for.
      share: allChars > 0 ? Math.round((chars / allChars) * 100) : 0,
      // What the lazy switches currently keep out of a fresh session, and the
      // headroom they offer: a loaded server costs its full tokens again.
      lazy: lazyRows.length,
      lazyTokens: lazyRows.reduce((total, row) => total + row.tokens, 0),
      // How many servers carry a hand-written description (they only matter
      // for lazy ones, but a note is useful the moment the switch is flipped).
      described: rows.filter((row) => row.note.length > 0).length,
      // Diagnostics: how many scopes were read and how many tools were seen.
      scopes: collected.agents,
      seen: collected.schemas.length,
    },
    generatedAt: new Date().toISOString(),
  }
}

/* ── persistence ──────────────────────────────────────────────────────── */

/** A Loader entry's profile patch id (its override key), when it has one. */
function patchIdOf(entry) {
  const record = plainRecord(entry)
  const options = plainRecord(record.options)
  const value = record.patchId ?? record.id ?? options.id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The plugin package name a Loader entry loads. */
function nameOf(entry) {
  const options = plainRecord(plainRecord(entry).options)
  const value = options.name
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/**
 * Persist the panel's settings onto this bundle's own row.
 *
 * `configEditor.edit` validates, writes the profile patch and reconciles the
 * Loader, which reloads THIS plugin once — the new `apply` then installs the
 * new gate and a fresh (empty) session ledger. The route is served from the
 * fiber that is being replaced, but the socket outlives it, so the response
 * still lands.
 *
 * Both keys are written every time: `edit` replaces the row's config object
 * wholesale, so a write that forgot the other key would silently drop it.
 */
async function persistSettings(ctx, next) {
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    throw httpError(501, 'configEditor is unavailable in this composition')
  }
  const entries = [...(await Promise.resolve(editor.entries()))]
  const entry = entries.find((item) => patchIdOf(item) === SELF_PATCH_ID)
    ?? entries.find((item) => nameOf(item) === SELF_PACKAGE)
  if (entry === undefined) {
    throw httpError(409, `no profile row addresses ${SELF_PACKAGE} (a read-only row cannot be edited)`)
  }
  await editWithRetry(editor, entry, (current) => ({ ...plainRecord(current), ...next }))
  return { saved: true }
}

/**
 * Profile documents are written atomically under a writer lock, so two panel
 * clicks in a row can collide and surface
 * `atomic-write: timed out waiting for the writer lock`. One write at a time per
 * process is all this page needs.
 */
let writeQueue = Promise.resolve()

function serializeWrite(task) {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

/** Retry the two failure modes that are purely "someone else is writing". */
const WRITE_RETRY_DELAYS = [250, 600, 1200]

async function editWithRetry(editor, entry, produce) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await editor.edit(entry, produce)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const contended = /writer lock|EBUSY|timed out waiting/i.test(message)
      if (!contended) throw error
      if (attempt >= WRITE_RETRY_DELAYS.length) {
        throw httpError(409, `${message} — another profile write is in flight; try again in a moment`)
      }
      await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_DELAYS[attempt]))
    }
  }
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/* ── adding a server ──────────────────────────────────────────────────── */

/**
 * Turn one `{"mcpServers": {...}}`-style spec (or the panel's option form) into
 * a Loader row for this profile.
 *
 * The shape is Trae's, because that is the format people already have in their
 * clipboard and in their other editors; the only change is that the MCP client
 * this profile loads wants `transport` and `serverName` written out, which a
 * Trae config implies (`command` means stdio, `url` means http) rather than
 * states. Anything unrecognised is rejected loudly instead of being dropped: a
 * hand-pasted config that quietly loses `env` is the worst possible outcome.
 *
 * @returns `{ id, name, config }` — a Loader row, not yet persisted.
 */
function rowFromSpec(id, spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw httpError(400, `"${id}" must be an object`)
  }
  if (!SERVER_NAME.test(id)) {
    throw httpError(400, `"${id}" is not a usable server name: letters, digits, "_" and "-" only, at most 32`)
  }

  const command = typeof spec.command === 'string' ? spec.command.trim() : ''
  const url = typeof spec.url === 'string' ? spec.url.trim() : ''
  if (command.length === 0 && url.length === 0) {
    throw httpError(400, `"${id}" needs either "command" (stdio) or "url" (http)`)
  }
  if (command.length > 0 && url.length > 0) {
    throw httpError(400, `"${id}" sets both "command" and "url"; keep one of them`)
  }

  const config = { serverName: id, transport: command.length > 0 ? 'stdio' : 'streamable-http' }

  if (command.length > 0) {
    // A command with a space in it is the classic npx mistake (`npx -y pkg`);
    // mcp-client would spawn it as a single executable name and fail obscurely.
    if (/\s/.test(command)) {
      throw httpError(400, `"${id}": "command" must be the executable alone; put its arguments in "args"`)
    }
    config.command = command
    config.args = stringArray(spec.args, `${id}.args`)
    const env = stringRecord(spec.env, `${id}.env`)
    if (Object.keys(env).length > 0) config.env = env
    const cwd = typeof spec.cwd === 'string' ? spec.cwd.trim() : ''
    if (cwd.length > 0) config.cwd = cwd
  } else {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw httpError(400, `"${id}": "url" is not a URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw httpError(400, `"${id}": "url" must be http or https`)
    }
    config.url = url
    const headers = stringRecord(spec.headers, `${id}.headers`)
    if (Object.keys(headers).length > 0) config.headers = headers
  }

  // Startup failures must not take the session down: a freshly pasted server is
  // exactly the case where the command or the endpoint is wrong.
  config.failOnStartupError = false
  const timeout = Number(spec.toolCallTimeoutMs)
  if (Number.isFinite(timeout) && timeout >= 1000) config.toolCallTimeoutMs = Math.trunc(timeout)

  return { id, name: MCP_CLIENT_PACKAGE, config }
}

function stringArray(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw httpError(400, `"${label}" must be an array of strings`)
  return value.map((item) => {
    if (typeof item !== 'string') throw httpError(400, `"${label}" must contain strings only`)
    return item
  })
}

function stringRecord(value, label) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, `"${label}" must be an object of strings`)
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw httpError(400, `"${label}.${key}" must be a string`)
    out[key] = item
  }
  return out
}

/**
 * Parse whatever the panel sent into `[row, ...]`.
 *
 * Two inputs, one output: `mode: 'json'` takes a pasted `{"mcpServers": {...}}`
 * document (several servers at once is the normal case for a shared config),
 * and `mode: 'form'` builds the same thing from one filled-in form. A single
 * server is allowed to arrive without the wrapper too, because people paste the
 * inner object just as often.
 */
function rowsFromRequest(body) {
  const raw = body?.json
  if (body?.mode === 'json' || typeof raw === 'string') {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw httpError(400, 'json must be a non-empty string')
    }
    if (raw.length > MAX_ADD_BYTES) throw httpError(413, `json must be at most ${MAX_ADD_BYTES} bytes`)
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw httpError(400, `json does not parse: ${error instanceof Error ? error.message : String(error)}`)
    }
    const servers = parsed?.mcpServers ?? parsed
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
      throw httpError(400, 'json must be {"mcpServers": {"<name>": {...}}} or one such object')
    }
    const entries = Object.entries(servers)
    if (entries.length === 0) throw httpError(400, 'json contains no servers')
    if (entries.length > MAX_NEW_ROWS) throw httpError(400, `at most ${MAX_NEW_ROWS} servers at a time`)
    return entries.map(([id, spec]) => rowFromSpec(String(id).trim(), spec))
  }

  const id = typeof body?.server === 'string' ? body.server.trim() : ''
  if (id.length === 0) throw httpError(400, 'server must be a non-empty string')
  const spec = body?.config
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw httpError(400, 'config must be an object')
  }
  return [rowFromSpec(id, spec)]
}

/**
 * Append new rows to the profile patch.
 *
 * This is the one write the panel cannot express through `configEditor`: that
 * service edits a row it already addresses, and a new server has no row yet.
 * The patch layer is the only place a row can be born — a top-level `- id:`
 * entry without `insert` may only OVERRIDE a row an earlier layer created, so
 * "add" has to be an `insert` list, which is appended as text.
 *
 * Text is used deliberately: re-serializing the whole document would reformat
 * (and de-quote) every unrelated row in a file the user maintains by hand. The
 * block is emitted in the same style the file already uses, then verified by
 * re-reading; a reload that fails is rolled back from the in-memory `before`.
 *
 * @returns `{ path, added }` after the Loader has recomposed from the new file.
 */
async function appendRows(ctx, rows) {
  const editor = ctx.get('configEditor')
  const settings = ctx.get('settings')
  let path
  if (editor !== undefined && typeof editor.documentPath === 'string') path = editor.documentPath
  else if (settings !== undefined && typeof settings.prepareDocument === 'function') {
    path = await settings.prepareDocument()
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw httpError(501, 'this composition exposes no profile patch to write to')
  }

  let before
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    before = ''
  }

  // Refuse a duplicate before writing. Two collisions matter: the row id (two
  // `- id:` entries in one patch layer would make the second an override of the
  // first, so a server would silently vanish) and the serverName (mcp-client
  // refuses a second instance with a name already in use, which would otherwise
  // surface as a rolled-back reconcile instead of a plain "already exists").
  const rows0 = readRows(ctx)
  const takenIds = new Set(rows0.map((row) => row.id))
  const takenNames = new Set(rows0.map((row) => row.serverName))
  for (const row of rows) {
    if (takenIds.has(row.id)) {
      throw httpError(409, `a row "${row.id}" already exists; pick another name or edit that row`)
    }
    if (takenNames.has(row.config.serverName)) {
      throw httpError(409, `a server named "${row.config.serverName}" already exists; pick another name`)
    }
  }

  const block = renderInsertBlock(rows)
  const separator = before.length === 0
    ? ''
    : (before.endsWith('\n') ? (before.endsWith('\n\n') ? '' : '\n') : '\n\n')
  const next = `${before}${separator}${block}`

  await serializeWrite(async () => {
    await writeProfilePatch(path, next)
    await reconcile(ctx, rows.map((row) => row.id), before, path)
  })

  return { path, added: rows.map((row) => row.id) }
}

/** One `- insert:` list carrying the new rows, in the file's own style. */
function renderInsertBlock(rows) {
  const lines = [
    '# ── 由面板「添加 MCP」写入；删掉这段等于删除下面这些服务器 ──────────',
    '- insert:',
  ]
  for (const row of rows) {
    lines.push(`    - id: ${yamlScalar(row.id)}`)
    lines.push(`      name: ${yamlScalar(row.name)}`)
    lines.push('      config:')
    lines.push(...yamlLines(row.config, 8))
  }
  return `${lines.join('\n')}\n`
}

/** Emit a plain object as indented YAML; the value set here is small and known. */
function yamlLines(value, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${key}: []`)
      } else {
        lines.push(`${pad}${key}:`)
        for (const element of item) lines.push(`${pad}  - ${yamlScalar(element)}`)
      }
      continue
    }
    if (item !== null && typeof item === 'object') {
      const nested = Object.keys(item).length === 0 ? [] : yamlLines(item, indent + 2)
      if (nested.length === 0) {
        lines.push(`${pad}${key}: {}`)
      } else {
        lines.push(`${pad}${key}:`)
        lines.push(...nested)
      }
      continue
    }
    if (typeof item === 'boolean' || typeof item === 'number') {
      lines.push(`${pad}${key}: ${String(item)}`)
      continue
    }
    lines.push(`${pad}${key}: ${yamlScalar(item)}`)
  }
  return lines
}

/**
 * A YAML scalar that always reads back as the same string.
 *
 * Everything here comes from a pasted config, so it may hold quotes, colons,
 * leading dashes or a newline. Single-quoting with `''` escaping is the one form
 * that is unambiguous for arbitrary text; anything containing a literal newline
 * is refused upstream by the JSON parse anyway.
 */
function yamlScalar(value) {
  const text = String(value)
  if (text.length === 0) return "''"
  return `'${text.replace(/'/g, "''")}'`
}

/** Reconcile the Loader from the file just written, rolling back on failure. */
async function reconcile(ctx, addedIds, before, path) {
  const hmr = ctx.get('hmr')
  if (hmr === undefined || typeof hmr.reconcileProfile !== 'function') {
    // No HMR service: the file is correct but the running composition cannot
    // pick it up. Say so instead of reporting a success nobody can see.
    throw httpError(202, `saved to ${path}, but this composition cannot hot-reload it — restart dsh to load ${addedIds.join(', ')}`)
  }
  try {
    await hmr.runExclusive(() => hmr.reconcileProfile(addedIds))
  } catch (error) {
    await writeProfilePatch(path, before)
    try {
      await hmr.runExclusive(() => hmr.reconcileProfile())
    } catch {
      // The rollback report is the one worth surfacing; a failed second
      // reconcile would only mask it.
    }
    throw httpError(500, `the new server did not activate, so the profile patch was rolled back: ${
      error instanceof Error ? error.message : String(error)}`)
  }
}

/** Atomic replace: a patch file read mid-write would fail the whole profile. */
async function writeProfilePatch(path, text) {
  const temporary = join(dirname(path), `.${Date.now().toString(36)}-${process.pid}.patch.tmp`)
  await writeFile(temporary, text, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // The temporary itself already gone is the state we wanted.
    }
    throw error
  }
}

/* ── http plumbing ────────────────────────────────────────────────────── */

/** Loopback-only: this route mutates profile state, so it is not for the LAN. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

function isTrusted(req) {
  const host = String(req?.headers?.host ?? '').trim().toLowerCase()
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  if (LOOPBACK.has(hostname)) return true
  const remote = String(req?.socket?.remoteAddress ?? '')
  return LOOPBACK.has(remote) || remote === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** Read a JSON request body; an empty body reads as `{}`. */
async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ── handler ──────────────────────────────────────────────────────────── */

async function handle(ctx, req, res, lazy, notes = {}) {
  try {
    if (!isTrusted(req)) {
      return sendJson(res, 403, { ok: false, error: { message: 'untrusted host' } })
    }
    const url = String(req.url ?? '')
    const path = url.split(/[?#]/, 1)[0]
    const method = String(req.method ?? 'GET').toUpperCase()

    if (path === `${PREFIX}/state` && method !== 'PUT' && method !== 'DELETE') {
      return sendJson(res, 200, { ok: true, value: buildState(ctx, lazy, notes) })
    }

    if (path === `${PREFIX}/add` && method === 'POST') {
      const body = await readJsonBody(req)
      // Parse and validate everything BEFORE touching the profile: a rejected
      // paste must leave the file byte-identical.
      const rows = rowsFromRequest(body)
      const value = await appendRows(ctx, rows)
      return sendJson(res, 200, { ok: true, value })
    }

    if (path === `${PREFIX}/toggle` && method === 'POST') {
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' && body.id.length > 0 ? body.id : null
      if (!id) {
        return sendJson(res, 400, { ok: false, error: { message: 'id must be a non-empty string' } })
      }
      const enabled = body?.enabled === true
      const manager = ctx.get('pluginManager')
      if (typeof manager?.setPluginEnabled !== 'function') {
        return sendJson(res, 501, {
          ok: false,
          error: { message: 'pluginManager.setPluginEnabled is unavailable in this composition' },
        })
      }

      // The panel names a row by its patch id (`mcp-tavily`); setPluginEnabled
      // takes the Loader ENTRY identity instead (`include:mcp-tavily`), and
      // listPlugins() is the only place that mapping is published. Passing the
      // patch id straight through fails with `unknown-plugin` and changes
      // nothing, so this lookup is not optional.
      const plugins = await manager.listPlugins()
      const row = (plugins ?? []).find((plugin) => plugin.patchId === id)
      if (!row) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: 'unknown-plugin', message: `no plugin row carries the patch id "${id}"` },
        })
      }
      if (row.readOnlyReason) {
        return sendJson(res, 409, {
          ok: false,
          error: {
            code: row.readOnlyReason,
            message: `row "${id}" cannot be toggled (${row.readOnlyReason})`,
          },
        })
      }

      const result = await manager.setPluginEnabled(row.entryId, enabled)
      return sendJson(res, 200, { ok: true, value: result ?? null })
    }

    if (path === `${PREFIX}/lazy` && method === 'POST') {
      const body = await readJsonBody(req)
      const server = typeof body?.server === 'string' ? body.server.trim() : ''
      if (server.length === 0) {
        return sendJson(res, 400, { ok: false, error: { message: 'server must be a non-empty string' } })
      }
      const wantLazy = body?.lazy === true
      // Only live rows are addressable: a stale panel tab must not invent a
      // server name into the persisted list.
      const known = readRows(ctx).some((row) => row.serverName === server)
      if (!known) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: 'unknown-server', message: `no mcp-client row serves "${server}"` },
        })
      }
      const next = new Set(lazy)
      if (wantLazy) next.add(server)
      else next.delete(server)
      const lazyServers = [...next].sort()
      await serializeWrite(() => persistSettings(ctx, { lazyServers, serverNotes: notes }))
      return sendJson(res, 200, { ok: true, value: { server, lazy: wantLazy, lazyServers } })
    }

    if (path === `${PREFIX}/note` && method === 'POST') {
      const body = await readJsonBody(req)
      const server = typeof body?.server === 'string' ? body.server.trim() : ''
      if (server.length === 0) {
        return sendJson(res, 400, { ok: false, error: { message: 'server must be a non-empty string' } })
      }
      if (typeof body?.note !== 'string') {
        return sendJson(res, 400, { ok: false, error: { message: 'note must be a string (send "" to clear it)' } })
      }
      const note = body.note.trim()
      if (note.length > MAX_NOTE) {
        return sendJson(res, 400, {
          ok: false,
          error: { message: `note must be at most ${MAX_NOTE} characters` },
        })
      }
      // Same rule as the lazy switch: only live rows are addressable, so a
      // stale panel tab cannot persist a note for a server that no longer exists.
      const known = readRows(ctx).some((row) => row.serverName === server)
      if (!known) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: 'unknown-server', message: `no mcp-client row serves "${server}"` },
        })
      }
      const serverNotes = { ...notes }
      if (note.length === 0) delete serverNotes[server]
      else serverNotes[server] = note
      await serializeWrite(() => persistSettings(ctx, { lazyServers: [...lazy], serverNotes }))
      return sendJson(res, 200, { ok: true, value: { server, note, serverNotes } })
    }

    return sendJson(res, 404, { ok: false, error: { message: `unknown endpoint ${path}` } })
  } catch (error) {
    return sendJson(res, Number(error?.status) || 500, {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    })
  }
}
