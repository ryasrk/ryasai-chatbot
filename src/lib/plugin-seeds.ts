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
