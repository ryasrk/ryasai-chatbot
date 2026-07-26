import { db } from '@/lib/db'

export interface ScoredPlugin {
  id: string
  toolId: string
  name: string
  description: string
  manifestJson: string
  category: string
  subcategory: string
  chatEnabled: boolean
  agenticEnabled: boolean
  score: number
}

const STOP_WORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'atau', 'ini',
  'itu', 'juga', 'akan', 'sudah', 'bisa', 'dapat', 'apa', 'bagaimana', 'berapa',
  'siapa', 'kapan', 'dimana', 'mengapa', 'saya', 'kamu', 'ada', 'tidak', 'ya',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'like', 'through',
  'after', 'over', 'between', 'out', 'against', 'during', 'without', 'before',
  'under', 'around', 'among', 'and', 'or', 'but', 'not', 'so', 'than', 'too',
  'very', 'can', 'will', 'just', 'should', 'now', 'how', 'what', 'when', 'where',
  'who', 'why', 'which', 'would', 'could', 'may', 'might', 'must', 'shall',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

function phraseMatch(queryTokens: string[], keywords: string[]): number {
  if (keywords.length === 0) return 0
  const keywordSet = new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))
  let matches = 0
  for (const token of queryTokens) {
    if (keywordSet.has(token)) matches++
  }
  return keywordSet.size > 0 ? matches / keywordSet.size : 0
}

