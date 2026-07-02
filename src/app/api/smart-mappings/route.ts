import { NextRequest, NextResponse } from 'next/server'
import { generateChat } from '@/lib/ai'
import { db } from '@/lib/db'
import {
  buildSmartMappingPrompt,
  inferSmartMappingFromSummary,
  mergeSmartMapping,
  normalizeSmartMapping,
} from '@/lib/smart-mapping'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export async function GET() {
  try {
    const user = await getActiveUser()
    const rows = await db.smartMapping.findMany({
      where: { companyId: user.companyId },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({
      ok: true,
      items: rows.map((row) => ({
        ...row,
        fields: safeJson(row.fieldsJson, []),
        synonyms: safeJson(row.synonymsJson, []),
      })),
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat smart mappings.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const body = (await req.json().catch(() => ({}))) as {
      sourceType?: string
      sourceId?: string
      sourceName?: string
      summary?: string
    }
    const sourceType = (body.sourceType ?? 'MANUAL').trim().toUpperCase()
    const sourceId = typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : null
    const source = await resolveSourceSummary(user.companyId, sourceType, sourceId, body.sourceName, body.summary)
    const prompt = buildSmartMappingPrompt({
      sourceType,
      sourceName: source.name,
      summary: source.summary,
    })

    const inferred = inferSmartMappingFromSummary({
      sourceType,
      sourceName: source.name,
      summary: source.summary,
    })
    let mapping = inferred
    try {
      const raw = await generateChat(prompt, user.companyId)
      mapping = mergeSmartMapping(
        normalizeSmartMapping(JSON.parse(raw.replace(/```json|```/g, '').trim())),
        inferred,
      )
    } catch {
      /* lexical fallback stays useful when LLM unavailable */
    }

    const row = await db.smartMapping.create({
      data: {
        companyId: user.companyId,
        sourceType,
        sourceId,
        sourceName: source.name,
        entityType: mapping.entityType,
        routingHint: mapping.routingHint,
        fieldsJson: JSON.stringify(mapping.fields),
        synonymsJson: JSON.stringify(mapping.synonyms),
        status: 'active',
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'SMART_MAPPING_GENERATE',
      severity: 'info',
      detail: { sourceType, sourceId, sourceName: source.name, entityType: mapping.entityType },
    })

    return NextResponse.json({
      ok: true,
      item: {
        ...row,
        fields: mapping.fields,
        synonyms: mapping.synonyms,
      },
    }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat smart mapping.')
  }
}

async function resolveSourceSummary(
  companyId: string,
  sourceType: string,
  sourceId: string | null,
  sourceName?: string,
  summary?: string,
): Promise<{ name: string; summary: string }> {
  if (sourceType === 'DATABASE' && sourceId) {
    const integration = await db.integration.findFirst({
      where: { id: sourceId, companyId },
      include: { schemas: { orderBy: { tableName: 'asc' } } },
    })
    if (integration) {
      return {
        name: integration.name,
        summary: integration.schemas
          .map((schema) => `${schema.tableName}(${schema.columns})`)
          .join('\n')
          .slice(0, 6000),
      }
    }
  }
  if (sourceType === 'DOCUMENT' && sourceId) {
    const doc = await db.document.findFirst({ where: { id: sourceId, companyId } })
    if (doc) return { name: doc.name, summary: doc.contentText.slice(0, 6000) }
  }
  if (sourceType === 'REST_API' && sourceId) {
    const connector = await db.restApiConnector.findFirst({
      where: { id: sourceId, companyId },
      include: { endpoints: true },
    })
    if (connector) {
      return {
        name: connector.name,
        summary: connector.endpoints
          .map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.description ?? ''} ${endpoint.sampleResponse ?? ''}`)
          .join('\n')
          .slice(0, 6000),
      }
    }
  }
  return {
    name: sourceName?.trim() || 'Manual source',
    summary: summary?.trim() || '',
  }
}

function safeJson(raw: string, fallback: unknown) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}
