import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TenantId } from '@deepseek-ai/dsh-nilm-core'
import {
  FileConversationStore,
  MemoryConversationStore,
  type StoredConversation,
} from '../src/conversations.ts'
import { tenantPathSegment, tenantSessionRoot } from '../src/paths.ts'
import { resolveConfig } from '../src/config.ts'

const TENANT_A = brandString<TenantId>('tenant-a')
const TENANT_B = brandString<TenantId>('tenant-b')
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function record(id: string, tenantId: TenantId, userRef = 'user-1'): StoredConversation {
  return {
    id,
    sessionId: id,
    tenantId,
    userRef,
    createdAt: 1_000,
    updatedAt: 2_000,
    lastText: '昨日用电 12.3 kWh',
  }
}

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nilm-conversation-store-'))
  roots.push(directory)
  return directory
}

describe('tenant path segments', () => {
  it('keeps safe ids readable and escapes everything else', () => {
    expect(tenantPathSegment('tenant-a')).toBe('tenant-a')
    expect(tenantPathSegment('../tenant')).toBe('..~002Ftenant')
    expect(tenantPathSegment('a/b')).toBe('a~002Fb')
    expect(tenantPathSegment('a b')).toBe('a~0020b')
    expect(tenantPathSegment('工厂')).toBe('~5DE5~5382')
  })

  it('never returns a traversal component or an empty segment', () => {
    for (const tenant of ['.', '..', '/', '../..', 'a/../../b', '\\..\\']) {
      const segment = tenantPathSegment(tenant)
      expect(segment).not.toBe('.')
      expect(segment).not.toBe('..')
      expect(segment).not.toContain('/')
      expect(segment).not.toContain('\\')
      expect(segment.length).toBeGreaterThan(0)
    }
    expect(() => tenantPathSegment('   ')).toThrow(TypeError)
  })

  it('bounds overlong ids with an escaped digest', () => {
    const segment = tenantPathSegment('t'.repeat(300))
    expect(segment.startsWith('~LEN~')).toBe(true)
    expect(segment.length).toBeLessThanOrEqual(80)
    expect(segment).toBe(tenantPathSegment('t'.repeat(300)))
  })

  it('places every tenant under the configured root', () => {
    expect(tenantSessionRoot('/data/sessions', 'tenant-a')).toBe('/data/sessions/tenant-a')
    expect(tenantSessionRoot('/data/sessions', '../tenant-a')).toBe('/data/sessions/..~002Ftenant-a')
  })
})

describe('shard and sessions-root configuration', () => {
  const base = { model: 'deepseek-chat', signingSecrets: { 'tenant-a': 'a'.repeat(32) } }

  it('defaults to one shard and process-local conversation metadata', () => {
    const config = resolveConfig(base)
    expect(config.shard).toEqual({ index: 0, count: 1 })
    expect(config.sessionsRoot).toBeUndefined()
  })

  it('resolves an absolute sessions root and an explicit shard membership', () => {
    const config = resolveConfig({ ...base, sessionsRoot: '/data/sessions', shardIndex: 3, shardCount: 8 })
    expect(config.sessionsRoot).toBe('/data/sessions')
    expect(config.shard).toEqual({ index: 3, count: 8 })
  })

  it('fails loud when the shard membership is impossible', () => {
    expect(() => resolveConfig({ ...base, shardIndex: 8, shardCount: 8 })).toThrow(TypeError)
    expect(() => resolveConfig({ ...base, shardCount: 0 })).toThrow(TypeError)
  })
})

describe('MemoryConversationStore', () => {
  it('filters by tenant and caller and replaces records by id', async () => {
    const store = new MemoryConversationStore()
    await store.put(record('conv_a', TENANT_A))
    await store.put(record('conv_b', TENANT_B))
    await store.put(record('conv_c', TENANT_A, 'user-2'))
    await store.put({ ...record('conv_a', TENANT_A), updatedAt: 3_000 })

    expect((await store.list(TENANT_A)).map(item => item.id).sort()).toEqual(['conv_a', 'conv_c'])
    expect((await store.list(TENANT_A, 'user-1')).map(item => item.id)).toEqual(['conv_a'])
    expect((await store.get(TENANT_B, 'conv_a'))).toBeUndefined()
    expect((await store.get(TENANT_A, 'conv_a'))?.updatedAt).toBe(3_000)
  })
})

describe('FileConversationStore', () => {
  it('survives a store instance replacement and isolates tenants', async () => {
    const directory = await root()
    const first = new FileConversationStore(directory)
    await first.put(record('conv_a', TENANT_A))
    await first.put(record('conv_b', TENANT_B))

    const second = new FileConversationStore(directory)
    expect((await second.get(TENANT_A, 'conv_a'))?.id).toBe('conv_a')
    expect(await second.get(TENANT_B, 'conv_a')).toBeUndefined()
    expect((await second.list(TENANT_A)).map(item => item.id)).toEqual(['conv_a'])
    expect((await second.list(TENANT_B)).map(item => item.id)).toEqual(['conv_b'])

    const tenantFiles = await readdir(join(directory, 'tenant-a', '.nilm', 'conversations'))
    expect(tenantFiles).toEqual(['conv_a.json'])
    expect(JSON.parse(await readFile(join(directory, 'tenant-a', '.nilm', 'conversations', 'conv_a.json'), 'utf8')))
      .toMatchObject({ tenantId: 'tenant-a', lastText: '昨日用电 12.3 kWh' })
  })

  it('overwrites one record atomically and leaves no temporary file', async () => {
    const directory = await root()
    const store = new FileConversationStore(directory)
    await store.put(record('conv_a', TENANT_A))
    await store.put({ ...record('conv_a', TENANT_A), lastText: '新的摘要', updatedAt: 4_000 })

    const files = await readdir(join(directory, 'tenant-a', '.nilm', 'conversations'))
    expect(files).toEqual(['conv_a.json'])
    expect((await store.get(TENANT_A, 'conv_a'))?.lastText).toBe('新的摘要')
  })

  it('returns no records for an absent tenant directory', async () => {
    const store = new FileConversationStore(await root())
    expect(await store.list(TENANT_A)).toEqual([])
    expect(await store.get(TENANT_A, 'conv_absent')).toBeUndefined()
  })

  it('refuses a corrupt record instead of silently dropping it', async () => {
    const directory = await root()
    const store = new FileConversationStore(directory)
    await store.put(record('conv_a', TENANT_A))
    await writeFile(join(directory, 'tenant-a', '.nilm', 'conversations', 'conv_a.json'), '{not json', 'utf8')

    await expect(store.list(TENANT_A)).rejects.toThrow('corrupt conversation record')
    await expect(store.get(TENANT_A, 'conv_a')).rejects.toThrow('corrupt conversation record')
  })

  it('refuses malformed ids before touching the filesystem', async () => {
    const store = new FileConversationStore(await root())
    expect(await store.get(TENANT_A, '../conv_a')).toBeUndefined()
    await expect(store.put(record('../conv_a', TENANT_A))).rejects.toThrow(TypeError)
  })
})
