/**
 * Filesystem layout shared by the BFF's Session working directory and its
 * conversation records. One tenant always resolves to one directory beneath
 * the configured sessions root, so a Pod's PVC carries everything that tenant
 * needs after a restart.
 *
 * @module @deepseek-ai/dsh-nilm-service/paths
 */

import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** Longest literal segment kept as-is; longer escapes use a digest below. */
const MAX_LITERAL_SEGMENT = 200

/**
 * Encode one tenant id as a single filesystem-safe path segment. Every code
 * unit outside `[A-Za-z0-9._-]` becomes `~XXXX`, `.` and `..` are escaped, and
 * overlong ids become `~LEN~<digest>` (a form no literal segment can produce,
 * because `~` is always escaped in literal output).
 *
 * @param tenantId - authoritative tenant id from the verified caller envelope.
 * @returns one path segment that cannot traverse outside its parent.
 * @throws TypeError when the tenant id is blank.
 */
export function tenantPathSegment(tenantId: string): string {
  if (tenantId.trim() === '') throw new TypeError('tenantId must be a non-empty string')
  if (tenantId === '.') return '~002E'
  if (tenantId === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < tenantId.length; index++) {
    const code = tenantId.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    if (encoded.length > MAX_LITERAL_SEGMENT) {
      return `~LEN~${createHash('sha256').update(tenantId, 'utf8').digest('hex')}`
    }
  }
  return encoded
}

/**
 * Resolve the session working directory of one tenant.
 *
 * @param sessionsRoot - configured root mounted on the shard PVC.
 * @param tenantId - authoritative tenant id.
 * @returns the tenant's dedicated working directory.
 */
export function tenantSessionRoot(sessionsRoot: string, tenantId: string): string {
  const root = resolve(sessionsRoot)
  return join(root, tenantPathSegment(tenantId))
}
