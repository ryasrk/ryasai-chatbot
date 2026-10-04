/**
 * The one way a TOOL re-enters the chat router: the planner's steps and the unified tools answer a sub-question by
 * running a whole single-source completion, while the router itself depends on the planner (multi-step DAG) and on
 * the unified tools (tool selection). Importing the router statically from either side closes a five-module import
 * cycle; this port loads it lazily, so the dependency is explicit, typed, and one-directional at module load.
 *
 * Only the TYPE is imported statically — it is erased — and a test that mocks `@/lib/tool-router` still intercepts
 * the call, because the dynamic import resolves through the same module registry.
 */
import type { runNonStreamingChatCompletion as RouterCompletion } from '@/lib/tool-router'

export async function runNonStreamingChatCompletion(
  args: Parameters<typeof RouterCompletion>[0],
): ReturnType<typeof RouterCompletion> {
  const router = await import('@/lib/tool-router')
  return router.runNonStreamingChatCompletion(args)
}
