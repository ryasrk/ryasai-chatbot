# ADR 0005: AES-256-GCM Credential Encryption

**Status:** Accepted  
**Date:** 2026-07-30

## Context

The assistant stores customer database credentials, API keys, and integration configs (SMTP tokens, webhook secrets) in its database. Plaintext or reversible encoding (base64) storage means a database breach exposes every customer's downstream systems. Many AI tools store credentials in plaintext or with weak encryption (AES-CBC without authentication).

## Decision

Encrypt all credentials at rest with AES-256-GCM (Galois/Counter Mode) using a 32-byte key from `ENCRYPTION_SECRET_KEY`. Use a 12-byte random nonce per encryption and 16-byte authentication tag. Store output as `hex(nonce || ciphertext || authTag)`. The key is fail-closed — missing/empty key throws at first use, no hardcoded fallback. Implemented in `src/lib/crypto.ts`.

## Consequences

- **Positive:** Authenticated encryption — tampering is detected (GCM auth tag). Database breach alone does not expose credentials (attacker needs the encryption key too). Zero competitors encrypt credentials by default. Nonce randomness prevents replay attacks.
- **Negative:** Key management is critical — losing `ENCRYPTION_SECRET_KEY` means all stored credentials are unrecoverable. Key rotation requires re-encrypting all rows. Adds ~0.1ms per encrypt/decrypt.

## Alternatives

- **AES-256-CBC:** Rejected — no authentication tag, vulnerable to padding oracle attacks without additional HMAC.
- **Plaintext with DB-level encryption (TDE):** Rejected — TDE protects at-rest disk theft but not DB-level SQL injection access. App-level encryption is defense-in-depth.
- **KMS/cloud-managed encryption:** Deferred — adds cloud dependency. Current AES-256-GCM is portable across deployments.
