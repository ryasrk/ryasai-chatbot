export interface PromptSettings {
  systemPrompt: string
  // ponytail: org-wide RAG context prompt — prepended to every RAG answer
  // synthesis (buildSourceGuidance in source-guidance.ts). Empty → injects
  // nothing, so the field must default to '' for existing orgs whose stored
  // JSON predates the key (backward-compat fill in parsePromptSettings).
  ragContextPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

const DEFAULTS: PromptSettings = {
  systemPrompt: '',
  ragContextPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}

/**
 * Safely parse the `promptSettings` JSON column. Never throws — returns
 * defaults for null/undefined/garbage and fills missing keys so partial writes
 * (e.g. only `tools.sql`) don't wipe the rest.
 */
export function parsePromptSettings(json: string | null | undefined): PromptSettings {
  if (!json) return structuredClone(DEFAULTS)
  try {
    const raw = JSON.parse(json) as Partial<PromptSettings>
    return {
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
      // Backward-compat: old JSON without this key must resolve to '' so a
      // missing key never injects `undefined`-as-string into a RAG prompt.
      ragContextPrompt: typeof raw.ragContextPrompt === 'string' ? raw.ragContextPrompt : '',
      tools: {
        rag: raw.tools?.rag ?? true,
        sql: raw.tools?.sql ?? true,
        restApi: raw.tools?.restApi ?? true,
      },
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

/**
 * Merge a partial update over the current settings. Unknown/invalid types are
 * ignored so a bad PUT body can't corrupt the column.
 */
export function mergePromptSettings(
  current: PromptSettings,
  update: { systemPrompt?: unknown; ragContextPrompt?: unknown; tools?: Partial<PromptSettings['tools']> },
): PromptSettings {
  return {
    systemPrompt:
      typeof update.systemPrompt === 'string' ? update.systemPrompt : current.systemPrompt,
    // String-only — a non-string (e.g. number/null from a bad body) is ignored
    // rather than stringified, so only deliberate text updates land here.
    ragContextPrompt:
      typeof update.ragContextPrompt === 'string' ? update.ragContextPrompt : current.ragContextPrompt,
    tools: {
      rag: typeof update.tools?.rag === 'boolean' ? update.tools.rag : current.tools.rag,
      sql: typeof update.tools?.sql === 'boolean' ? update.tools.sql : current.tools.sql,
      restApi:
        typeof update.tools?.restApi === 'boolean' ? update.tools.restApi : current.tools.restApi,
    },
  }
}

// ponytail: accept the tenant-extended db (not plain PrismaClient) so callers
// can pass the $extends client without a cast.
export async function getPromptSettings(
  db: typeof import('@/lib/db').db,
): Promise<PromptSettings> {
  const cfg = await db.appConfig.findFirst()
  return parsePromptSettings(cfg?.promptSettings)
}
