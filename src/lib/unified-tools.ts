/**
 * Unified Agent Tool System — Frontier AI standard.
 * ----------------------------------------------------------------------------
 * Unifies Built-in (SQL/RAG/REST/Web), Plugins, MCP servers, and Admin tools
 * into a single, strictly-typed interface with full JSON Schema support.
 *
 * Provides:
 * - Deterministic function name encoding/decoding conforming to `^[a-zA-Z0-9_-]{1,64}$`
 * - Lossless JSON Schema passthrough for MCP tools
 * - Automatic circuit breaker integration to prevent cascading failures
 * - Sandboxed execution and rate limiting per tool type
 */
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { runNonStreamingChatCompletion } from '@/lib/chat-completion-port'
import { fetchUrlForPlanner, webSearch, isWebSearchAvailable } from '@/lib/web-fetch'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin, parsePluginManifest } from '@/lib/plugin-registry'
import { withToolSandbox } from '@/lib/tool-sandbox'
import { toolCircuitBreaker } from '@/lib/tool-circuit-breaker'
import { logSwallowed } from '@/lib/logger'
import { toolIdToFunctionName, type UnifiedTool } from '@/lib/unified-tool-core'
import { buildMcpUnifiedTools, buildMcpResourceAndPromptTools } from '@/lib/unified-tools-mcp'
import { buildAdminUnifiedTools } from '@/lib/unified-tools-admin'
export { buildAdminUnifiedTools } from '@/lib/unified-tools-admin'
export { buildMcpUnifiedTools, buildMcpResourceAndPromptTools } from '@/lib/unified-tools-mcp'
export { toolIdToFunctionName, functionNameToToolId, toLlmToolDef } from '@/lib/unified-tool-core'
export type { ToolExecutionContext, ToolExecutionResult, UnifiedTool } from '@/lib/unified-tool-core'

