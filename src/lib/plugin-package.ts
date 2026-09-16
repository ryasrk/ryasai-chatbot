/**
 * Portable plugin packages — the publish/install contract for third parties.
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS. Plugins could already be registered one at a time through the
 * admin API, but there was no way to HAND SOMEONE a plugin: no portable artifact,
 * no way to verify it had not been altered in transit, and no way to tell what a
 * package would do before installing it. This module is that surface.
 *
 * The shape follows the conventions a reader already knows:
 *   - `schemaVersion` at the root, like an OpenAI plugin manifest's schema_version
 *     and MCP's protocolVersion. An unrecognised version is REJECTED, not
 *     ignored — a package written for a newer format may rely on fields we would
 *     silently drop, and installing a partially understood plugin is worse than
 *     refusing it.
 *   - `integrity` is a SHA-256 over the canonical plugin definition, so a package
 *     edited after publication fails to install. It is a checksum, NOT a
 *     signature, and that distinction is deliberate: there is no PKI here, and a
 *     checksum is honest about what it proves (the bytes are unchanged) versus
 *     what it does not (who wrote them).
 *
 * The package NEVER carries credentials. Secrets stay in the install's own
 * encrypted store; a package that shipped them would leak them the moment it was
 * shared. `authCredentials` in an embedded manifest is STRIPPED on export and
 * REFUSED on import.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePluginManifest, normalizeManifest, computeManifestDigest } from '@/lib/plugin-registry'

/** The package format version this build understands. */
export const PLUGIN_PACKAGE_SCHEMA_VERSION = 1

export interface PluginPackage {
  schemaVersion: number
  toolId: string
  name: string
  description: string
  category: string
  subcategory: string
  keywords: string
  /** The plugin's own manifest, with credentials stripped. */
  manifest: Record<string, unknown>
  /** SHA-256 of the canonical definition. */
  integrity: string
  /** Free-form provenance, e.g. `{ author, homepage, license }`. Advisory only. */
  metadata?: Record<string, string>
}

const PluginPackageSchema = z.object({
  schemaVersion: z.number().int(),
  toolId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: z.string().max(64).default('general'),
  subcategory: z.string().max(64).default('general'),
  keywords: z.string().max(2000).default(''),
  manifest: z.record(z.string(), z.unknown()),
  integrity: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
})

/**
 * The canonical bytes an `integrity` value covers.
 *
 * ONLY the fields that define BEHAVIOUR are included. `name`, `description`,
 * `keywords` and `metadata` are presentation, and folding them in would make a
 * harmless typo in a description fail the checksum — training people to bypass
 * it. The embedded manifest is digested through `computeManifestDigest`, the
 * same function execution uses, so the two can never disagree about what
 * "unchanged" means.
 */
export function computePackageIntegrity(pkg: Omit<PluginPackage, 'integrity'>): string {
  const parsed = parsePluginManifest(JSON.stringify(pkg.manifest))
  const material = JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    toolId: pkg.toolId,
    category: pkg.category,
    subcategory: pkg.subcategory,
    manifestDigest: parsed ? computeManifestDigest(parsed) : JSON.stringify(pkg.manifest),
  })
  return createHash('sha256').update(material).digest('hex')
}

/** Strip anything that must not travel in a shareable package. */
function stripSecrets(manifest: Record<string, unknown>): Record<string, unknown> {
  const out = { ...manifest }
  // Credentials are per-install. Exporting them would leak a secret the moment
  // the package is shared, and importing them would let a package overwrite the
  // installer's own credentials.
  delete out.authCredentials
  return out
}

/**
 * Build a package from a registered plugin row.
 *
 * Returns `{ error }` when the stored manifest is invalid — packaging something
 * we cannot validate would hand a recipient a file we know is broken.
 */