function categoryBoost(queryTokens: string[], category: string, subcategory: string): number {
  const categoryKeywords: Record<string, string[]> = {
    'utility': ['cuaca', 'weather', 'tanggal', 'date', 'time', 'waktu', 'jam', 'timezone', 'zona', 'translate', 'terjemah', 'calculate', 'hitung', 'kalkulator', 'math', 'berita', 'news', 'documentation', 'doc', 'syntax', 'code', 'search', 'siapa', 'who', 'apa', 'what', 'dimana', 'where', 'kapan', 'when', 'kenapa', 'why', 'bagaimana', 'how', 'biography', 'biografi', 'person', 'tokoh', 'sejarah', 'history'],
    'business_intelligence': ['saham', 'stock', 'crypto', 'kripto', 'bitcoin', 'harga', 'kurs', 'nilai', 'tukar', 'exchange', 'rate', 'berita', 'news', 'finance', 'keuangan', 'market', 'pasar', 'ekonomi', 'economy'],
    'productivity': ['email', 'mail', 'surat', 'task', 'tugas', 'calendar', 'kalender', 'jadwal', 'schedule', 'dokumen', 'document', 'pdf', 'sheet', 'spreadsheet', 'notion'],
    'communication': ['slack', 'telegram', 'whatsapp', 'discord', 'chat', 'message', 'pesan', 'kirim', 'send', 'notify', 'notifikasi', 'broadcast'],
    'data_enrichment': ['validasi', 'validate', 'phone', 'telepon', 'email', 'ip', 'location', 'lokasi', 'geolocation', 'geocode', 'address', 'alamat'],
    'ai_ml': ['translate', 'terjemah', 'ocr', 'gambar', 'image', 'sentiment', 'summarize', 'ringkasan', 'ai', 'ml', 'llm', 'generate', 'inference'],
    'developer_tools': ['github', 'gitlab', 'repo', 'repository', 'issue', 'pipeline', 'ci', 'cd', 'deploy', 'monitor', 'uptime', 'code', 'commit'],
    'indonesian': ['indonesia', 'bmkg', 'bps', 'cuaca', 'weather', 'jakarta', 'surabaya', 'bandung', 'statistik', 'pos', 'jisdor', 'bank', 'bi'],
  }

  const subcategoryKeywords: Record<string, string[]> = {
    'stocks': ['saham', 'stock', 'ticker', 'market', 'bursa'],
    'crypto': ['crypto', 'kripto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'coin'],
    'currency': ['kurs', 'exchange', 'rate', 'rupiah', 'idr', 'usd', 'eur', 'currency', 'valuta'],
    'statistics': ['statistik', 'data', 'sensus', 'bps'],
    'email': ['email', 'mail', 'surat', 'sendgrid', 'mailgun'],
    'task_management': ['task', 'tugas', 'todo', 'linear', 'trello', 'asana'],
    'calendar': ['calendar', 'kalender', 'jadwal', 'event', 'meeting'],
    'document': ['pdf', 'document', 'dokumen', 'html', 'generate', 'sheet'],
    'messaging': ['slack', 'telegram', 'whatsapp', 'discord', 'message', 'pesan'],
    'notification': ['notify', 'notifikasi', 'alert', 'broadcast', 'kirim'],
    'phone_validation': ['phone', 'telepon', 'nomor', 'hp', 'validate', 'validasi'],
    'email_validation': ['email', 'validate', 'validasi', 'deliverability'],
    'ip_geolocation': ['ip', 'geolocation', 'location', 'lokasi', 'geo'],
    'geocoding': ['geocode', 'city', 'kota', 'coordinate', 'koordinat', 'lat', 'lon'],
    'translation': ['translate', 'terjemah', 'translation', 'bahasa', 'language'],
    'calculator': ['calculate', 'hitung', 'kalkulator', 'math', 'matematika', 'arithmetic', 'sqrt', 'sum', 'percentage', 'persentase'],
    'documentation': ['documentation', 'doc', 'syntax', 'code', 'programming', 'example', 'contoh', 'snippet', 'function', 'method', 'error', 'debug', 'how', 'cara', 'react', 'vue', 'python', 'javascript', 'typescript', 'hook'],
    'news': ['berita', 'news', 'headline', 'artikel', 'terkini', 'latest'],
    'weather': ['cuaca', 'weather', 'suhu', 'temperature', 'hujan', 'rain', 'forecast', 'prakiraan', 'angin', 'wind'],
    'datetime': ['tanggal', 'date', 'time', 'waktu', 'jam', 'now', 'sekarang', 'current'],
    'timezone': ['timezone', 'zona', 'waktu', 'utc', 'offset', 'dst', 'daylight', 'country'],
    'web_search': ['search', 'cari', 'web', 'internet', 'wikipedia', 'definition', 'definisi', 'apa', 'itu', 'meaning', 'artinya', 'news', 'siapa', 'who', 'tokoh', 'person', 'sejarah', 'history', 'presiden'],
    'web_fetch': ['fetch', 'url', 'link', 'read', 'baca', 'content', 'konten', 'page', 'halaman', 'extract', 'scrape', 'biography', 'biografi', 'siapa', 'who', 'person', 'tokoh', 'detail', 'info'],
  }

  let boost = 0
  const catKw = categoryKeywords[category] ?? []
  const subKw = subcategoryKeywords[subcategory] ?? []

  for (const token of queryTokens) {
    if (catKw.includes(token)) boost += 0.3
    if (subKw.includes(token)) boost += 0.5
  }

  return Math.min(boost, 1.0)
}

export async function selectRelevantPlugins(args: {
  query: string
  topK?: number
  minScore?: number
}): Promise<ScoredPlugin[]> {
  const topK = args.topK ?? 5
  const minScore = args.minScore ?? 0.01

  const plugins = await db.plugin.findMany({
    where: { isEnabled: true },
  })

  if (plugins.length === 0) return []

  const queryTokens = tokenize(args.query)
  if (queryTokens.length === 0) return []

  const queryTokenSet = new Set(queryTokens)

  const scored: ScoredPlugin[] = plugins.map((p) => {
    const pluginKeywords = p.keywords
      ? p.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      : []

    const pluginTokens = tokenize(`${p.name} ${p.description} ${pluginKeywords.join(' ')}`)
    const pluginTokenSet = new Set(pluginTokens)

    const jaccard = jaccardSimilarity(queryTokenSet, pluginTokenSet)
    const phrase = phraseMatch(queryTokens, pluginKeywords)
    const catBoost = categoryBoost(queryTokens, p.category, p.subcategory)

    const score = jaccard * 0.4 + phrase * 0.3 + catBoost * 0.3

    return {
      id: p.id,
      toolId: p.toolId,
      name: p.name,
      description: p.description,
      manifestJson: p.manifestJson,
      category: p.category,
      subcategory: p.subcategory,
      chatEnabled: p.chatEnabled,
      agenticEnabled: p.agenticEnabled,
      score,
    }
  })

  return scored
    .filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export async function getAllPluginsGrouped(): Promise<Record<string, Record<string, ScoredPlugin[]>>> {
  const plugins = await db.plugin.findMany({
    where: {},
    orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { name: 'asc' }],
  })

  const grouped: Record<string, Record<string, ScoredPlugin[]>> = {}
  for (const p of plugins) {
    const cat = p.category || 'general'
    const subcat = p.subcategory || 'general'
    ;(grouped[cat] ??= {})[subcat] ??= []
    grouped[cat][subcat].push({
      id: p.id,
      toolId: p.toolId,
      name: p.name,
      description: p.description,
      manifestJson: p.manifestJson,
      category: p.category,
      subcategory: p.subcategory,
      chatEnabled: p.chatEnabled,
      agenticEnabled: p.agenticEnabled,
      score: 0,
    })
  }

  return grouped
}

export const PLUGIN_CATEGORIES: Record<string, string> = {
  utility: 'Utility',
  business_intelligence: 'Business Intelligence',
  productivity: 'Productivity',
  communication: 'Communication',
  data_enrichment: 'Data Enrichment',
  ai_ml: 'AI / ML Services',
  developer_tools: 'Developer Tools',
  indonesian: 'Indonesian-Specific',
  general: 'General',
}

export const PLUGIN_SUBCATEGORIES: Record<string, string> = {
  weather: 'Weather',
  datetime: 'Date & Time',
  timezone: 'Timezone',
  translation: 'Translation',
  calculator: 'Calculator',
  news: 'News',
  documentation: 'Documentation Search',
  stocks: 'Stock Prices',
  crypto: 'Crypto Prices',
  currency: 'Currency Exchange',
  statistics: 'Statistics',
  email: 'Email',
  task_management: 'Task Management',
  calendar: 'Calendar',
  document: 'Document Generation',
  messaging: 'Messaging',
  notification: 'Notifications',
  phone_validation: 'Phone Validation',
  email_validation: 'Email Validation',
  ip_geolocation: 'IP Geolocation',
  geocoding: 'Geocoding',
  ocr: 'OCR / Image Text',
  llm: 'LLM Inference',
  github: 'GitHub',
  ci_cd: 'CI/CD',
  monitoring: 'Monitoring',
  general: 'General',
}
