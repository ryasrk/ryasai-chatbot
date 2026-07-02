export type SmartMappingRoute = 'SQL' | 'RAG' | 'REST' | 'CHAT'

export interface SmartMappingField {
  source: string
  canonical: string
}

export interface SmartMappingData {
  entityType: string
  routingHint: SmartMappingRoute
  fields: SmartMappingField[]
  synonyms: string[]
}

export interface SmartMappingUpdate {
  sourceName?: string
  entityType?: string
  routingHint?: SmartMappingRoute
  fields?: SmartMappingField[]
  synonyms?: string[]
  status?: 'active' | 'draft' | 'disabled'
}

export function normalizeSmartMapping(raw: unknown): SmartMappingData {
  const data = asRecord(raw)
  const fields = Array.isArray(data.fields)
    ? data.fields.map((item) => {
        const row = asRecord(item)
        return {
          source: String(row.source ?? '').trim(),
          canonical: String(row.canonical ?? '').trim(),
        }
      }).filter((row) => row.source && row.canonical)
    : []

  return {
    entityType: String(data.entityType ?? 'general').trim() || 'general',
    routingHint: normalizeRoute(String(data.routingHint ?? 'CHAT')),
    fields,
    synonyms: Array.isArray(data.synonyms)
      ? Array.from(new Set(data.synonyms.map(String).map((item) => item.trim()).filter(Boolean)))
      : [],
  }
}

export function buildSmartMappingPrompt(args: {
  sourceType: string
  sourceName: string
  summary: string
}): string {
  return [
    'Buat smart mapping enterprise dari metadata sumber berikut.',
    `Source type: ${args.sourceType}`,
    `Source name: ${args.sourceName}`,
    `Summary: ${args.summary}`,
    'Jawab JSON saja: {"entityType":"inventory|invoice|customer|ticket|policy|general","routingHint":"SQL|RAG|REST|CHAT","fields":[{"source":"...","canonical":"..."}],"synonyms":["..."]}',
  ].join('\n')
}

export function inferSmartMappingFromSummary(args: {
  sourceType: string
  sourceName: string
  summary: string
}): SmartMappingData {
  const text = `${args.sourceName} ${args.summary}`.toLowerCase()
  const fields: SmartMappingField[] = []
  const synonyms: string[] = []
  let entityType = 'general'

  const add = (source: string, canonical: string) => {
    if (!fields.some((field) => field.source === source && field.canonical === canonical)) {
      fields.push({ source, canonical })
    }
  }

  if (/(sku|stock|stok|inventory|warehouse|quantity|qty)/.test(text)) {
    entityType = 'inventory'
    synonyms.push('stok', 'stock', 'inventory', 'qty', 'quantity', 'gudang')
    add('sku', 'sku')
    add('quantity', 'quantity')
    add('warehouse', 'warehouse')
  }
  if (/(invoice|amount|payment|pembayaran|tagihan)/.test(text)) {
    entityType = entityType === 'general' ? 'invoice' : entityType
    synonyms.push('invoice', 'tagihan', 'pembayaran', 'amount')
    add('invoice', 'invoice')
    add('amount', 'amount')
  }
  if (/(customer|pelanggan|client)/.test(text)) {
    entityType = entityType === 'general' ? 'customer' : entityType
    synonyms.push('customer', 'pelanggan', 'client')
    add('customer', 'customer')
  }
  if (/(ticket|incident|issue|sla)/.test(text)) {
    entityType = entityType === 'general' ? 'ticket' : entityType
    synonyms.push('ticket', 'incident', 'sla', 'status')
    add('status', 'status')
  }

  const routingHint: SmartMappingRoute =
    args.sourceType === 'DATABASE'
      ? 'SQL'
      : args.sourceType === 'REST_API'
        ? 'REST'
        : args.sourceType === 'DOCUMENT'
          ? 'RAG'
          : 'CHAT'

  return normalizeSmartMapping({ entityType, routingHint, fields, synonyms })
}

export function mergeSmartMapping(
  ai: SmartMappingData,
  inferred: SmartMappingData,
): SmartMappingData {
  return normalizeSmartMapping({
    entityType:
      ai.entityType === 'general' && inferred.entityType !== 'general'
        ? inferred.entityType
        : ai.entityType,
    routingHint: ai.routingHint === 'CHAT' ? inferred.routingHint : ai.routingHint,
    fields: ai.fields.length > 0 ? ai.fields : inferred.fields,
    synonyms: [...ai.synonyms, ...inferred.synonyms],
  })
}

export function normalizeSmartMappingUpdate(raw: unknown): SmartMappingUpdate {
  const data = asRecord(raw)
  const update: SmartMappingUpdate = {}
  const sourceName = normalizeOptionalString(data.sourceName)
  const entityType = normalizeOptionalString(data.entityType)
  const routingHint = normalizeOptionalString(data.routingHint)
  const status = normalizeOptionalString(data.status)

  if (sourceName) update.sourceName = sourceName
  if (entityType) update.entityType = entityType
  if (routingHint) update.routingHint = normalizeRoute(routingHint)
  if (status === 'active' || status === 'draft' || status === 'disabled') update.status = status

  if (Array.isArray(data.synonyms)) {
    update.synonyms = normalizeSynonyms(data.synonyms.map(String))
  } else if (typeof data.synonyms === 'string') {
    update.synonyms = normalizeSynonyms(data.synonyms.split(/[\n,]+/))
  }

  if (Array.isArray(data.fields)) {
    update.fields = normalizeSmartMapping({ fields: data.fields }).fields
  } else if (typeof data.fieldsText === 'string') {
    update.fields = parseFieldsText(data.fieldsText)
  }

  return update
}

function normalizeRoute(value: string): SmartMappingRoute {
  const route = value.trim().toUpperCase()
  if (route === 'SQL' || route === 'RAG' || route === 'REST' || route === 'CHAT') return route
  return 'CHAT'
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSynonyms(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
}

function parseFieldsText(text: string): SmartMappingField[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.includes('=') ? '=' : ':'
      const [source = '', canonical = ''] = line.split(separator)
      return { source: source.trim(), canonical: canonical.trim() }
    })
    .filter((field) => field.source && field.canonical)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
