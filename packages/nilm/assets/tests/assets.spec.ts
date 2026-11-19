import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NilmError,
  type CallContext,
  type SessionId,
  type TenantId,
} from '@deepseek-ai/dsh-nilm-core'
import NilmAssetsService, {
  type AssetNode,
  type AssetRepository,
  type MeterBinding,
} from '../src/index.ts'

const contexts: Context[] = []

const assets: AssetNode[] = [
  { nodeId: 'f1', level: 'factory', nodeName: '工厂A', pathName: '工厂A', isActive: true },
  { nodeId: 'w1', parentId: 'f1', level: 'workshop', nodeName: '一号车间', pathName: '工厂A/一号车间', isActive: true },
  { nodeId: 't1', parentId: 'w1', level: 'terminal', nodeName: '终端1', pathName: '工厂A/一号车间/终端1', isActive: true },
  { nodeId: 't2', parentId: 'w1', level: 'terminal', nodeName: '终端2', pathName: '工厂A/一号车间/终端2', isActive: true },
  { nodeId: 'c1', parentId: 't1', level: 'channel', nodeName: '总进线', pathName: '工厂A/一号车间/终端1/总进线', isActive: true, channelType: 'main' },
  { nodeId: 'c1b1', parentId: 't1', level: 'channel', nodeName: '分路1', pathName: '工厂A/一号车间/终端1/分路1', isActive: true, channelType: 'sub' },
  { nodeId: 'c1b2', parentId: 't1', level: 'channel', nodeName: '分路2', pathName: '工厂A/一号车间/终端1/分路2', isActive: true, channelType: 'sub' },
  { nodeId: 'c2', parentId: 't2', level: 'channel', nodeName: '总进线2', pathName: '工厂A/一号车间/终端2/总进线2', isActive: true, channelType: 'main' },
  { nodeId: 'c2b1', parentId: 't2', level: 'channel', nodeName: '分路3', pathName: '工厂A/一号车间/终端2/分路3', isActive: true, channelType: 'sub' },
  { nodeId: 'a1', parentId: 'c1', level: 'appliance', nodeName: '空压机', pathName: '工厂A/一号车间/终端1/总进线/空压机', isActive: true },
]

const bindings: MeterBinding[] = [
  { terminalId: 't1', channelId: 'c1', role: 'terminal_total' },
  { terminalId: 't1', channelId: 'c1b1', role: 'branch' },
  { terminalId: 't1', channelId: 'c1b2', role: 'branch' },
  { terminalId: 't2', channelId: 'c2', role: 'terminal_total' },
  { terminalId: 't2', channelId: 'c2b1', role: 'branch' },
]

function setup(repository?: AssetRepository): NilmAssetsService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NilmAssetsService(ctx, {
    repository: repository ?? {
      listAssets: async () => assets,
      listBindings: async () => bindings,
    },
  })
}

function callContext(allowedScope?: CallContext['allowedScope']): CallContext {
  return {
    tenantId: brandString<TenantId>('tenant-a'),
    userRef: 'user-1',
    ...(allowedScope === undefined ? {} : { allowedScope }),
    requestId: 'request-1',
    sessionId: brandString<SessionId>('session-1'),
  }
}

