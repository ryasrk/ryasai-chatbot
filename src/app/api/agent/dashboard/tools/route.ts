import { getActiveUser, handleApiError } from '@/lib/session'

const DASHBOARD_TOOLS = [
  { id: 'database.connect', category: 'database', name: 'Connect Database', description: 'Hubungkan database baru', status: 'available' },
  { id: 'database.disconnect', category: 'database', name: 'Disconnect', description: 'Putuskan koneksi database', status: 'available' },
  { id: 'database.schema', category: 'database', name: 'Inspect Schema', description: 'Inspeksi skema database', status: 'available' },
  { id: 'database.query', category: 'database', name: 'Test Query', description: 'Jalankan kueri uji', status: 'available' },
  { id: 'database.refresh', category: 'database', name: 'Refresh Metadata', description: 'Refresh metadata database', status: 'available' },
  { id: 'knowledge.upload', category: 'knowledge', name: 'Upload', description: 'Unggah dokumen baru', status: 'available' },
  { id: 'knowledge.delete', category: 'knowledge', name: 'Delete', description: 'Hapus dokumen', status: 'available' },
  { id: 'knowledge.reindex', category: 'knowledge', name: 'Reindex', description: 'Re-index knowledge base', status: 'available' },
  { id: 'knowledge.search', category: 'knowledge', name: 'Search', description: 'Cari di knowledge base', status: 'available' },
  { id: 'knowledge.summarize', category: 'knowledge', name: 'Summarize', description: 'Rangkum dokumen', status: 'available' },
  { id: 'api.create', category: 'api', name: 'Create Endpoint', description: 'Buat endpoint REST', status: 'available' },
  { id: 'api.update', category: 'api', name: 'Update Endpoint', description: 'Update endpoint REST', status: 'available' },
  { id: 'api.test', category: 'api', name: 'Test Endpoint', description: 'Tes endpoint REST', status: 'available' },
  { id: 'api.example', category: 'api', name: 'Generate Example', description: 'Buat contoh request', status: 'available' },
  { id: 'monitoring.traces', category: 'monitoring', name: 'Traces', description: 'Lihat trace request', status: 'available' },
  { id: 'monitoring.metrics', category: 'monitoring', name: 'Metrics', description: 'Lihat metrik', status: 'available' },
  { id: 'monitoring.logs', category: 'monitoring', name: 'Logs', description: 'Cari log', status: 'available' },
  { id: 'monitoring.audit', category: 'monitoring', name: 'Audit', description: 'Lihat audit log', status: 'available' },
  { id: 'monitoring.latency', category: 'monitoring', name: 'Latency', description: 'Cek latensi API', status: 'available' },
  { id: 'security.apikeys', category: 'security', name: 'API Keys', description: 'Kelola API keys', status: 'available' },
  { id: 'security.permissions', category: 'security', name: 'Permissions', description: 'Lihat permissions', status: 'available' },
  { id: 'security.users', category: 'security', name: 'Users', description: 'Lihat users', status: 'available' },
  { id: 'security.roles', category: 'security', name: 'Roles', description: 'Lihat roles', status: 'available' },
  { id: 'provider.openai', category: 'provider', name: 'OpenAI', description: 'Konfigurasi provider OpenAI', status: 'available' },
  { id: 'provider.anthropic', category: 'provider', name: 'Anthropic', description: 'Konfigurasi provider Anthropic', status: 'available' },
  { id: 'provider.gemini', category: 'provider', name: 'Gemini', description: 'Konfigurasi provider Gemini', status: 'available' },
  { id: 'provider.ollama', category: 'provider', name: 'Ollama', description: 'Konfigurasi provider Ollama', status: 'available' },
  { id: 'provider.openrouter', category: 'provider', name: 'OpenRouter', description: 'Konfigurasi provider OpenRouter', status: 'available' },
] as const

export async function GET() {
  try {
    await getActiveUser()
    return Response.json({ tools: DASHBOARD_TOOLS })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat daftar tools.')
  }
}
