/**
 * Durable conversation metadata for the BFF. Session events live in the JSONL
 * backend; this store keeps only the caller-visible index needed to list and
 * continue a conversation after the Pod that created it is gone.
 *
 * @module @deepseek-ai/dsh-nilm-service/conversations
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TenantId } from '@deepseek-ai/dsh-nilm-core'
import { tenantPathSegment } from './paths.ts'

/** One conversation index record; live agent and turn state are never stored. */
export interface StoredConversation {
  readonly id: string
  readonly sessionId: string
  readonly tenantId: TenantId
  readonly userRef: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastText: string
}

/** Persistence seam for conversation metadata. */
export interface ConversationStore {
  /**
   * List the tenant's stored conversations.
   * @param tenantId - owning tenant.
   * @param userRef - optional caller filter.
   * @returns detached records in no promised order.
   */
  list(tenantId: TenantId, userRef?: string): Promise<readonly StoredConversation[]>

  /**
   * Read one stored conversation.
   * @param tenantId - owning tenant.
   * @param id - conversation id.
   * @returns the record, or `undefined` when the tenant has no such record.
   */
  get(tenantId: TenantId, id: string): Promise<StoredConversation | undefined>

  /**
   * Create or replace one conversation record durably.
   * @param record - authoritative record.
   * @returns nothing after the record is readable under its final name.
   */
  put(record: StoredConversation): Promise<void>
}

/** Process-local store used when no sessions root is configured. */
export class MemoryConversationStore implements ConversationStore {
  private readonly records = new Map<string, StoredConversation>()

  /** @inheritDoc */
  async list(tenantId: TenantId, userRef?: string): Promise<readonly StoredConversation[]> {
    return [...this.records.values()].filter(record => record.tenantId === tenantId
      && (userRef === undefined || record.userRef === userRef))
  }

  /** @inheritDoc */
  async get(tenantId: TenantId, id: string): Promise<StoredConversation | undefined> {
    const record = this.records.get(id)
    return record?.tenantId === tenantId ? record : undefined
  }

  /** @inheritDoc */
  async put(record: StoredConversation): Promise<void> {
    this.records.set(record.id, record)
  }
}

/** One JSON file per conversation beneath the tenant's PVC directory. */
export class FileConversationStore implements ConversationStore {
  private readonly root: string

  /**
   * @param root - sessions root shared with the JSONL backend.
   */
  constructor(root: string) {
    this.root = root
  }

  /** @inheritDoc */
  async list(tenantId: TenantId, userRef?: string): Promise<readonly StoredConversation[]> {
    const directory = this.directory(tenantId)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const records: StoredConversation[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const record = await this.read(join(directory, name))
      if (record.tenantId !== tenantId) continue
      if (userRef !== undefined && record.userRef !== userRef) continue
      records.push(record)
    }
    return records
  }

  /** @inheritDoc */
  async get(tenantId: TenantId, id: string): Promise<StoredConversation | undefined> {
    if (!CONVERSATION_ID.test(id)) return undefined
    try {
      const record = await this.read(this.path(tenantId, id))
      return record.tenantId === tenantId ? record : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  /** @inheritDoc */
  async put(record: StoredConversation): Promise<void> {
    if (!CONVERSATION_ID.test(record.id)) throw new TypeError('conversation id is malformed')
    const target = this.path(record.tenantId, record.id)
    const directory = dirname(target)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${record.id}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await handle.close()
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await syncDirectory(directory)
  }

  private directory(tenantId: TenantId): string {
    return join(this.root, tenantPathSegment(tenantId), '.nilm', 'conversations')
  }

  private path(tenantId: TenantId, id: string): string {
    return join(this.directory(tenantId), `${id}.json`)
  }

  private async read(path: string): Promise<StoredConversation> {
    const text = await readFile(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new Error(`corrupt conversation record "${path}": not JSON`, { cause: error })
    }
    return parseStoredConversation(value, path)
  }
}

const CONVERSATION_ID = /^conv_[A-Za-z0-9]+$/

/**
 * Validate one decoded record. Records cross a durable boundary, so a malformed
 * file is refused instead of being silently skipped.
 */
function parseStoredConversation(value: unknown, path: string): StoredConversation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(path, 'not an object')
  const record = value as Record<string, unknown>
  const { id, sessionId, tenantId, userRef, createdAt, updatedAt, lastText } = record
  if (typeof id !== 'string') corrupt(path, 'invalid id')
  if (!CONVERSATION_ID.test(id)) corrupt(path, 'invalid id')
  if (typeof sessionId !== 'string' || sessionId === '') corrupt(path, 'invalid sessionId')
  if (typeof tenantId !== 'string' || tenantId.trim() === '') corrupt(path, 'invalid tenantId')
  if (typeof userRef !== 'string' || userRef === '') corrupt(path, 'invalid userRef')
  if (!isTimestamp(createdAt)) corrupt(path, 'invalid createdAt')
  if (!isTimestamp(updatedAt)) corrupt(path, 'invalid updatedAt')
  if (typeof lastText !== 'string') corrupt(path, 'invalid lastText')
  return {
    id,
    sessionId,
    tenantId: brandString<TenantId>(tenantId),
    userRef,
    createdAt,
    updatedAt,
    lastText,
  }
}

function corrupt(path: string, reason: string): never {
  throw new Error(`corrupt conversation record "${path}": ${reason}`)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** Make the rename durable where the platform supports a directory fsync. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error
  } finally {
    await handle.close()
  }
}