function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  return action().then(
    () => undefined,
    (error: unknown) => error instanceof NilmError ? error.code : undefined,
  )
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('NilmAssetsService', () => {
  it('resolves a named workshop and selects non-overlapping total meters', async () => {
    const service = setup()
    const result = await service.resolveScope(callContext(), { level: 'workshop', name: ' 一号车间 ' })
    expect(result.ambiguous).toBe(false)
    expect(result.resolvedPath).toBe('工厂A/一号车间')
    expect(result.meterSet).toEqual([
      { terminalId: 't1', channelId: 'c1', role: 'terminal_total', pathName: '工厂A/一号车间/终端1/总进线' },
      { terminalId: 't2', channelId: 'c2', role: 'terminal_total', pathName: '工厂A/一号车间/终端2/总进线2' },
    ])
    expect(result.warnings).toContain('terminal t1 uses its total inlet; 2 branch channels were excluded')
  })

  it('reports duplicate names as ambiguous instead of picking one', async () => {
    const duplicate = [...assets, { ...assets[1]!, nodeId: 'w1b', pathName: '工厂A/一号车间B' }]
    const ctx = new Context()
    contexts.push(ctx)
    const serviceWithDuplicate = new NilmAssetsService(ctx, {
      repository: {
        listAssets: async () => duplicate,
        listBindings: async () => bindings,
      },
    })
    const result = await serviceWithDuplicate.resolveScope(callContext(), { level: 'workshop', name: '一号车间' })
    expect(result.ambiguous).toBe(true)
    expect(result.matched).toHaveLength(2)
    expect(result.warnings?.[0]).toContain('request clarification')
  })

  it('rejects a target outside the caller allowed scope', async () => {
    const service = setup()
    await expect(service.resolveScope(
      callContext([{ level: 'terminal', id: 't2' }]),
      { level: 'workshop', id: 'w1' },
    )).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' })
    expect(await codeOf(() => service.resolveScope(
      callContext([{ level: 'terminal', id: 't2' }]),
      { level: 'channel', id: 'missing' },
    ))).toBe('SCOPE_NOT_FOUND')
  })

  it('falls back to channel_type when no binding is effective', async () => {
    const service = setup({
      listAssets: async () => assets,
      listBindings: async () => [],
    })
    const result = await service.resolveScope(callContext(), { level: 'workshop', id: 'w1' })
    expect(result.meterSet.map(meter => meter.channelId)).toEqual(['c1', 'c2'])
    expect(result.warnings).toContain('no effective measurement bindings; channel_type projection was used')
  })

  it('selects only leaf branches when a terminal has no total inlet', async () => {
    const noTotal = assets.map(asset => asset.nodeId === 'c1' ? { ...asset, channelType: 'sub' as const } : asset)
    const service = setup({
      listAssets: async () => noTotal,
      listBindings: async () => [
        { terminalId: 't1', channelId: 'c1b2', role: 'branch' },
        { terminalId: 't1', channelId: 'c1b1', role: 'branch', parentChannelId: 'c1b2' },
      ],
    })
    const meters = await service.resolveMeterSet(callContext(), { level: 'terminal', id: 't1' })
    expect(meters).toEqual([
      { terminalId: 't1', channelId: 'c1', role: 'branch', pathName: '工厂A/一号车间/终端1/总进线' },
      { terminalId: 't1', channelId: 'c1b1', role: 'branch', pathName: '工厂A/一号车间/终端1/分路1', parentChannelId: 'c1b2' },
    ])
  })

  it('maps an appliance to its parent channel and marks it as an estimate', async () => {
    const service = setup()
    const result = await service.resolveScope(callContext(), { level: 'appliance', name: '空压机' })
    expect(result.meterSet).toEqual([
      { terminalId: 't1', channelId: 'c1', role: 'appliance' },
    ])
    expect(result.warnings).toContain('appliance energy is an estimate and is excluded from settlement aggregation')
  })

  it('rejects an appliance whose channel has no terminal ancestor', async () => {
    const malformed = [
      ...assets,
      { nodeId: 'c9', parentId: 'w1', level: 'channel' as const, nodeName: '无终端通道', pathName: '工厂A/一号车间/无终端通道', isActive: true, channelType: 'sub' as const },
      { nodeId: 'a9', parentId: 'c9', level: 'appliance' as const, nodeName: '孤立刻表', pathName: '工厂A/一号车间/无终端通道/孤立刻表', isActive: true },
    ]
    const ctx = new Context()
    contexts.push(ctx)
    const service = new NilmAssetsService(ctx, {
      repository: { listAssets: async () => malformed, listBindings: async () => bindings },
    })
    await expect(service.resolveScope(callContext(), { level: 'appliance', name: '孤立刻表' }))
      .rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' })
  })

  it('returns workshop channels and validates missing or ambiguous identifiers', async () => {
    const service = setup()
    expect(await service.getWorkshopChannels(callContext(), 'w1')).toHaveLength(2)
    await expect(service.resolveScope(callContext(), { level: 'workshop', id: 'missing' }))
      .rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })
    await expect(service.resolveScope(callContext(), { level: 'workshop' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects a missing allowed scope instead of widening access', async () => {
    const service = setup()
    await expect(service.resolveScope(
      callContext([{ level: 'workshop', id: 'missing' }]),
      { level: 'factory', id: 'f1' },
    )).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' })
  })

  it('rejects duplicate total inlets for one terminal', async () => {
    const service = setup({
      listAssets: async () => assets,
      listBindings: async () => [
        { terminalId: 't1', channelId: 'c1', role: 'terminal_total' },
        { terminalId: 't1', channelId: 'c1b1', role: 'terminal_total' },
      ],
    })
    await expect(service.resolveMeterSet(callContext(), { level: 'terminal', id: 't1' }))
      .rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' })
  })
})
