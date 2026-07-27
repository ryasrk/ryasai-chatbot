/**
 * VLM (vision-language model) helper — describes an image via the OpenAI
 * vision format using the role-specific 'vlm' LLM config.
 * ponytail: lazy single entry point — wire into document ingestion
 * (image alt-text / OCR fallback) when needed.
 */
import { getRoleLlmConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import type { LlmMessage, LlmContentPart } from '@/lib/llm-client-types'
import { AppError } from '@/lib/errors'

const VLM_TIMEOUT_MS = 30_000

/**
 * Send a base64 image to the VLM and return a text description.
 * Uses the OpenAI vision `image_url` content part with a data URL.
 * Throws AppError(LLM_NOT_CONFIGURED) when no LLM config is available,
 * or AppError(LLM_TIMEOUT) when the call exceeds 30s.
 */
export async function describeImage(
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const cfg = await getRoleLlmConfig('vlm')
  if (!cfg) {
    throw new AppError(
      'LLM_NOT_CONFIGURED',
      'No LLM configured for the vlm role. Set a LlmConfig row with purpose=vlm.',
      { hint: 'Settings → AI Configuration → add a config with purpose "vlm".' },
    )
  }

  const parts: LlmContentPart[] = [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    { type: 'text', text: 'Describe this image in detail.' },
  ]
  const messages: LlmMessage[] = [{ role: 'user', content: parts }]

  // ponytail: 30s hard cap via AbortSignal.timeout. chatOnce also enforces
  // LLM_TIMEOUT_MS (30s) internally; this race guarantees rejection even if a
  // provider swallows the abort. Ceiling: the signal's timer lingers up to 30s
  // after a fast success — switch to a clearable timer if call rate is high.
  const signal = AbortSignal.timeout(VLM_TIMEOUT_MS)
  return Promise.race([
    chatOnce(cfg, messages, 0, 'vlm-image-describe'),
    new Promise<never>((_, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new AppError('LLM_TIMEOUT', `VLM describeImage timed out after ${VLM_TIMEOUT_MS}ms.`)),
        { once: true },
      ),
    ),
  ])
}