export const SQL_TOOL: UnifiedTool = {
  id: 'sql',
  name: toolIdToFunctionName('sql'),
  /*
   * THE DESCRIPTION STATES THE ROLE, NOT JUST THE TOPICS — and that is load-bearing on a deployment where a DATABASE
   * and a DOCUMENT set cover the same subject. MEASURED: an HR database (karyawan, cuti, absensi) sits beside HR policy
   * documents, and questions phrased like a data query ("berapa hari cuti tahunan karyawan tetap") were routed here on
   * the strength of the table names, then answered with transaction figures instead of the policy rule — one answer
   * said "Total cuti tahunan: 37 hari" from six leave requests where the policy says 12.
   *
   * The role distinction ("what the records SAY" vs "what the rules DEFINE") is what separates the two, so it is
   * stated in the tool's own description. It is deliberately NOT a new rule in the system prompt: MEASURED at N=40, the
   * existing rule list already costs accuracy, two separate rules costing ~37pp each, which is why it is kept short.
   */
  description:
    'Query the RECORDS held in connected business databases (transactions, balances, quantities, statuses, who-did-'
    + 'what) — sales, orders, customers, inventory, invoices, employees, financial figures. Use this for what the data '
    + 'SAYS: counts, totals, lists, the current state of records. Do NOT use it for what a policy, SOP or rule DEFINES '
    + '(entitlements, procedures, thresholds, limits): those are stated in documents, even when a table of the same '
    + 'subject exists. Input must be a clear natural language question.',
  category: 'database',
  requiresDataSource: 'integration',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Natural language question to query against the connected SQL database tables',
      },
      // Declared so the model can actually EXPRESS a choice. Without it the field
      // has nowhere to live: the model returns only `arguments`, so naming a
      // database in prose was silently dropped and EVERY selection came back
      // empty (measured with 23 databases: 8/8 picks lost). Not `required`,
      // because a single-database install has nothing to choose and a strict
      // provider would reject an unfillable required field.
      database: {
        type: 'string',
        description:
          'Name of the database to query, exactly as listed in the tool description. Omit when only one is connected.',
      },
    },
    required: ['question'],
  },
  async execute(params, context) {
    const start = Date.now()
    const question = String(params.question || params.query || '')
    if (!question.trim()) {
      return { ok: false, output: '', error: 'Question parameter is required for query_database', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question,
        userId: context.userId,
        sessionId: context.sessionId,
        documentIds: context.documentIds,
        integrationIds: context.integrationIds,
      })
      const failed = completion.toolRuns.find((tr) => tr.status === 'error' || tr.status === 'blocked')
      if (failed) {
        return {
          ok: false,
          output: completion.answer || '',
          error: failed.errorMessage ?? 'Database query execution failed',
          latencyMs: Date.now() - start,
        }
      }
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const RAG_TOOL: UnifiedTool = {
  id: 'rag',
  name: toolIdToFunctionName('rag'),
  description:
    'Search company documents, SOPs, policies, procedures and internal regulations — what the RULES DEFINE: '
    + 'entitlements, thresholds, limits, required steps and the conditions attached to them. Use this whenever the '
    + 'question asks what is ALLOWED or REQUIRED or what the rule states, even when a database table of the same '
    + 'subject exists: a leave entitlement is a policy figure, not a sum of leave requests.',
  category: 'knowledge',
  requiresDataSource: 'document',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query describing the specific document topics or knowledge needed',
      },
      topK: {
        type: 'integer',
        description: 'Maximum number of document passages to retrieve (default: 5, max: 15)',
      },
    },
    required: ['query'],
  },
  async execute(params, context) {
    const start = Date.now()
    const query = String(params.query || params.question || '')
    if (!query.trim()) {
      return { ok: false, output: '', error: 'Query parameter is required for search_knowledge_base', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question: query,
        userId: context.userId,
        sessionId: context.sessionId,
        documentIds: context.documentIds,
        integrationIds: context.integrationIds,
      })
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const REST_TOOL: UnifiedTool = {
  id: 'rest',
  name: toolIdToFunctionName('rest'),
  description:
    'Call whitelisted external operational REST APIs (e.g. ERP, CRM, HRIS, shipping/inventory service).',
  category: 'api',
  requiresDataSource: 'rest',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Natural language request for what to fetch or submit to connected REST APIs',
      },
    },
    required: ['question'],
  },
  async execute(params, context) {
    const start = Date.now()
    const question = String(params.question || params.query || '')
    if (!question.trim()) {
      return { ok: false, output: '', error: 'Question parameter is required for call_rest_api', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question,
        userId: context.userId,
        sessionId: context.sessionId,
        documentIds: context.documentIds,
        integrationIds: context.integrationIds,
      })
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const WEB_SEARCH_TOOL: UnifiedTool = {
  id: 'web_search',
  name: 'web_search',
  description:
    'Search the live internet for current events, news, or external factual knowledge not in local databases. Returns URLs, titles, and snippets.',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up on the web',
      },
    },
    required: ['query'],
  },
  async execute(params) {
    const start = Date.now()
    const query = String(params.query || params.search || '')
    if (!query.trim()) {
      return { ok: false, output: '', error: 'Query parameter is required for web_search', latencyMs: 0 }
    }

    try {
      const res = await webSearch(query)
      if (!res.ok) {
        return { ok: false, output: '', error: res.error, latencyMs: Date.now() - start }
      }
      const formatted = res.results
        .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
        .join('\n\n')
      return { ok: true, output: formatted, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const WEB_FETCH_TOOL: UnifiedTool = {
  id: 'web_fetch',
  name: 'web_fetch',
  description:
    'Fetch and extract human-readable text content from any public HTTP/HTTPS URL (documentation pages, GitHub, articles).',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL to fetch content from',
      },
    },
    required: ['url'],
  },
  async execute(params) {
    const start = Date.now()
    const url = String(params.url || params.link || '')
    if (!url.trim()) {
      return { ok: false, output: '', error: 'URL parameter is required for web_fetch', latencyMs: 0 }
    }

    try {
      const res = await fetchUrlForPlanner(url)
      return {
        ok: res.ok,
        output: res.ok ? res.content : '',
        error: res.ok ? undefined : res.error,
        latencyMs: Date.now() - start,
      }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const DIRECT_CHAT_TOOL: UnifiedTool = {
  id: 'chat',
  name: toolIdToFunctionName('chat'),
  description:
    'Respond directly to the user for general conversation, greetings, clarifications, or syntheses where no further external tools are needed.',
  category: 'chat',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The direct conversational response to present to the user',
      },
    },
    required: ['message'],
  },
  async execute(params) {
    const message = String(params.message || params.text || '')
    return { ok: true, output: message, latencyMs: 0 }
  },
}

