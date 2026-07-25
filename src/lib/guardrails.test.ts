import { describe, expect, test } from 'bun:test'
import { looksLikeSql, validateAndSanitizeLlmSql } from './guardrails'

describe('looksLikeSql', () => {
  test('SELECT → true', () => {
    expect(looksLikeSql('SELECT * FROM users')).toBe(true)
  })

  test('WITH (CTE) → true', () => {
    expect(looksLikeSql('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
  })

  test('lowercase select → true (case-insensitive)', () => {
    expect(looksLikeSql('select 1')).toBe(true)
  })

  test('natural language → false', () => {
    expect(looksLikeSql('show me the sales data')).toBe(false)
    expect(looksLikeSql('berapa total penjualan?')).toBe(false)
  })

  test('empty/whitespace → false', () => {
    expect(looksLikeSql('')).toBe(false)
    expect(looksLikeSql('   ')).toBe(false)
  })
})

describe('validateAndSanitizeLlmSql — empty & edge cases', () => {
  test('empty string → rejected', () => {
    const r = validateAndSanitizeLlmSql('')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeDefined()
  })

  test('whitespace only → rejected', () => {
    const r = validateAndSanitizeLlmSql('   \n\t  ')
    expect(r.ok).toBe(false)
  })

  test('very long SELECT → ok with LIMIT', () => {
    const cols = Array.from({ length: 50 }, (_, i) => `col${i}`).join(', ')
    const r = validateAndSanitizeLlmSql(`SELECT ${cols} FROM big_table`)
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100')
  })

  test('unicode in string literal → ok', () => {
    const r = validateAndSanitizeLlmSql(`SELECT 'café résumé naïve' FROM users`)
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('café')
  })
})

describe('validateAndSanitizeLlmSql — leading keyword enforcement', () => {
  test('SHOW → rejected (not SELECT/WITH)', () => {
    const r = validateAndSanitizeLlmSql('SHOW TABLES')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('SELECT')
  })

  test('EXPLAIN → rejected', () => {
    expect(validateAndSanitizeLlmSql('EXPLAIN SELECT 1').ok).toBe(false)
  })

  test('DESCRIBE → rejected', () => {
    expect(validateAndSanitizeLlmSql('DESCRIBE users').ok).toBe(false)
  })

  test('WITH (CTE) leading → ok', () => {
    const r = validateAndSanitizeLlmSql('WITH cte AS (SELECT 1) SELECT * FROM cte')
    expect(r.ok).toBe(true)
  })
})

describe('validateAndSanitizeLlmSql — mutation keyword rejection', () => {
  const mutations = [
    'DELETE FROM users',
    'UPDATE users SET name = "x"',
    "INSERT INTO users VALUES (1)",
    'DROP TABLE users',
    'ALTER TABLE users ADD COLUMN x INT',
    'TRUNCATE TABLE users',
    'CREATE TABLE hack (x INT)',
    'GRANT ALL ON *.* TO attacker',
    'REVOKE ALL ON db.* FROM user',
    'MERGE INTO t USING s ON 1=1',
    'CALL evil_proc()',
    "EXEC evil_proc",
    'EXECUTE evil_proc',
    'RENAME TABLE a TO b',
    'VACUUM',
    'REINDEX',
    'ANALYZE users',
    'BEGIN TRANSACTION',
    'COMMIT',
    'ROLLBACK',
  ]

  for (const sql of mutations) {
    test(`${sql} → rejected`, () => {
      const r = validateAndSanitizeLlmSql(sql)
      expect(r.ok).toBe(false)
      expect(r.detectedNodes).toBeDefined()
      expect(r.detectedNodes!.length).toBeGreaterThan(0)
    })
  }
})

describe('validateAndSanitizeLlmSql — dangerous patterns', () => {
  test('inline comment -- → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT 1 -- comment').ok).toBe(false)
  })

  test('block comment /* → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT 1 /* comment */').ok).toBe(false)
  })

  test('xp_ extended proc → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT xp_cmdshell("dir")').ok).toBe(false)
  })

  test('sp_ system proc → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT sp_executesql("x")').ok).toBe(false)
  })

  test('statement chaining with ; → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT 1; DROP TABLE users').ok).toBe(false)
  })

  test('load_file() → blocked', () => {
    expect(validateAndSanitizeLlmSql("SELECT load_file('/etc/passwd')").ok).toBe(false)
  })

  test('into outfile → blocked', () => {
    expect(validateAndSanitizeLlmSql("SELECT 'x' INTO OUTFILE '/tmp/shell.php'").ok).toBe(false)
  })

  test('information_schema access → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT * FROM information_schema.tables').ok).toBe(false)
  })

  test('sqlite_master access → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT * FROM sqlite_master').ok).toBe(false)
  })

  test('ATTACH DATABASE → blocked', () => {
    expect(validateAndSanitizeLlmSql("ATTACH DATABASE '/tmp/evil.db' AS evil").ok).toBe(false)
  })

  test('SELECT ... INTO new_table → blocked', () => {
    expect(validateAndSanitizeLlmSql('SELECT * INTO backup FROM users').ok).toBe(false)
  })
})

