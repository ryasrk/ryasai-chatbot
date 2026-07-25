import type { PrismaClient } from '@prisma/client'

export interface PromptSettings {
  systemPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

const DEFAULTS: PromptSettings = {
  systemPrompt: '',
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
  update: { systemPrompt?: unknown; tools?: Partial<PromptSettings['tools']> },
): PromptSettings {
  return {
    systemPrompt:
      typeof update.systemPrompt === 'string' ? update.systemPrompt : current.systemPrompt,
    tools: {
      rag: typeof update.tools?.rag === 'boolean' ? update.tools.rag : current.tools.rag,
      sql: typeof update.tools?.sql === 'boolean' ? update.tools.sql : current.tools.sql,
      restApi:
        typeof update.tools?.restApi === 'boolean' ? update.tools.restApi : current.tools.restApi,
    },
  }
}

export async function getPromptSettings(
  db: PrismaClient,
): Promise<PromptSettings> {
  const cfg = await db.appConfig.findFirst()
  return parsePromptSettings(cfg?.promptSettings)
}