/**
 * The built-in tools, minus any whose backend cannot work on this install.
 *
 * `web_search` is CONDITIONAL. Its fallback scrapes DuckDuckGo, which is blocked
 * outright on some networks (MEASURED here: the host served an ISP interstitial
 * and every query failed with ERR_TLS_CERT_ALTNAME_INVALID). Offering it anyway
 * was actively harmful: asked "cuaca di jakarta" the model chose the broken
 * `web_search` over the `weather` plugin that returns real data, on both model
 * families tested, 10 of 10 runs. A tool listed but unable to succeed does not
 * merely waste a call — it outranks the correct tool.
 *
 * `web_fetch` is NOT conditional: retrieval of a known URL works regardless of
 * any search backend (verified against Wikipedia, example.com and a JSON API).
 */
export function getCoreBuiltInTools(): UnifiedTool[] {
  return [
    SQL_TOOL,
    RAG_TOOL,
    REST_TOOL,
    ...(isWebSearchAvailable() ? [WEB_SEARCH_TOOL] : []),
    WEB_FETCH_TOOL,
    DIRECT_CHAT_TOOL,
  ]
}

/** Every built-in tool, including conditionally-available ones. For tests and for
 *  catalogues that must be exhaustive rather than operational. */
export const CORE_BUILT_IN_TOOLS: UnifiedTool[] = [
  SQL_TOOL,
  RAG_TOOL,
  REST_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  DIRECT_CHAT_TOOL,
]

// ---------------------------------------------------------------------------
// Admin Tools Adapter
// ---------------------------------------------------------------------------

