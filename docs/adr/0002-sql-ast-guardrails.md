# ADR 0002: SQL AST Guardrails

**Status:** Accepted  
**Date:** 2026-07-30

## Context

The assistant generates SQL from natural language and executes it against customer databases. Unrestricted SQL execution allows data destruction (`DROP TABLE`), data modification (`UPDATE`, `DELETE`, `INSERT`), and resource exhaustion (`SELECT * FROM huge_table` without LIMIT). Naive string-based filtering (regex on keywords) is bypassable via comments, encoding, and nested queries.

## Decision

Validate generated SQL at the AST (Abstract Syntax Tree) level before execution. Parse the SQL into an AST and enforce: (1) only `SELECT` statements (block all DML/DDL), (2) `LIMIT` clause capped at 100 rows (clamp higher values), (3) block dangerous patterns (subqueries with side effects, `INTO` clauses). Implemented in `src/lib/guardrails.ts` using a SQL parser.

## Consequences

- **Positive:** Safe SQL execution — structural validation cannot be bypassed by string tricks. Zero competitors in the enterprise AI space have AST-level guardrails by default. Predictable resource usage via LIMIT cap.
- **Negative:** Some legitimate analytical queries (e.g., `CREATE TEMP TABLE` for complex transforms) are blocked. Adds parsing latency (~1-5ms per query).

## Alternatives

- **Regex keyword blocklist:** Rejected — bypassable via `/* comment */`, nested subqueries, hex encoding. Security theater.
- **Read-only DB user:** Partial defense — still allows `SELECT *` without LIMIT (resource exhaustion). Used as defense-in-depth alongside AST guardrails, not as a replacement.
- **No execution, return SQL only:** Rejected — defeats the purpose of an AI assistant that answers questions with data.
