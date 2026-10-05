/**
 * REST-call planning: given the org's whitelisted endpoints, the model chooses ONE endpoint id and its parameters.
 * It can only pick from the list it is shown — `rest-api-connectors.ts` re-checks the id against enabled rows before
 * any request is made, so this module grants nothing by itself. Split from `ai.ts`.
 */
import { chatOnce } from '@/lib/ai-chat'
import { selectRelevant } from '@/lib/source-relevance'

export interface RestEndpointOption {
  id: string
  connectorName: string
  method: string
  path: string
  description?: string | null
  parameterSchema?: string | null
  sampleResponse?: string | null
}

export interface RestCallPlan {
  endpointId: string
  query: Record<string, string | number | boolean | null>
  body: unknown
  explanation: string
}

/**
 * How many endpoints the REST router prompt lists. Every enabled endpoint of every active connector used to be
 * included, with its full `sampleResponse` — the one prompt in the product that grew without limit. See the comment
 * at the listing for the measured shape and what is kept versus dropped.
 */
const REST_PROMPT_ENDPOINT_LIMIT = 40

/** The example payload in the REST prompt is a SHAPE hint, not data to answer from, so only a prefix is shown. */
const REST_SAMPLE_RESPONSE_CHARS = 200

function truncateSampleResponse(sample: string | null | undefined): string {
  if (!sample) return '-'
  if (sample.length <= REST_SAMPLE_RESPONSE_CHARS) return sample
  return `${sample.slice(0, REST_SAMPLE_RESPONSE_CHARS)}…[truncated, ${sample.length} chars total]`
}

export const REST_ROUTER_SYSTEM_PROMPT =
  'You are an enterprise REST API router. Select the ONE most relevant whitelisted endpoint to answer the user question. ' +
  'Do not create new paths. Use the endpointId exactly from the list. ' +
  'sampleResponse is only an example structure, not final data to answer the user. ' +
  'The explanation should briefly describe the reason for selecting the endpoint and the parameters sent. ' +
  'Do not send query or body if parameterSchema is empty or does not mention that parameter. ' +
  'Answer ONLY JSON without markdown: {"endpointId":"...","query":{},"body":null,"explanation":"..."}.\n' +
  'Use query for simple URL parameters. Use body only for non-GET methods when truly needed.'

export async function generateRestCall(args: {
  question: string
  endpoints: RestEndpointOption[]
  memoryContext?: string
  /** The question plus rewordings (e.g. translations), used only to RANK which endpoints are listed. */
  phrasings?: string[]
}): Promise<RestCallPlan> {
  // The 40 listed are the most RELEVANT to the question, not the first 40 loaded. MEASURED with three APIs and 50
  // endpoints: the shipment-tracking endpoint (15th of the third API) was never listed, so even a model that always
  // picks correctly could not call it. `selectRelevant` also keeps every API represented when nothing matches.
  const listed = selectRelevant(
    args.endpoints,
    (e) => `${e.connectorName} ${e.method} ${e.path} ${e.description ?? ''}`,
    (e) => e.connectorName,
    args.phrasings ?? [args.question],
    REST_PROMPT_ENDPOINT_LIMIT,
  )
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content: REST_ROUTER_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content:
          `User question: ${args.question}\n\n` +
          (args.memoryContext ? `Memory: a similar previous request:\n${args.memoryContext}\n\n` : '') +
          /*
           * BOUNDED, in two dimensions, because this list was the one prompt in the product that grew without limit.
           *
           * MEASURED SHAPE OF THE GROWTH: every connector's every enabled endpoint is listed, and each line carries
           * `parameterSchema` AND `sampleResponse` in full. Those are operator-entered JSON strings, so a connector
           * with a rich sample payload costs kilobytes per endpoint — the current install has none, which is exactly
           * why nothing noticed. With 50 endpoints at a few KB each this is tens of thousands of characters for ONE
           * routing call, on the customer's BYOK key.
           *
           * What is kept and what is dropped:
           *  - `parameterSchema` stays FULL. It is the contract: the model must not send a parameter the schema
           *    does not mention, and truncating JSON breaks that rule's premise.
           *  - `sampleResponse` is a SHAPE hint only ("sampleResponse is only an example structure"), so it is cut
           *    to a prefix. The first 200 characters show the shape; the rest of a large payload is data the model
           *    is explicitly told not to answer from.
           *  - The LIST is capped at 40 endpoints. An install with more than that cannot be served by a single
           *    prompt anyway (MEASURED on the database-listing variant of this problem: a model cannot reliably pick
           *    from a longer list), and the cap keeps the worst case bounded. Over-cap endpoints are not silently
           *    hidden: the count is stated so the model can say so rather than guess.
           */
          `Whitelisted endpoints:\n${REST_PROMPT_ENDPOINT_LIMIT < args.endpoints.length ? `[${args.endpoints.length} endpoints configured; showing the ${REST_PROMPT_ENDPOINT_LIMIT} most relevant to the question — if none matches, say so rather than guessing]\n` : ''}${listed
            .map(
              (endpoint) =>
                `- id=${endpoint.id}; connector=${endpoint.connectorName}; method=${endpoint.method}; path=${endpoint.path}; description=${endpoint.description ?? '-'}; parameterSchema=${endpoint.parameterSchema ?? '-'}; sampleResponse=${truncateSampleResponse(endpoint.sampleResponse)}`,
            )
            .join('\n')}\n\n` +
          'Provide the JSON endpoint selection.',
      },
    ],
    { purpose: 'rest' },
  )
  return parseRestCallJson(raw)
}

export function parseRestCallJson(raw: string): RestCallPlan {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<RestCallPlan>
  const query =
    parsed.query && typeof parsed.query === 'object' && !Array.isArray(parsed.query)
      ? parsed.query
      : {}
  return {
    endpointId: String(parsed.endpointId ?? '').trim(),
    query: query as RestCallPlan['query'],
    body: parsed.body === undefined ? null : parsed.body,
    explanation: String(parsed.explanation ?? '').trim(),
  }
}
