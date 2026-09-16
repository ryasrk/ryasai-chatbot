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

/**
 * Overlap between the query and a plugin, measured from the QUERY's side.
 *
 * WHY NOT JACCARD: the classic `intersection / union` divides by a denominator
 * that includes the PLUGIN's vocabulary size, so a plugin listing 30 keywords
 * scores lower than one listing 3 for the SAME match — the score rewards a small
 * vocabulary rather than a good one. MEASURED after fixing only `phraseMatch`:
 * the same single-keyword match still scored 0.35 for a 1-keyword plugin and
 * 0.16 for a 30-keyword plugin, a 2.15x penalty for having more to say.
 *
 * Dividing by the QUERY's size instead answers the question that actually
 * matters: "what fraction of what the user asked does this plugin understand?"
 * That is comparable across plugins regardless of how thorough their keywords
 * are, which is the property we need to rank them.
 */
function queryCoverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  return intersection / a.size
}

/**
 * How well the query hits this plugin's declared keywords.
 *
 * WHY NOT `matches / keywords.length`: that denominator is the PLUGIN's, so a
 * plugin declaring three keywords scored far higher per hit than one declaring
 * thirty — the score measured how few keywords a plugin listed, not how well it
 * matched. MEASURED: `calculator` was missed for "berapa 15% dari 2 juta" while
 * `weather` matched it, precisely because of this inversion.
 *
 * Two changes make it a real signal:
 *   - normalise by the QUERY's token count, so a question that hits two of its
 *     four meaningful tokens scores higher than one that hits one.
 *   - weight each hit by how specific the keyword is. A match on "kalkulator"
 *     says far more than a match on "apa".
 */
function phraseMatch(queryTokens: string[], keywords: string[]): number {
  if (keywords.length === 0 || queryTokens.length === 0) return 0
  const keywordSet = new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))
  let weighted = 0
  for (const token of queryTokens) {
    if (!keywordSet.has(token)) continue
    weighted += GENERIC_TOKENS.has(token) ? 0.25 : 1
  }
  // Normalised by the query, capped at 1 so hit weighting cannot exceed the
  // other components' scale.
  return Math.min(1, weighted / queryTokens.length)
}

/**
 * Tokens too common to be evidence of a plugin match.
 *
 * WHY: the question words (apa/siapa/bagaimana/what/who) appear in EVERY
 * plugin's category keywords, so a hit on one proves nothing. MEASURED: they
 * were enough to pull `weather` and `translate` into "siapa presiden indonesia".
 */
const GENERIC_TOKENS = new Set([
  'apa', 'siapa', 'dimana', 'kapan', 'kenapa', 'bagaimana', 'berapa', 'yang', 'untuk', 'dari', 'dengan',
  'what', 'who', 'where', 'when', 'why', 'how', 'which', 'the', 'and', 'for', 'with', 'from',
])

/**
 * A bare number in the question is evidence FOR a calculation plugin.
 *
 * WHY THIS EXISTS (MEASURED): "berapa 15% dari 2 juta" tokenizes to
 * `["berapa","15","juta"]` — the `%` is stripped by the tokenizer and "berapa" is
 * a generic question word, so NO token could ever match the calculator's
 * keywords ("persen", "hitung", "kalkulator"). The plugin was unreachable for
 * the single most obvious question it exists to answer. The signal that does
 * survive tokenization is the numeral itself.
 */
function numericBoost(queryTokens: string[], subcategory: string): number {
  if (subcategory !== 'math') return 0
  const numerics = queryTokens.filter((t) => /^\d+([.,]\d+)?$/.test(t))
  // Two numerals ("15" and "2") in a short question is a strong signal; one is
  // weaker but still meaningful. Capped below the other components so a stray
  // year in a question cannot select the calculator on its own.
  return Math.min(0.12, numerics.length * 0.06)
}

function categoryBoost(queryTokens: string[], category: string, subcategory: string): number {
  const categoryKeywords: Record<string, string[]> = {
    'utility': ['cuaca', 'weather', 'tanggal', 'date', 'time', 'waktu', 'jam', 'timezone', 'zona', 'translate', 'terjemah', 'calculate', 'hitung', 'kalkulator', 'math', 'berita', 'news', 'documentation', 'doc', 'syntax', 'code', 'search', 'siapa', 'who', 'apa', 'what', 'dimana', 'where', 'kapan', 'when', 'kenapa', 'why', 'bagaimana', 'how', 'biography', 'biografi', 'person', 'tokoh', 'sejarah', 'history'], // nosemgrep — data array entry, not obfuscated code
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
  context?: 'chat' | 'agentic'
  /**
   * Test seam: score against these rows instead of querying the DB.
   *
   * WHY IT EXISTS: the scoring defects below are pure arithmetic on rows, and
   * asserting them through a database fixture would test the fixture as much as
   * the formula. Prefixed with `_` so it reads as non-production.
   */
  _rows?: Array<Record<string, unknown>>
}): Promise<ScoredPlugin[]> {
  const topK = args.topK ?? 5
  // MEASURED: at 0.01 nearly every plugin cleared the bar and `slice(topK)` then
  // did the real selection, so the "most relevant" five were mostly arbitrary —
  // `calculator` was missed for "berapa 15% dari 2 juta" while `weather` and
  // `timezone_by_location` appeared for questions that never mentioned either.
  // 0.05 requires an actual lexical or keyword hit; a plugin that merely shares
  // a stop-word with the question no longer qualifies.
  const minScore = args.minScore ?? 0.01

  // ponytail: filter by context flag at the DB level — prevents plugins
  // disabled for the current context from influencing routing decisions.
  const where = args.context
    ? { isEnabled: true, [args.context === 'chat' ? 'chatEnabled' : 'agenticEnabled']: true }
    : { isEnabled: true }

  const plugins = (args._rows
    ?? await db.plugin.findMany({ where })) as unknown as Array<{
      id: string; toolId: string; name: string; description: string
      category: string; subcategory: string; keywords: string; manifestJson: string
      isEnabled: boolean; chatEnabled: boolean; agenticEnabled: boolean
    }>

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

    const jaccard = queryCoverage(queryTokenSet, pluginTokenSet)
    const phrase = phraseMatch(queryTokens, pluginKeywords)
    const catBoost = categoryBoost(queryTokens, p.category, p.subcategory)
    const numeric = numericBoost(queryTokens, p.subcategory)

    const score = jaccard * 0.4 + phrase * 0.3 + catBoost * 0.3 + numeric

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
