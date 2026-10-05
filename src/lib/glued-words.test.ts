import { describe, expect, test } from 'bun:test'
import { gluedWordVariants, GLUED_WORDS_SQL } from './glued-words'

describe('gluedWordVariants', () => {
  test('splits the seams a PDF extraction leaves (verbatim from the eval book)', () => {
    expect(gluedWordVariants('the U.S. CleanAirActAmendments last century')).toBe('Clean Air Act Amendments')
    expect(gluedWordVariants('for olderAmericans to leave')).toBe('older Americans')
    expect(gluedWordVariants('The HagueAccord of 2016')).toBe('Hague Accord')
    expect(gluedWordVariants('Reef inAustralia is the worldÕs most popular')).toBe('in Australia world s')
  })

  test('reads the MacRoman apostrophe after a capital too', () => {
    expect(gluedWordVariants('HarvardÕs first doctorate')).toBe('Harvard s')
    expect(gluedWordVariants('UNESCOÕs Bright Horizons')).toBe('UNESCO s')
  })

  test('splits an acronym run into a word and rejoins a line-break hyphen', () => {
    // Both readings of an acronym run into a word: the letters cannot tell "HTML Parser" from "GDP growth".
    expect(gluedWordVariants('an HTMLParser class')).toBe('HTML Parser HTMLP arser')
    expect(gluedWordVariants('accounting for 20% of GDPgrowth this century')).toBe('GD Pgrowth GDP growth')
    expect(gluedWordVariants('with the emerg- ing markets')).toBe('emerging')
  })

  test('ordinary prose adds nothing to the index', () => {
    expect(gluedWordVariants('The Clean Air Act Amendments of 1990 set a precedent in the United States.')).toBe('')
    expect(gluedWordVariants('a well-known co-operative, NASA and the EU; Õun is Estonian')).toBe('')
    expect(gluedWordVariants('')).toBe('')
  })

  test('a glued identifier keeps its own form — the variants are added beside it, not instead', () => {
    // The caller appends; "javascript" still matches the original token.
    expect(gluedWordVariants('JavaScript and iPhone')).toBe('Java Script i Phone')
  })
})

describe('GLUED_WORDS_SQL', () => {
  test('is an expression over the given column, safe to splice into to_tsvector', () => {
    const sql = GLUED_WORDS_SQL('content')
    expect(sql).toContain('regexp_matches(content,')
    expect(sql.startsWith('array_to_string(')).toBe(true)
    // Backreferences reach Postgres as \1, not as an escaped literal.
    expect(sql).toContain("'\\1 \\2'")
  })
})
