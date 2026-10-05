/**
 * Extra index text for words a PDF extraction glued together, so lexical search can find them.
 *
 * WHY (live eval, 2026-10-05): the 1 MB book in the eval corpus came out of a PDF with its spaces dropped at line and
 * style boundaries — "CleanAirActAmendments", "olderAmericans", "inAustralia", "HarvardÕs" (MacRoman mojibake of ’),
 * "emerg- ing". The 'simple' tsvector indexes "cleanairactamendments" as ONE token, so a question naming the Clean Air
 * Act Amendments matched nothing lexically. The evidence of 7 of the 9 wrong distractor-book answers sat in a glued
 * span. Customer PDFs extract the same way.
 *
 * The output is ADDED to what is indexed, never substituted for the chunk: the stored text, the citations and the
 * answer context stay byte-identical, and a glued token stays findable under its glued form ("JavaScript" → also
 * "Java Script", while "javascript" still matches). Only tokens that show a seam are emitted, so ordinary prose adds
 * nothing to the index.
 *
 * `GLUED_WORDS_SQL` is the same transform for Postgres, used where `tsv` is computed in one statement; the two are kept
 * equal by `glued-words.test.ts` (TS) and `glued-words-sql.test.ts` (the SQL against a real Postgres).
 */

/** A token with a seam: lower→Upper, a MacRoman apostrophe, an acronym run into a word, or a line-break hyphen. */
const SEAM_TOKEN = /\p{L}+Õ\p{Ll}\p{L}*|\p{L}*\p{Ll}\p{Lu}\p{L}*|\p{L}*\p{Lu}\p{Lu}\p{Ll}\p{L}*|\p{L}+-\s+\p{Ll}+/gu

/**
 * An acronym run into a word has two readings, and the letters alone cannot tell them apart: "HTMLParser" (the last
 * capital starts the next word) and "GDPgrowth" (the next word is lower-case) — the eval book has the second, and the
 * first rule alone indexed it as "GD Pgrowth" (failure audit, 2026-10-05, q232). Both readings are emitted when they
 * differ; the index is additive, so the wrong one costs a stray token and nothing else.
 */
function splitSeams(token: string, acronymEndsBeforeLower = false): string {
  return token
    // ’ read as MacRoman is "Õ"; "worldÕs" → "world s", "UNESCOÕs" → "UNESCO s". Done first: Õ is upper-case, so the
    // next rule would split it. A real Õ (Estonian "Õun") starts a word or follows nothing a letter-Õ-lower span needs.
    .replace(/(\p{L})Õ(?=\p{Ll})/gu, '$1 ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(acronymEndsBeforeLower ? /(\p{Lu}{2,})(\p{Ll})/gu : /(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    // "emerg- ing" → "emerging": a hyphen followed by whitespace is a line break, not a compound.
    .replace(/-\s+/g, '')
}

/** The split forms of every glued token in `text`, space-separated; empty when the text has none. */
export function gluedWordVariants(text: string): string {
  if (!text) return ''
  return (text.match(SEAM_TOKEN) ?? []).map((token) => {
    const first = splitSeams(token)
    const second = /\p{Lu}{2}\p{Ll}/u.test(token) ? splitSeams(token, true) : first
    return second === first ? first : `${first} ${second}`
  }).join(' ')
}

/**
 * The same transform as a Postgres expression over `column`. POSIX classes rather than \p{…}: Postgres regexes have
 * no Unicode property escapes, and [[:lower:]]/[[:upper:]] follow the database's ctype (UTF-8 in every install).
 */
export function GLUED_WORDS_SQL(column: string): string {
  const chain = (acronymRule: string) => `regexp_replace(regexp_replace(regexp_replace(regexp_replace(m[1],
      '([[:alpha:]])Õ([[:lower:]])', '\\1 \\2', 'g'),
      '([[:lower:]])([[:upper:]])', '\\1 \\2', 'g'),
      ${acronymRule}, '\\1 \\2', 'g'),
      '-\\s+', '', 'g')`
  const first = chain(`'([[:upper:]])([[:upper:]][[:lower:]])'`)
  const second = chain(`'([[:upper:]]{2,})([[:lower:]])'`)
  return `array_to_string(ARRAY(
    SELECT ${first} || CASE WHEN m[1] ~ '[[:upper:]]{2}[[:lower:]]' AND ${second} <> ${first} THEN ' ' || ${second} ELSE '' END
    FROM regexp_matches(${column},
      '([[:alpha:]]+Õ[[:lower:]][[:alpha:]]*|[[:alpha:]]*[[:lower:]][[:upper:]][[:alpha:]]*|[[:alpha:]]*[[:upper:]][[:upper:]][[:lower:]][[:alpha:]]*|[[:alpha:]]+-\\s+[[:lower:]]+)',
      'g') AS m), ' ')`
}
