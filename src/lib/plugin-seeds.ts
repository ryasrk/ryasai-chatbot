interface PluginSeed {
  toolId: string
  name: string
  description: string
  category: string
  subcategory: string
  keywords: string
  manifest: Record<string, unknown>
  enabled: boolean
}

const PLUGINS: PluginSeed[] = [
  {
    toolId: 'weather',
    name: 'Weather Forecast',
    description: 'Current weather and forecast for any coordinates worldwide. Free, no API key.',
    category: 'utility',
    subcategory: 'weather',
    keywords: 'cuaca,weather,suhu,temperature,hujan,rain,forecast,prakiraan,wind,angin,humidity,lembab,jakarta,indonesia',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://api.open-meteo.com/v1/forecast',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 8000,
      description: 'Current weather and forecast for any coordinates. Free, no API key.',
      // Open-Meteo takes COORDINATES, not a place name. The old prose param
      // told the model to "query latitude, longitude, current, daily, timezone"
      // with no types, so it guessed. Coordinates are required because there is
      // no geocoding here: without them the call cannot succeed at all, and a
      // required field is what makes that visible instead of returning 400.
      parameters: {
        type: 'object',
        properties: {
          latitude: { type: 'number', description: 'Latitude in decimal degrees, e.g. -6.2 for Jakarta.' },
          longitude: { type: 'number', description: 'Longitude in decimal degrees, e.g. 106.8 for Jakarta.' },
          current: {
            type: 'string',
            description: 'Comma-separated current variables, e.g. "temperature_2m,wind_speed_10m,weather_code". Defaults to temperature_2m.',
          },
          daily: {
            type: 'string',
            description: 'Comma-separated daily variables, e.g. "temperature_2m_max,temperature_2m_min,precipitation_sum".',
          },
          forecast_days: { type: 'integer', description: 'Number of forecast days, 1-16. Defaults to 7.' },
        },
        required: ['latitude', 'longitude'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'datetime',
    name: 'Current Date & Time',
    description: 'Current date and time for any IANA timezone, including DST status. Free, no API key.',
    category: 'utility',
    subcategory: 'datetime',
    keywords: 'tanggal,date,time,waktu,jam,hari,bulan,tahun,now,sekarang,current,datetime,timezone,zona,utc,offset,dst,daylight',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://timeapi.io/api/time/current/zone',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 8000,
      description: 'Current date and time for any IANA timezone, with UTC offset and DST status.',
      // This REPLACES the old `timezone` plugin, whose endpoint
      // (timeapi.io/api/time/zone) returns 404 — measured. It could never have
      // worked. The live endpoint already returns everything that plugin
      // advertised (timeZone, dayOfWeek, dstActive), so a second plugin added a
      // broken duplicate rather than a capability.
      parameters: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA timezone name, e.g. "Asia/Jakarta", "America/New_York", "Europe/London", "UTC".',
          },
        },
        required: ['timeZone'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'timezone_by_location',
    name: 'Timezone by Coordinates',
    description: 'Resolve the local time and DST status at a latitude/longitude. Free, no API key.',
    category: 'utility',
    subcategory: 'timezone',
    keywords: 'timezone,zona,waktu,location,lokasi,koordinat,coordinates,utc,offset,dst,daylight',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://timeapi.io/api/time/current/coordinate',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 8000,
      description: 'Local time at a latitude/longitude, for when the timezone NAME is not known.',
      // Replaces the broken `timezone` plugin with something it never actually
      // offered: resolving a timezone from POSITION rather than from a name the
      // model would have to already know. Verified live (HTTP 200) — and unlike
      // the endpoint it replaces, it is a real capability rather than a second
      // copy of `datetime`.
      parameters: {
        type: 'object',
        properties: {
          latitude: { type: 'number', description: 'Latitude in decimal degrees.' },
          longitude: { type: 'number', description: 'Longitude in decimal degrees.' },
        },
        required: ['latitude', 'longitude'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'translate',
    name: 'Translate Text',
    description: 'Translate text between languages using MyMemory. Free, no API key.',
    category: 'utility',
    subcategory: 'language',
    keywords: 'translate,terjemah,terjemahkan,bahasa,language,inggris,indonesia,english,indonesian,spanish,japanese,arabic',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://api.mymemory.translated.net/get',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Translate text between languages. Free, no API key.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'The text to translate. Keep it under 500 characters (free tier limit).' },
          langpair: {
            type: 'string',
            description: 'Source and target as "source|target" using ISO 639-1 codes, e.g. "en|id", "id|en", "en|ja".',
          },
        },
        required: ['q', 'langpair'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'calculator',
    name: 'Calculator',
    description: 'Evaluate a mathematical expression exactly. Free, no API key.',
    category: 'utility',
    subcategory: 'math',
    keywords: 'calculator,kalkulator,hitung,math,matematika,arithmetic,expression,rumus,compute,persen,percent,sqrt',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://api.mathjs.org/v4/',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 8000,
      description: 'Evaluate a mathematical expression written in MathJS syntax.',
      parameters: {
        type: 'object',
        properties: {
          expr: {
            type: 'string',
            description: 'MathJS expression, e.g. "2+2", "sqrt(16)", "(1500*0.15)/12", "sin(pi/4)".',
          },
        },
        required: ['expr'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'web_search',
    name: 'Wikipedia Search',
    description: 'Search the Indonesian or English Wikipedia for articles. Free, no API key.',
    category: 'knowledge',
    subcategory: 'search',
    keywords: 'wikipedia,search,cari,pencarian,artikel,article,ensiklopedia,encyclopedia,informasi,information',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://id.wikipedia.org/w/api.php',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Search Wikipedia for articles matching a query.',
      // The API needs `action`, `list` and `format` to return JSON at all; a
      // model that omits them gets HTML and a parse failure. Listing them as
      // required with enum/default values is what makes the call well-formed
      // instead of a guess — the old prose left all three to chance.
      parameters: {
        type: 'object',
        properties: {
          srsearch: { type: 'string', description: 'The search query.' },
          action: { type: 'string', enum: ['query'], description: 'Fixed API action.' },
          list: { type: 'string', enum: ['search'], description: 'Fixed list mode.' },
          format: { type: 'string', enum: ['json'], description: 'Response format. Must be json.' },
          srlimit: { type: 'integer', description: 'Number of results, 1-20. Defaults to 10.' },
        },
        required: ['srsearch', 'action', 'list', 'format'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'article_fetch',
    name: 'Wikipedia Article',
    description: 'Read the plain-text extract of a Wikipedia article by title. Free, no API key.',
    category: 'knowledge',
    subcategory: 'search',
    keywords: 'wikipedia,artikel,article,read,baca,isi,content,extract,ringkasan,summary,halaman,page',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://id.wikipedia.org/w/api.php',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Fetch the plain-text introduction of a Wikipedia article by exact title.',
      // Distinct from `web_search`: that one FINDS articles, this one READS one.
      // The previous `url_fetch` plugin pointed at the same Wikipedia endpoint as
      // `web_search` despite its name implying arbitrary URLs, so the model was
      // told it could fetch any page when it could only ever reach Wikipedia.
      parameters: {
        type: 'object',
        properties: {
          titles: { type: 'string', description: 'Exact article title, e.g. "Jakarta" or "Soekarno".' },
          action: { type: 'string', enum: ['query'], description: 'Fixed API action.' },
          prop: { type: 'string', enum: ['extracts'], description: 'Fetch the plain-text extract.' },
          explaintext: { type: 'string', enum: ['1'], description: 'Return plain text rather than HTML.' },
          format: { type: 'string', enum: ['json'], description: 'Response format. Must be json.' },
        },
        required: ['titles', 'action', 'prop', 'explaintext', 'format'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'docsearch',
    name: 'Stack Overflow Search',
    description: 'Search Stack Overflow for programming questions and answers. Free, no API key.',
    category: 'knowledge',
    subcategory: 'developer',
    keywords: 'stackoverflow,programming,kode,code,error,bug,developer,api,library,framework,python,javascript,sql',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://api.stackexchange.com/2.3/search/advanced',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Search Stack Overflow questions, ranked by relevance.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'The search query, e.g. "postgres upsert conflict".' },
          site: { type: 'string', enum: ['stackoverflow'], description: 'Which Stack Exchange site.' },
          order: { type: 'string', enum: ['desc', 'asc'], description: 'Sort direction. Defaults to desc.' },
          sort: { type: 'string', enum: ['relevance', 'votes', 'creation', 'activity'], description: 'Sort key. Defaults to relevance.' },
          pagesize: { type: 'integer', description: 'Results per page, 1-100. Defaults to 10.' },
        },
        required: ['q', 'site'],
      },
    },
    enabled: true,
  },
  {
    toolId: 'news',
    name: 'News Headlines',
    description: 'Read current news headlines from Google News RSS. Free, no API key.',
    category: 'knowledge',
    subcategory: 'news',
    keywords: 'news,berita,headline,headlines,terkini,terbaru,latest,today,hari ini,google news,rss',
    manifest: {
      executorType: 'webhook',
      endpoint: 'https://news.google.com/rss',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Current news headlines from Google News, as RSS XML.',
      parameters: {
        type: 'object',
        properties: {
          hl: { type: 'string', description: 'Interface language, e.g. "en-US", "id". Defaults to en-US.' },
          gl: { type: 'string', description: 'Country code, e.g. "US", "ID". Defaults to US.' },
          ceid: { type: 'string', description: 'Country and language, e.g. "US:en", "ID:id". Defaults to US:en.' },
          q: { type: 'string', description: 'Optional topic to search for. Omit for top headlines.' },
        },
        // No required fields: Google News returns top headlines with defaults.
        // Marking anything required would force the model to invent a value for
        // a parameter the API is happy without.
      },
    },
    enabled: true,
  },
]


import { db } from '@/lib/db'

/**
 * Install/refresh the built-in plugins for one org.
 *
 * ponytail: upsert by toolId. This used to deleteMany + recreate, which took
 * every hand-registered plugin in the org down with it on any re-seed. Upserting
 * also means a corrected built-in manifest can actually reach an existing org —
 * the news endpoint fix sat in the seed file while production kept 404ing on the
 * stale row, because the boot auto-heal only seeds orgs with zero plugins.
 *
 * Seed-owned fields (endpoint, description, keywords) are refreshed; the admin's
 * enable toggles are left alone on rows that already exist.
 *
 * Ceiling: one findFirst per plugin. Fine for ~10 built-ins; add a
 * @@unique([organizationId, toolId]) and a real upsert if this list grows.
 */
export async function seedPlugins(organizationId: string) {
  for (const p of PLUGINS) {
    const seedOwned = {
      name: p.name,
      description: p.description,
      manifestJson: JSON.stringify(p.manifest),
      category: p.category,
      subcategory: p.subcategory,
      keywords: p.keywords,
    }
    const existing = await db.plugin.findFirst({
      where: { organizationId, toolId: p.toolId },
      select: { id: true },
    })
    if (existing) {
      await db.plugin.update({ where: { id: existing.id }, data: seedOwned })
    } else {
      await db.plugin.create({
        data: {
          organizationId,
          toolId: p.toolId,
          ...seedOwned,
          isEnabled: p.enabled,
          chatEnabled: true,
          agenticEnabled: true,
        },
      })
    }
  }
}
