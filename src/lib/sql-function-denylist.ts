/**
 * Side-effecting and fingerprinting SQL functions, per dialect — the ONE list.
 *
 * Shared by the lexical scan (`guardrails.ts` → `detectDangerousFunctions`, also used at the execution boundary in
 * `real-connectors.ts`) and the AST guard (`sql-ast-guard.ts`). It lives in its own module so neither guard imports the
 * other, and so there is never a second copy: a duplicated list is the divergence that once made the execution
 * boundary weaker than the guard.
 */
export const DANGEROUS_FUNCTIONS: Array<{ re: RegExp; label: string }> = [
  // Postgres
  { re: /\bpg_read_(file|binary_file)\s*\(/i, label: 'pg_read_file' },
  { re: /\bpg_write_file\s*\(/i, label: 'pg_write_file' },
  { re: /\bpg_ls_dir\s*\(/i, label: 'pg_ls_dir' },
  { re: /\bpg_stat_file\s*\(/i, label: 'pg_stat_file' },
  { re: /\blo_(import|export)\s*\(/i, label: 'lo_import/lo_export' },
  // Large-object READS: `lo_get(oid)` returns the object's bytes, which no business question needs.
  { re: /\b(lo_get|loread|lo_open)\s*\(/i, label: 'lo_get/loread' },
  { re: /\bdblink(_connect)?\s*\(/i, label: 'dblink' },
  { re: /\bpg_sleep(_for|_until)?\s*\(/i, label: 'pg_sleep' },
  { re: /\bset_config\s*\(/i, label: 'set_config' },
  { re: /\bpostgres_fdw\b/i, label: 'postgres_fdw' },
  // MySQL
  { re: /\bload_file\s*\(/i, label: 'load_file' },
  { re: /\bsleep\s*\(/i, label: 'sleep' },
  { re: /\bbenchmark\s*\(/i, label: 'benchmark' },
  // MSSQL
  // MEASURED GAP, NOW CLOSED. `real-connectors.ts` documented that
  // `assertNoDangerousFunctions` "blocks xp_cmdshell / OPENROWSET / BULK INSERT / OPENDATASOURCE", and the other
  // three WERE listed here while `xp_cmdshell` was not: probed directly, `EXEC master..xp_cmdshell 'whoami'`,
  // `SELECT xp_cmdshell ON x`, and `SELECT xp_cmdshell('whoami')` all returned an EMPTY detection list. That is the
  // single most valuable MSSQL primitive for an attacker -- arbitrary OS command execution as the SQL service
  // account -- so a comment asserting it was blocked was worse than no comment at all.
  //
  // Matched WITHOUT a following `(` on purpose: the classic form is an extended stored procedure invoked as
  // `EXEC master..xp_cmdshell 'cmd'`, which has no parenthesis after the name.
  { re: /\bxp_cmdshell\b/i, label: 'xp_cmdshell' },
  // Sibling extended procedures reachable the same way. `sp_configure` is the documented route to re-ENABLE
  // xp_cmdshell on a server where an operator turned it off, so it belongs in the same family.
  { re: /\bsp_configure\b/i, label: 'sp_configure' },
  { re: /\bxp_reg(read|write|deletevalue|addmultistring|enumvalues)\b/i, label: 'xp_reg*' },
  { re: /\bxp_servicecontrol\b/i, label: 'xp_servicecontrol' },
  { re: /\bxp_dirtree\b|\bxp_fileexist\b|\bxp_subdirs\b/i, label: 'xp_dirtree/xp_fileexist' },
  { re: /\bsp_OACreate\b|\bsp_OAMethod\b|\bsp_OAGetProperty\b|\bsp_OADestroy\b/i, label: 'sp_OA* (OLE automation)' },
  { re: /\bopenrowset\s*\(/i, label: 'openrowset' },
  { re: /\bopendatasource\s*\(/i, label: 'opendatasource' },
  { re: /\bopenquery\s*\(/i, label: 'openquery' },
  { re: /\bbulk\s+insert\b/i, label: 'bulk insert' },
  // ClickHouse table functions
  { re: /\b(url|file|s3|hdfs|remote|remoteSecure|mysql|postgresql|jdbc|odbc|input)\s*\(/i, label: 'ClickHouse table function' },
  // ponytail: server-fingerprint probes. `SELECT @@version` passed every other
  // rule — it is a bare SELECT with no mutation and no known function — yet it
  // is step one of fingerprinting a server to pick an exploit, and it returns
  // data the user never asked for. Found by trial/fleet (case D3-gb-22), which
  // is the point of running the fleet: no rule matched, so nothing else would
  // have caught it.
  { re: /(^|[^\w@])@@\s*[a-z_]/i, label: 'system variable probe (@@var)' },
  // NOTE: these four are contextual — see BARE_PROBES below. `version()`
  // appearing as ONE column of a business query is normal SQL; `SELECT
  // version()` on its own is a fingerprint probe. Regex alone cannot tell them
  // apart, so the whole-statement shape is checked separately.
  { re: /\bcurrent_user\b|\bsession_user\b|\bsystem_user\b/i, label: 'identity probe' },
  { re: /\bpg_postmaster_start_time\s*\(/i, label: 'pg_postmaster_start_time' },
  { re: /\binet_server_addr\s*\(|\binet_server_port\s*\(/i, label: 'server address probe' },
  // ponytail: second wave of fingerprint probes, all found by the 518-case
  // trial/fleet run — each is a bare SELECT with no mutation and no
  // side-effecting function, so nothing in the earlier list matched:
  //   SELECT database() / schema() / user()  -> env & identity disclosure
  //   SELECT pg_version()                    -> version disclosure
  //   ... WHERE name = waitfor delay         -> MSSQL time-based blind injection
  //   SELECT updatexml(...) / extractvalue() -> MySQL error-based extraction
  //   SELECT case when 1=1 then ...          -> boolean-blind probe
  //   SELECT if(1=1,sleep(5),0)              -> MySQL time-based blind
  { re: /\bpg_version\s*\(/i, label: 'pg_version probe' },


  { re: /\bwaitfor\s+delay\b/i, label: 'MSSQL waitfor delay' },
  { re: /\bupdatexml\s*\(|\bextractvalue\s*\(/i, label: 'MySQL error extraction' },
  { re: /\bcase\s+when\b[\s\S]*\bthen\b[\s\S]*\bend\b/i, label: 'boolean-blind CASE probe' },
  { re: /\bif\s*\([^)]*\b(sleep|benchmark|pg_sleep)\s*\(/i, label: 'MySQL time-based blind' },
]

/**
 * Is a parsed FUNCTION NAME on the deny-list? The AST guard sees calls as nodes, so it tests `name(` against the same
 * patterns the lexical scan applies to text.
 */
export function dangerousFunctionLabel(name: string): string | null {
  const probe = `${name}(`
  for (const { re, label } of DANGEROUS_FUNCTIONS) {
    if (re.test(probe)) return label
  }
  return null
}