describe('validateAndSanitizeLlmSql — LIMIT clamping', () => {
  test('missing LIMIT → appended as LIMIT 100', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100')
    expect(r.sanitized.endsWith(';')).toBe(true)
  })

  test('LIMIT 50 → stays 50', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users LIMIT 50')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 50')
    expect(r.sanitized).not.toContain('LIMIT 100')
  })

  test('LIMIT 200 → clamped to 100', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users LIMIT 200')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100')
    expect(r.sanitized).not.toContain('LIMIT 200')
  })

  test('LIMIT 100 → stays 100', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users LIMIT 100')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100')
  })

  test('LIMIT 200 OFFSET 10 → clamped to 100, offset preserved', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users LIMIT 200 OFFSET 10')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100 OFFSET 10')
  })

  test('LIMIT 50 OFFSET 5 → stays 50, offset preserved', () => {
    const r = validateAndSanitizeLlmSql('SELECT * FROM users LIMIT 50 OFFSET 5')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 50 OFFSET 5')
  })
})

describe('validateAndSanitizeLlmSql — string literal handling', () => {
  test("SELECT 'DROP TABLE' → NOT blocked (string literal)", () => {
    const r = validateAndSanitizeLlmSql("SELECT 'DROP TABLE' FROM users")
    expect(r.ok).toBe(true)
  })

  test("SELECT 'DELETE FROM users' → NOT blocked", () => {
    const r = validateAndSanitizeLlmSql("SELECT 'DELETE FROM users' AS payload")
    expect(r.ok).toBe(true)
  })

  test('SELECT "UPDATE" AS word → NOT blocked (quoted identifier)', () => {
    const r = validateAndSanitizeLlmSql('SELECT "UPDATE" AS word FROM users')
    expect(r.ok).toBe(true)
  })

  test('SELECT with semicolon inside string → blocked by pre-scan', () => {
    // ponytail: pre-scan is pattern-based, can't distinguish string literals — conservative block
    expect(validateAndSanitizeLlmSql("SELECT '; DROP TABLE' FROM x").ok).toBe(false)
  })
})

describe('validateAndSanitizeLlmSql — multi-statement rejection', () => {
  test('SELECT 1; DROP TABLE users → blocked by pre-scan', () => {
    const r = validateAndSanitizeLlmSql('SELECT 1; DROP TABLE users')
    expect(r.ok).toBe(false)
  })

  test('trailing semicolon is stripped, single statement ok', () => {
    const r = validateAndSanitizeLlmSql('SELECT 1;')
    expect(r.ok).toBe(true)
    expect(r.sanitized).toContain('LIMIT 100')
  })

  test('SELECT 1; SELECT 2 → blocked by chaining pattern', () => {
    expect(validateAndSanitizeLlmSql('SELECT 1; SELECT 2').ok).toBe(false)
  })
})
