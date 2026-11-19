import { describe, expect, it } from 'vitest'
import {
  murmur3x86_32,
  resolveShardAssignment,
  shardForTenant,
  shardPodName,
} from '../src/index.ts'

describe('murmur3x86_32', () => {
  it('matches the reference x86-32 vectors', () => {
    expect(murmur3x86_32('')).toBe(0)
    expect(murmur3x86_32('a')).toBe(1_009_084_850)
    expect(murmur3x86_32('abc')).toBe(3_017_643_002)
    expect(murmur3x86_32('hello')).toBe(613_153_351)
  })

  it('returns an unsigned 32-bit result for every seed', () => {
    for (let seed = 0; seed <= 0xffff_ffff; seed += 0x1111_1111) {
      const hash = murmur3x86_32('tenant-2026', seed)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffff_ffff)
    }
  })

  it('distinguishes tenant ids that differ only in trailing bytes', () => {
    expect(murmur3x86_32('tenant-1')).not.toBe(murmur3x86_32('tenant-2'))
    expect(murmur3x86_32('tenant-1')).not.toBe(murmur3x86_32('tenant-1 '))
  })

  it('hashes UTF-8 bytes rather than UTF-16 code units', () => {
    expect(murmur3x86_32('工厂-A')).not.toBe(murmur3x86_32('工\u0000厂-A'))
    expect(murmur3x86_32('工厂-A')).toBe(murmur3x86_32('工厂-A'))
  })

  it('rejects seeds outside the unsigned range', () => {
    expect(() => murmur3x86_32('x', -1)).toThrow(TypeError)
    expect(() => murmur3x86_32('x', 1.5)).toThrow(TypeError)
    expect(() => murmur3x86_32('x', 0x1_0000_0000)).toThrow(TypeError)
  })
})

describe('shardForTenant', () => {
  it('is stable for one tenant and one shard count', () => {
    const first = shardForTenant('tenant-a', 8)
    for (let attempt = 0; attempt < 50; attempt++) expect(shardForTenant('tenant-a', 8)).toBe(first)
  })

  it('always returns an index inside the configured shard count', () => {
    for (const count of [1, 2, 3, 7, 8, 16, 64]) {
      for (let tenant = 0; tenant < 200; tenant++) {
        const shard = shardForTenant(`tenant-${String(tenant)}`, count)
        expect(shard).toBeGreaterThanOrEqual(0)
        expect(shard).toBeLessThan(count)
      }
    }
  })

  it('uses every shard for a multi-tenant set', () => {
    const seen = new Set<number>()
    for (let tenant = 0; tenant < 64; tenant++) seen.add(shardForTenant(`factory-${String(tenant)}`, 8))
    expect(seen.size).toBe(8)
  })

  it('maps every tenant to shard zero when one shard is configured', () => {
    for (let tenant = 0; tenant < 20; tenant++) expect(shardForTenant(`tenant-${String(tenant)}`, 1)).toBe(0)
  })

  it('rejects blank tenants and non-positive counts', () => {
    expect(() => shardForTenant('', 4)).toThrow(TypeError)
    expect(() => shardForTenant('   ', 4)).toThrow(TypeError)
    expect(() => shardForTenant('tenant-a', 0)).toThrow(TypeError)
    expect(() => shardForTenant('tenant-a', -2)).toThrow(TypeError)
    expect(() => shardForTenant('tenant-a', 2.5)).toThrow(TypeError)
  })
})

describe('resolveShardAssignment', () => {
  it('defaults to the single-shard deployment', () => {
    expect(resolveShardAssignment()).toEqual({ index: 0, count: 1 })
    expect(resolveShardAssignment(0)).toEqual({ index: 0, count: 1 })
  })

  it('keeps an explicit membership', () => {
    expect(resolveShardAssignment(3, 8)).toEqual({ index: 3, count: 8 })
  })

  it('rejects an index outside the count', () => {
    expect(() => resolveShardAssignment(8, 8)).toThrow(TypeError)
    expect(() => resolveShardAssignment(-1, 8)).toThrow(TypeError)
    expect(() => resolveShardAssignment(1)).toThrow(TypeError)
    expect(() => resolveShardAssignment(0, 0)).toThrow(TypeError)
  })
})

describe('shardPodName', () => {
  it('follows the StatefulSet ordinal naming contract', () => {
    expect(shardPodName('nilm-agent', 0)).toBe('nilm-agent-0')
    expect(shardPodName('nilm-agent', 12)).toBe('nilm-agent-12')
  })

  it('rejects a blank prefix or negative ordinal', () => {
    expect(() => shardPodName('', 1)).toThrow(TypeError)
    expect(() => shardPodName('nilm-agent', -1)).toThrow(TypeError)
  })
})
