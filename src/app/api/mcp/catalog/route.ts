import { NextResponse } from 'next/server'
import { MCP_CATALOG, MCP_CATALOG_CATEGORIES } from '@/lib/mcp-catalog'

export async function GET() {
  return NextResponse.json({ ok: true, catalog: MCP_CATALOG, categories: MCP_CATALOG_CATEGORIES })
}
