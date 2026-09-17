import { describe, expect, test } from 'bun:test'
import { isProfileCurrent, DATABASE_PROFILE_VERSION } from './profile-version'

describe('profile-version', () => {
  // MEASURED: a profile written by an older prompt (glossary only, no query hints)
  // made the Text-to-SQL model fabricate a filter on a free-text label in 40 of 40
  // runs, versus 0 of 30 with a current profile. Detecting that state is what
  // drives regeneration, so these are the cases that must not be missed.
  test('a profile carrying the current marker is current', () => {
    expect(isProfileCurrent(`<!-- profile-version: ${DATABASE_PROFILE_VERSION} -->\n## Domain\nx`)).toBe(true)
  })

  test('a legacy profile is NOT current', () => {
    // The exact shape found in production: 310-360 chars, glossary only, no marker.
    expect(isProfileCurrent('## Domain\nPenjualan, sales, pelanggan.')).toBe(false)
  })

  test('an older version number is NOT current', () => {
    // A future bump must invalidate the previous generation, or regeneration never
    // triggers on upgrade.
    expect(isProfileCurrent('<!-- profile-version: 1 -->\n## Domain')).toBe(false)
  })

  test('absent or empty profiles are NOT current', () => {
    expect(isProfileCurrent('')).toBe(false)
    expect(isProfileCurrent(null)).toBe(false)
    expect(isProfileCurrent(undefined)).toBe(false)
  })

  test('the marker is matched as a version, not as a bare substring', () => {
    // `2` must not match inside `20`; a loose match would call a future profile current.
    expect(isProfileCurrent('profile-version: 20')).toBe(false)
  })
})
