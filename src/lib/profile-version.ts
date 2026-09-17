/**
 * Business-context profile versioning.
 *
 * WHY THIS IS A LEAF MODULE: `isProfileCurrent` is pure string logic, but it was
 * first placed in `@/lib/ai`, whose import graph needs the tenant's LLM config.
 * An API route that only wanted to report staleness then failed at import time in
 * tests that mock `prisma-tenant` partially. Keeping the helper dependency-free
 * means a caller can ask "is this profile current?" without pulling in the LLM.
 *
 * WHY THE VERSION EXISTS AT ALL (MEASURED): profile quality is not cosmetic. With
 * a table whose only text column is a free-text label, a profile carrying no
 * query-hints section made the Text-to-SQL model fabricate a filter on that label
 * (`WHERE keterangan ILIKE '%aktif%'` -> NULL) in 10 of 10 runs; the same database
 * with a freshly generated profile produced 0 of 10. Three real databases were
 * found holding 310-360 char profiles written before the prompt asked for query
 * hints, so they were silently in the harmful state and nothing could tell.
 *
 * Bump DATABASE_PROFILE_VERSION when the generation prompt changes in a way that
 * alters the document's value.
 */
export const DATABASE_PROFILE_VERSION = 2

/** Does this profile carry the current structure? False for legacy or absent ones. */
export function isProfileCurrent(profile: string | null | undefined): boolean {
  if (!profile) return false
  return profile.includes(`profile-version: ${DATABASE_PROFILE_VERSION}`)
}