export async function buildPluginUnifiedTools(args: { query: string; context?: 'chat' | 'agentic' }): Promise<UnifiedTool[]> {
  try {
    const plugins = await selectRelevantPlugins({ query: args.query, context: args.context })
    return plugins.map((plugin) => {
      const manifest = parsePluginManifest(plugin.manifestJson)
      const toolId = `plugin:${plugin.toolId}`
      const fnName = toolIdToFunctionName(toolId)

      return {
        id: toolId,
        name: fnName,
        description: `[Plugin] ${plugin.description}`,
        category: 'plugin' as const,
        // A manifest that declares a JSON Schema gets it passed through verbatim,
        // exactly like an MCP tool's `inputSchema`. Without one, fall back to the
        // legacy single-string `input` contract so existing plugins keep working.
        parameters: manifest?.parameters ?? {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: manifest?.paramDescription || plugin.description || 'Parameters for the plugin',
            },
          },
        },
        async execute(params, context) {
          const start = Date.now()
          const cb = toolCircuitBreaker.isExecutionAllowed(toolId)
          if (!cb.allowed) {
            return { ok: false, output: '', error: cb.reason, latencyMs: 0 }
          }

          const orgId = context.organizationId || getOrgContext()
          try {
            // A manifest WITH a schema takes the structured path (real types
            // preserved); without one, keep the legacy stringified blob exactly
            // as before so existing plugins behave identically.
            const res = await withToolSandbox(toolId, () =>
              manifest?.parameters
                ? executePlugin({ plugin, args: params })
                : executePlugin({
                    plugin,
                    input: typeof params.input === 'string' ? params.input : JSON.stringify(params),
                  }),
            )

            if (res.ok) {
              toolCircuitBreaker.recordSuccess(toolId)
            } else {
              toolCircuitBreaker.recordFailure(toolId, res.error)
            }

            if (orgId) {
              await db.toolRun.create({
                data: {
                  organizationId: orgId,
                  chatMessageId: null,
                  type: 'PLUGIN',
                  status: res.ok ? 'success' : 'error',
                  latencyMs: res.latencyMs,
                  inputSummary: `Plugin: ${plugin.toolId}`,
                  outputSummary: (res.output || '').slice(0, 500) || null,
                  errorMessage: res.error ?? null,
                },
              }).catch(logSwallowed('unified-tools: toolRun.create (Plugin)'))
            }

            return {
              ok: res.ok,
              output: res.output,
              error: res.error,
              latencyMs: res.latencyMs,
            }
          } catch (err) {
            toolCircuitBreaker.recordFailure(toolId, err)
            return {
              ok: false,
              output: '',
              error: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - start,
            }
          }
        },
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Unified Catalog Resolver
// ---------------------------------------------------------------------------

export async function getUnifiedTools(args: {
  query: string
  context: 'chat' | 'agentic'
  isAdmin?: boolean
  /**
   * An API key's allowed tool families (`SQL | RAG | REST | CHAT`), or `null`/absent for every tool.
   *
   * WHY THE FILTER LIVES HERE. This function is the single place the tool surface is ASSEMBLED, so it is the
   * only place a family can be removed before anything can choose it. `scopeAllowsTool` existed in
   * `api-key-scope.ts` with ZERO production callers — the scope was stored, validated and displayed while
   * enforcing nothing, so a key restricted to `['RAG']` could still run SQL. An audit measured that.
   *
   * REMOVING RATHER THAN REFUSING, deliberately: a tool the key may not use must not appear in the list the
   * model chooses from, because a model offered a tool will eventually pick it. The refusal for an EXPLICIT
   * request lives in the transport (`ScopeDeniedError`), which is a different question from "what may I
   * offer".
   */
  allowedTools?: string[] | null
}): Promise<UnifiedTool[]> {
  const tools: UnifiedTool[] = getCoreBuiltInTools()

  if (args.context === 'agentic' && args.isAdmin) {
    tools.push(...buildAdminUnifiedTools())
  }

  // PLUGINS ARE AGENTIC-ONLY. MEASURED: on the chat path 7 of 8 ordinary
  // questions pulled in irrelevant plugins, and the damage was not just noise —
  // "berapa penjualan bulan lalu" selected `datetime` because of the word
  // "bulan", and "berapa 15% dari 2 juta" failed to select `calculator` at all.
  // Chat's real tools are SQL, RAG and REST; a web-search or timezone plugin
  // has no business in that decision, and every irrelevant tool is both tokens
  // and a chance to mis-route. Agentic is where open-ended tool use belongs.
  const pluginTools = args.context === 'agentic'
    ? await buildPluginUnifiedTools({ query: args.query, context: 'agentic' })
    : []
  const [mcpTools, mcpSurfaceTools] = await Promise.all([
    buildMcpUnifiedTools(),
    // Resources and prompts are a SEPARATE surface: a server may expose them and
    // no tools at all, so they cannot be folded into buildMcpUnifiedTools.
    buildMcpResourceAndPromptTools(),
  ])

  tools.push(...pluginTools)
  tools.push(...mcpTools)
  tools.push(...mcpSurfaceTools)

  /*
   * Apply the API-key tool scope LAST, after every family has been added.
   *
   * LAST is load-bearing: filtering earlier would leave the plugins/MCP pushes below able to re-introduce a
   * family the key may not use, which is the shape of bypass this whole review kept finding. One filter at
   * the exit cannot be bypassed by a new family added above it.
   */
  const allowed = args.allowedTools
  if (allowed && allowed.length > 0) {
    const permitted = new Set(allowed.map((t) => t.toUpperCase()))
    return tools.filter((t) => {
      /*
       * MAP category -> SCOPE FAMILY, because the two vocabularies differ and pretending otherwise is how a
       * filter silently matches nothing (or everything).
       *
       * `UnifiedTool.category` is 'database' | 'knowledge' | 'api' | 'plugin' | 'mcp' | 'admin' | 'web' | 'chat'.
       * The API-key scope speaks 'SQL' | 'RAG' | 'REST' | 'CHAT' (API_KEY_TOOLS).
       *
       * UNMAPPED categories (plugin, mcp, admin, web and anything added later) are governed by CHAT: with
       * `allowedTools: ['CHAT']` they are removed, because a web-search or an MCP server is a capability an
       * operator restricting a partner key to "conversation only" does not expect to grant. That is the
       * fail-closed direction, and it is why this is a whitelist rather than a blacklist.
       */
      const familiesFor = (category: string): string[] => {
        switch (category) {
          case 'database': return ['SQL']
          case 'knowledge': return ['RAG']
          case 'api': return ['REST']
          case 'chat': return ['CHAT']
          /*
           * EVERY OTHER FAMILY NEEDS ITS OWN EXPLICIT GRANT.
           *
           * This arm first returned `['CHAT', 'PLUGIN', 'MCP']`, which was WRONG and the test caught it: with
           * `allowedTools: ['CHAT']` a `web` tool SURVIVED, because 'CHAT' was in its permitted set. Measured
           * after the fix: `['CHAT']` yields category `chat` alone, while `null` still yields all five.
           *
           * The rule an operator expects: "conversation only" does not grant a web search, an MCP server, a
           * plugin or an admin tool. The default is therefore FAIL-CLOSED (nothing permitted) rather than a
           * guess at permissiveness — an unknown future category must be granted deliberately, not by omission.
           */
          case 'web': return ['WEB']
          case 'plugin': return ['PLUGIN']
          case 'mcp': return ['MCP']
          case 'admin': return ['ADMIN']
          default: return ['UNKNOWN']
        }
      }
      const families = familiesFor(t.category)
      return families.some((f) => permitted.has(f))
    })
  }

  return tools
}
