/**
 * Character caps on operator-written integration text, shared by the API that enforces them and the editors that
 * show the remaining count. They were declared three times (two routes, one view) with "must match" comments as the
 * only link; a UI cap above the API cap lets an operator type text the save then rejects.
 *
 * No server-only imports: the integration editors load this in the browser.
 */

/** `Integration.contextPrompt`, the per-integration instruction added to the SQL prompt. */
export const INTEGRATION_PROMPT_MAX = 4000

/** `IntegrationSchema.description`, one table's description in the schema viewer. */
export const TABLE_DESCRIPTION_MAX = 500