export function exportPluginPackage(row: {
  toolId: string
  name: string
  description: string
  category: string
  subcategory: string
  keywords: string
  manifestJson: string
}): PluginPackage | { error: string } {
  const parsed = parsePluginManifest(row.manifestJson)
  if (!parsed) return { error: `Plugin "${row.toolId}" has an invalid manifest and cannot be packaged.` }
  const manifest = stripSecrets(parsed as unknown as Record<string, unknown>)
  const base = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    toolId: row.toolId,
    name: row.name,
    description: row.description,
    category: row.category,
    subcategory: row.subcategory,
    keywords: row.keywords,
    manifest,
  }
  return { ...base, integrity: computePackageIntegrity(base) }
}

export interface InstallPlan {
  /** What will be registered, ready to write. */
  toolId: string
  name: string
  description: string
  category: string
  subcategory: string
  keywords: string
  manifestJson: string
  /** The digest to store so execution can detect later tampering. */
  manifestDigest: string
  /** Advisory warnings worth showing the installer before they approve. */
  warnings: string[]
}

/**
 * Validate a package and describe exactly what installing it would do.
 *
 * This SEPARATES validation from writing on purpose. Installing a plugin means
 * spawning processes or calling someone's endpoint, so the operator must be able
 * to see what they are approving first — and a caller that writes without
 * planning cannot show them.
 */
export function planPluginInstall(raw: unknown): InstallPlan | { error: string } {
  const result = PluginPackageSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    return { error: first ? `Invalid package: ${first.path.join('.')} — ${first.message}` : 'Invalid package.' }
  }
  const pkg = result.data as PluginPackage

  if (pkg.schemaVersion !== PLUGIN_PACKAGE_SCHEMA_VERSION) {
    // Refuse rather than ignore: a newer package may carry fields we would drop.
    return {
      error:
        `Package schemaVersion ${pkg.schemaVersion} is not supported by this install `
        + `(this build understands version ${PLUGIN_PACKAGE_SCHEMA_VERSION}). Upgrade before installing.`,
    }
  }

  // Integrity covers the definition; the manifest is validated on its own terms
  // afterwards, so a package with a broken manifest fails with a USEFUL error
  // rather than a checksum mismatch.
  const expected = computePackageIntegrity({ ...pkg, integrity: undefined } as Omit<PluginPackage, 'integrity'>)
  if (expected !== pkg.integrity) {
    return {
      error:
        'This package failed its integrity check — it was modified after it was created. '
        + 'Re-download it from the original source, or ask the author for a fresh package.',
    }
  }

  // Credentials must never arrive in a package: they are per-install secrets, and
  // accepting them would let a package silently install someone else's.
  if (typeof pkg.manifest.authCredentials === 'string' && pkg.manifest.authCredentials.length > 0) {
    return {
      error:
        'This package carries credentials. Packages must not ship secrets — '
        + 'remove authCredentials and configure the credential after installing.',
    }
  }

  const normalized = normalizeManifest(pkg.manifest)
  if ('error' in normalized) return { error: normalized.error }

  const warnings: string[] = []
  if (normalized.executorType === 'mcp-stdio') {
    warnings.push(
      `Runs a local process: ${normalized.command} ${(normalized.args ?? []).join(' ')}. `
      + 'It runs under process isolation, but review this before approving.',
    )
  } else if (normalized.endpoint) {
    warnings.push(`Sends requests to ${normalized.endpoint}.`)
  }
  if (normalized.authType !== 'NONE') {
    warnings.push(`Expects an ${normalized.authType} credential, which you must configure after install.`)
  }
  if (!normalized.parameters) {
    warnings.push('Declares no parameter schema, so the model must guess its arguments.')
  }

  return {
    toolId: pkg.toolId,
    name: pkg.name,
    description: pkg.description,
    category: pkg.category,
    subcategory: pkg.subcategory,
    keywords: pkg.keywords,
    manifestJson: JSON.stringify(normalized),
    manifestDigest: computeManifestDigest(normalized),
    warnings,
  }
}

/**
 * Deterministic JSON for a package file.
 *
 * Stable key order so two exports of the same plugin are byte-identical — a
 * diff between two packages then shows a real change instead of reshuffled keys.
 */
export function serializePluginPackage(pkg: PluginPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`
}
