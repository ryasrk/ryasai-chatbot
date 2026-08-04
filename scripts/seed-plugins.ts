import { db } from '../src/lib/db'

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
    description: 'Get current weather and forecast for any location worldwide. Free, no API key.',
    category: 'utility',
    subcategory: 'weather',
    keywords: 'cuaca,weather,suhu,temperature,hujan,rain,forecast,prakiraan,wind,angin,humidity,lembab,jakarta,indonesia',
    manifest: {
      paramDescription: 'Query params: latitude=<lat>, longitude=<lon>, current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m, daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum, timezone=auto',
      executorType: 'webhook',
      endpoint: 'https://api.open-meteo.com/v1/forecast',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 5000,
      description: 'Free weather forecast for any location. No API key needed.',
    },
    enabled: true,
  },
  {
    toolId: 'datetime',
    name: 'Current Date & Time',
    description: 'Get current date and time for any timezone. Free, no API key.',
    category: 'utility',
    subcategory: 'datetime',
    keywords: 'tanggal,date,time,waktu,jam,hari,bulan,tahun,now,sekarang,current,datetime',
    manifest: {
      paramDescription: 'Query param: timeZone=<IANA timezone e.g. Asia/Jakarta, America/New_York, Europe/London, UTC>. Returns dateTime, dayOfWeek, hasDayLightSaving.',
      executorType: 'webhook',
      endpoint: 'https://timeapi.io/api/time/current/zone',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 5000,
      description: 'Get current date and time for any timezone. Free, no API key.',
    },
    enabled: true,
  },
  {
    toolId: 'timezone',
    name: 'Timezone Info & Conversion',
    description: 'Get timezone details including UTC offset, DST status, and country. Free, no API key.',
    category: 'utility',
    subcategory: 'timezone',
    keywords: 'timezone,waktu,zona,utc,offset,dst,daylight,country,convert,konversi,Asia,Jakarta,EST,PST',
    manifest: {
      paramDescription: 'Query param: timeZone=<IANA timezone e.g. Asia/Jakarta>. Returns utcOffset, currentLocalTime, hasDayLightSaving, country, displayName.',
      executorType: 'webhook',
      endpoint: 'https://timeapi.io/api/time/zone',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 5000,
      description: 'Get timezone details and UTC offset. Free, no API key.',
    },
    enabled: true,
  },
  {
    toolId: 'translate',
    name: 'Translation',
    description: 'Translate text between any languages. Free, no API key (1000 words/day).',
    category: 'utility',
    subcategory: 'translation',
    keywords: 'translate,terjemah,translation,bahasa,language,english,indonesia,en,id,convert',
    manifest: {
      paramDescription: 'Query params: q=<text to translate>, langpair=<source|target e.g. en|id, id|en, en|ja>. Returns translatedText.',
      executorType: 'webhook',
      endpoint: 'https://api.mymemory.translated.net/get',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Free translation between any languages. No API key.',
    },
    enabled: true,
  },
  {
    toolId: 'calculator',
    name: 'Math Calculator',
    description: 'Evaluate mathematical expressions. Supports arithmetic, trigonometry, statistics, calculus. Free, no API key.',
    category: 'utility',
    subcategory: 'calculator',
    keywords: 'calculate,calculator,hitung,kalkulator,math,matematika,arithmetic,sum,add,subtract,multiply,divide,sqrt,power,percentage,persentase',
    manifest: {
      paramDescription: 'Query param: expr=<math expression e.g. 2+2, sqrt(16), sin(pi/4), 15% of 200, 2^10>. Returns result. Supports +, -, *, /, ^, sqrt, sin, cos, tan, log, exp, abs, round, etc.',
      executorType: 'webhook',
      endpoint: 'https://api.mathjs.org/v4/',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 5000,
      description: 'Evaluate math expressions. Free, no API key.',
    },
    enabled: true,
  },
  {
    toolId: 'news',
    name: 'News Aggregation',
    description: 'Get latest news headlines from Google News. Supports Indonesian and global news. Free, no API key.',
    category: 'utility',
    subcategory: 'news',
    keywords: 'news,berita,headline,artikel,indonesia,world,dunia,terkini,latest,google,rss',
    manifest: {
      paramDescription: 'RSS endpoint. Path/search?q=<search keyword or empty for top news>&hl=<language e.g. id or en>&gl=<country e.g. ID or US>&ceid=<country:language e.g. ID:id>. Returns RSS XML with title, link, pubDate, description for each article.',
      executorType: 'webhook',
      endpoint: 'https://news.google.com/rss/search',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Get latest news from Google News RSS. Supports Indonesian news.',
    },
    enabled: true,
  },
  {
    toolId: 'docsearch',
    name: 'Documentation & Code Search',
    description: 'Search StackOverflow for code solutions, syntax examples, and programming documentation. Free, no API key.',
    category: 'utility',
    subcategory: 'documentation',
    keywords: 'documentation,doc,syntax,code,programming,stackoverflow,search,example,contoh,snippet,function,method,error,debug,api,library,framework,react,vue,python,javascript,typescript,useEffect,hook,css,html,node,docker,how,to,cara,implementasi,implement',
    manifest: {
      paramDescription: 'Query params: q=<search query e.g. react useEffect cleanup>, site=stackoverflow, order=desc, sort=activity, pagesize=5. Returns questions with title, link, score, tags, body_excerpt.',
      executorType: 'webhook',
      endpoint: 'https://api.stackexchange.com/2.3/search/advanced',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Search StackOverflow for code solutions and documentation. Free, no API key.',
    },
    enabled: true,
  },
  {
    toolId: 'web_search',
    name: 'Web Search',
    description: 'Search Wikipedia for encyclopedic information about any topic, person, place, or concept. Supports Indonesian and English. Free, no API key.',
    category: 'utility',
    subcategory: 'web_search',
    keywords: 'search,cari,web,internet,wikipedia,definition,definisi,what,is,apa,itu,meaning,artinya,topic,topik,concept,konsep,tech,article,berita,prabowo,jokowi,presiden',
    manifest: {
      paramDescription: 'Query params: action=query, list=search, srsearch=<search query>, format=json, srlimit=5. Returns search results with title, snippet, pageid for each match. Use srsearch for the search term.',
      executorType: 'webhook',
      endpoint: 'https://id.wikipedia.org/w/api.php',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Search Indonesian Wikipedia for encyclopedic information. Free, no API key.',
    },
    enabled: true,
  },
  {
    toolId: 'url_fetch',
    name: 'Article Reader',
    description: 'Get the full introductory text of any Wikipedia article. Use for detailed biographies, topic explanations, and encyclopedic definitions. Free, no API key.',
    category: 'utility',
    subcategory: 'web_fetch',
    keywords: 'fetch,read,baca,article,artikel,wikipedia,detail,bio,biography,biografi,who,siapa,what,apa,extract,intro,person,person',
    manifest: {
      paramDescription: 'Query params: action=query, titles=<article title with underscores e.g. Prabowo_Subianto>, prop=extracts, exintro=1, format=json, explaintext=1. Returns plain text extract of the article introduction. Use underscores for spaces in titles.',
      executorType: 'webhook',
      endpoint: 'https://id.wikipedia.org/w/api.php',
      method: 'GET',
      authType: 'NONE',
      timeoutMs: 10000,
      description: 'Get Wikipedia article introductions in plain text. Free, no API key.',
    },
    enabled: true,
  },
]

export async function seedPlugins() {
  console.log('Seeding plugins...')
  // ponytail: seed for every org — the previous hardcoded 'org-default' meant
  // only one org got plugins. deleteMany is scoped per org inside the loop.
  const orgs = await db.organization.findMany({ select: { id: true } })
  if (orgs.length === 0) {
    console.log('No organizations found. Create an org first.')
    return
  }

  let totalCreated = 0
  for (const org of orgs) {
    await db.plugin.deleteMany({ where: { organizationId: org.id } })
    for (const p of PLUGINS) {
      const manifestJson = JSON.stringify(p.manifest)
      await db.plugin.create({
        data: {
          organizationId: org.id,
          toolId: p.toolId,
          name: p.name,
          description: p.description,
          manifestJson,
          category: p.category,
          subcategory: p.subcategory,
          keywords: p.keywords,
          isEnabled: p.enabled,
          chatEnabled: true,
          agenticEnabled: true,
        },
      })
      totalCreated++
    }
    console.log(`  Org ${org.id}: ${PLUGINS.length} plugins registered`)
  }

  console.log(`\nDone: ${totalCreated} plugins across ${orgs.length} org(s)`)
}

async function main() {
  await seedPlugins()
  await db.$disconnect()
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
