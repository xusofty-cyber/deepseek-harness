/**
 * Deterministic tenant-to-shard routing for the NILM StatefulSet. The same
 * tenant id always selects the same shard for a given shard count, so a
 * restarted or rescheduled Pod reattaches to the Session JSONL on its own PVC.
 *
 * @module @deepseek-ai/dsh-nilm-sharding
 */

const C1 = 0xcc9e2d51
const C2 = 0x1b873593

/** Seed for {@link murmur3x86_32}; zero matches the reference test vectors. */
export const MURMUR3_DEFAULT_SEED = 0

/**
 * Compute MurmurHash3 x86-32 over the UTF-8 bytes of one value.
 *
 * @param value - text to hash; encoded as UTF-8 so hosts agree on the same bytes.
 * @param seed - unsigned 32-bit seed.
 * @returns the unsigned 32-bit hash.
 */
export function murmur3x86_32(value: string, seed: number = MURMUR3_DEFAULT_SEED): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('seed must be an unsigned 32-bit integer')
  }
  const bytes = new TextEncoder().encode(value)
  const length = bytes.length
  let hash = seed | 0

  let offset = 0
  while (offset + 4 <= length) {
    let block = bytes[offset]!
      | (bytes[offset + 1]! << 8)
      | (bytes[offset + 2]! << 16)
      | (bytes[offset + 3]! << 24)
    block = Math.imul(block, C1)
    block = rotateLeft(block, 15)
    block = Math.imul(block, C2)

    hash ^= block
    hash = rotateLeft(hash, 13)
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0
    offset += 4
  }

  let tail = 0
  const remaining = length - offset
  if (remaining >= 3) tail ^= bytes[offset + 2]! << 16
  if (remaining >= 2) tail ^= bytes[offset + 1]! << 8
  if (remaining >= 1) {
    tail ^= bytes[offset]!
    tail = Math.imul(tail, C1)
    tail = rotateLeft(tail, 15)
    tail = Math.imul(tail, C2)
    hash ^= tail
  }

  hash ^= length
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/** One resolved shard membership of a running Pod. */
export interface ShardAssignment {
  /** Zero-based shard index served by this Pod. */
  readonly index: number
  /** Total number of shards in the StatefulSet. */
  readonly count: number
}

/**
 * Apply the single-shard default and validate a configured membership.
 *
 * @param index - configured shard index; omitted selects shard zero.
 * @param count - configured shard count; omitted selects one shard.
 * @returns the validated, detached assignment.
 * @throws TypeError when the count is not positive or the index is outside it.
 */
export function resolveShardAssignment(index?: number, count?: number): ShardAssignment {
  const resolvedCount = count ?? 1
  const resolvedIndex = index ?? 0
  if (!Number.isSafeInteger(resolvedCount) || resolvedCount < 1) {
    throw new TypeError('shardCount must be a positive integer')
  }
  if (!Number.isSafeInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= resolvedCount) {
    throw new TypeError('shardIndex must be an integer in [0, shardCount)')
  }
  return { index: resolvedIndex, count: resolvedCount }
}

/**
 * Select the shard that owns one tenant for the configured shard count.
 *
 * @param tenantId - authenticated tenant id; hashed exactly as supplied.
 * @param shardCount - positive number of StatefulSet shards.
 * @returns the zero-based shard index.
 * @throws TypeError when the tenant id is blank or the count is not positive.
 */
export function shardForTenant(tenantId: string, shardCount: number): number {
  if (tenantId.trim() === '') throw new TypeError('tenantId must be a non-empty string')
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new TypeError('shardCount must be a positive integer')
  }
  return murmur3x86_32(tenantId) % shardCount
}

/**
 * Name the StatefulSet Pod that owns one shard.
 *
 * @param prefix - StatefulSet name, for example `nilm-agent`.
 * @param index - zero-based shard index.
 * @returns the stable Pod name, for example `nilm-agent-2`.
 */
export function shardPodName(prefix: string, index: number): string {
  if (prefix.trim() === '') throw new TypeError('prefix must be a non-empty string')
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('index must be a non-negative integer')
  return `${prefix}-${String(index)}`
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}
