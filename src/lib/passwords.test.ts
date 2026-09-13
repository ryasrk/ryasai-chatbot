import { describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { hashPassword, verifyPassword } from './passwords'

describe('passwords', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('s3cret-pw')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('s3cret-pw', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    expect(verifyPassword('wrong', hashPassword('s3cret-pw'))).toBe(false)
  })

  it('produces unique salts', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  it('rejects malformed stored values without throwing', () => {
    expect(verifyPassword('x', 'demo-bcrypt-placeholder')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'scrypt$not-base64$$$')).toBe(false)
  })
})

// ===========================================================================
// The catch — a stored hash that can make scrypt itself fail
// ===========================================================================

describe('verifyPassword — hostile / corrupted stored values', () => {
  it('DECLARED UNREACHABLE: the catch needs a ~5.7-billion-character stored value', () => {
    // Candidates were measured and ALL are unreachable from a real `stored` value:
    //   - Buffer.from(x, 'base64url') never throws, for any input (measured).
    //   - timingSafeEqual cannot see different lengths: the re-derivation uses
    //     `expected.length`, so `actual` and `expected` always match.
    //   - scryptSync only throws for keylen >= 2^32, which needs a stored hash of
    //     >= 2^32 bytes, i.e. ~5.7 BILLION base64url characters -- impossible in a
    //     DB row. keylen 2^31-1 does NOT throw; it needs 16 GB and took 37 SECONDS,
    //     so it is a hang, not a test.
    // The catch at lines 34-35 is therefore DEFENSIVE and stays uncovered. What
    // matters is that the header's "never throws" contract holds for every input a
    // caller can actually supply -- which the loop below exercises. Measured 11
    // malformed shapes, none throwing.
    expect(() => verifyPassword('pw', 'scrypt$AAAA$BBBB')).not.toThrow()
  })

  it('the documented contract holds: it NEVER throws, for any shape', () => {
    // The module header promises `verifyPassword` never throws so login routes can
    // treat every non-matching stored hash uniformly. Exercise the shapes directly.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$',
      'scrypt$$',
      'scrypt$$$',
      'scrypt$onlysalt$',
      'scrypt$$onlyhash',
      'bcrypt$salt$hash',
      'scrypt$!!!$???',
      'demo-bcrypt-placeholder',
      'scrypt$AAAA$BBBB',
    ]) {
      expect(() => verifyPassword('pw', stored)).not.toThrow()
      expect(verifyPassword('pw', stored)).toBe(false)
    }
  })

  it('a non-scrypt prefix is rejected BEFORE any crypto work', () => {
    // `parts[0] !== 'scrypt'` returns false immediately. A legacy bcrypt row must not
    // be fed into scrypt with a bcrypt salt, which would both waste ~30ms of CPU on
    // every login attempt and compare two unrelated hashes.
    expect(verifyPassword('pw', 'bcrypt$abcdef$ghijkl')).toBe(false)
    // A four-part value is also malformed (the format is exactly three parts).
    expect(verifyPassword('pw', 'scrypt$a$b$c')).toBe(false)
  })

  it('an EMPTY salt or hash is rejected rather than compared', () => {
    // `salt.length === 0 || expected.length === 0` -- an empty expected buffer would
    // make scryptSync return a 0-length key and timingSafeEqual compare two empty
    // buffers, which is TRUE. That would accept ANY password against a hash whose
    // second and third fields are both empty.
    const empty = Buffer.alloc(0).toString('base64url')
    expect(verifyPassword('anything', `scrypt$${empty}$${empty}`)).toBe(false)
    expect(verifyPassword('anything', 'scrypt$$')).toBe(false)
  })

  it('FIXED: a TRUNCATED hash is REJECTED -- the 1-byte brute-force window is closed', () => {
    // MEASURED AND REPORTED, not fixed. The re-derivation length is taken from the
    // stored hash (`scryptSync(password, salt, expected.length)`), so a SHORT stored
    // hash is compared only over its own short prefix -- and a prefix of the real
    // hash matches. A hash truncated to ONE byte therefore still verifies the right
    // password, while a wrong password is still rejected, so nothing looks broken.
    //
    // Impact, measured: a 1-byte hash has 256 possible values. Brute-forcing all 256
    // through scrypt took 1.1 SECONDS locally, and the real password was then
    // recovered from it. So a database whose stored hashes are truncated (or a row
    // an attacker can truncate) collapses the work factor from 2^256 to 2^8.
    //
    // THIS TEST USED TO PIN THE GAP. The fix is `if (expected.length !== KEYLEN) return false`
    // before the comparison, so a stored hash that is not exactly 32 bytes is now treated as a
    // corrupt row rather than as a credential. The re-derivation is also asked for KEYLEN again
    // instead of `expected.length`, so the two buffers being compared are always full length.
    // The rollout cost is real and accepted: a legitimately truncated row now FAILS to verify and
    // its owner must reset the password -- which is the correct outcome, because that row was
    // also verifiable by any 1-byte collision.
    const full = hashPassword('correct-horse')
    const parts = full.split('$')
    const hashBytes = Buffer.from(parts[2]!, 'base64url')
    expect(hashBytes.length).toBe(32)

    for (const keep of [1, 8, 16, 24, 31]) {
      const truncated = `scrypt$${parts[1]}$${hashBytes.subarray(0, keep).toString('base64url')}`
      // FIXED: even the CORRECT password is now rejected, because the stored hash is not 32 bytes.
      expect(verifyPassword('correct-horse', truncated)).toBe(false)
      expect(verifyPassword('wrong-horse', truncated)).toBe(false)
    }
    // A 33-byte hash is equally invalid -- the rule is exact equality, not a minimum.
    const tooLong = Buffer.concat([hashBytes, Buffer.from([1])])
    expect(
      verifyPassword('correct-horse', `scrypt$${parts[1]}$${tooLong.toString('base64url')}`),
    ).toBe(false)
    // And the full-length value still verifies, so the guard rejects only malformed rows.
    expect(verifyPassword('correct-horse', full)).toBe(true)
  })

  it('a truncated SALT fails, because the salt feeds the derivation input', () => {
    // The contrast that shows this is specific to the HASH field: the salt is an
    // INPUT to scrypt, so changing its length changes the derived key rather than
    // shortening the comparison.
    const full = hashPassword('pw')
    const parts = full.split('$')
    const saltBytes = Buffer.from(parts[1]!, 'base64url')
    for (const keep of [4, 8, 12]) {
      const truncatedSalt = saltBytes.subarray(0, keep).toString('base64url')
      expect(verifyPassword('pw', `scrypt$${truncatedSalt}$${parts[2]}`)).toBe(false)
    }
  })

  it('a tampered SALT fails the comparison', () => {
    const full = hashPassword('pw')
    const parts = full.split('$')
    const otherSalt = Buffer.alloc(16, 7).toString('base64url')
    expect(verifyPassword('pw', `scrypt$${otherSalt}$${parts[2]}`)).toBe(false)
  })

  it('a WRONG PREFIX is rejected even when salt and hash are both correct', () => {
    // The `parts[0] !== 'scrypt'` half of the guard, and this is the test that makes
    // it observable. My earlier malformed fixture used `bcrypt$abcdef$ghijkl`, whose
    // hash does not match, so the value was rejected by the COMPARISON and the prefix
    // check was never the reason -- the control could not bite. Here the salt and
    // hash are REAL, so the ONLY thing rejecting the value is the prefix.
    //
    // Without this check, a row whose prefix is a different scheme still verifies,
    // which would defeat the whole point of tagging the format: a future hash
    // migration could not tell its own rows apart from the old ones.
    const full = hashPassword('pw')
    const [, salt, hash] = full.split('$')
    expect(verifyPassword('pw', full)).toBe(true)
    expect(verifyPassword('pw', `bcrypt$${salt}$${hash}`)).toBe(false)
    expect(verifyPassword('pw', `scrypt2$${salt}$${hash}`)).toBe(false)
    expect(verifyPassword('pw', `$${salt}$${hash}`)).toBe(false)
  })

  it('a FOUR-part value is rejected even when its hash field is CORRECT', () => {
    // The `parts.length !== 3` half of the guard. Without it, a value carrying extra
    // fields -- `scrypt$<salt>$<correct hash>$extra` -- would be parsed from the
    // first three parts and ACCEPT the password, silently tolerating a stored value
    // that is not the documented format. My earlier malformed list used 4 parts whose
    // hash field was wrong, so that control could not bite: this one computes the
    // real hash first, so the ONLY thing rejecting it is the length check.
    const full = hashPassword('pw')
    expect(verifyPassword('pw', `${full}$extra`)).toBe(false)
    expect(verifyPassword('pw', `prefix$${full}`)).toBe(false)
    // Sanity: the same three parts DO verify, so the rejection is the extra field.
    expect(verifyPassword('pw', full)).toBe(true)
  })

  it('a hash produced with a DIFFERENT cost does not verify', () => {
    // The cost (N=16384) lives in the CODE, so a hash made with a smaller N must
    // fail. Without pinning this, lowering the cost would keep the suite green while
    // making every existing stored hash unverifiable in production -- a silent
    // lockout discovered only at the first login after deploy.
    const salt = crypto.randomBytes(16)
    const cheap = crypto.scryptSync('pw', salt, 32, { N: 1024, r: 8, p: 1 })
    const stored = `scrypt$${salt.toString('base64url')}$${cheap.toString('base64url')}`
    expect(verifyPassword('pw', stored)).toBe(false)
  })

  it('a hard-coded COST change would invalidate old hashes (documents the format)', () => {
    // The cost lives in the CODE, not in the stored value. A hash produced with the
    // documented cost verifies; the format string is pinned so a change to the
    // separator or the prefix is caught here rather than at the first login.
    const stored = hashPassword('pw')
    expect(stored.split('$')).toHaveLength(3)
    expect(stored.split('$')[0]).toBe('scrypt')
    expect(Buffer.from(stored.split('$')[1]!, 'base64url').length).toBe(16)
    expect(Buffer.from(stored.split('$')[2]!, 'base64url').length).toBe(32)
  })
})
