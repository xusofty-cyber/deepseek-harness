/**
 * Five-level NILM asset topology resolution and non-overlapping meter selection.
 * The service reads only the project-owned snapshot and binding tables and never
 * derives authorization from model input.
 * @module @deepseek-ai/dsh-nilm-assets
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NilmError,
  type CallContext,
  type ChannelId,
  type MeterPoint,
  type MeterRole,
  type ScopeLevel,
  type ScopeResolution,
  type ScopeTarget,
  type TerminalId,
} from '@deepseek-ai/dsh-nilm-core'
import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmAssets: NilmAssetsService
  }
}

/** One projected asset node from `nilm_asset_snapshot`. */
export interface AssetNode {
  /** Upstream node identifier. */
  nodeId: string
  /** Parent node identifier, absent for the factory root. */
  parentId?: string
  /** Topology level. */
  level: ScopeLevel
  /** Human-readable node name. */
  nodeName: string
  /** Full path used for matching and display. */
  pathName: string
  /** Whether the upstream projection still carries this node. */
  isActive: boolean
  /** Channel classification when the node is a channel. */
  channelType?: 'main' | 'sub'
  /** Appliance category for appliance nodes. */
  applianceCategoryId?: number
}

/** One effective measurement binding for the current instant. */
export interface MeterBinding {
  /** Owning terminal. */
  terminalId: string
  /** Channel identifier. */
  channelId: string
  /** Aggregation role. */
  role: MeterRole
  /** Parent branch channel when the topology is hierarchical. */
  parentChannelId?: string
}

/** Read seam for tests and alternate projections. */
export interface AssetRepository {
  /**
   * @param tenantId - tenant boundary.
   * @param signal - caller cancellation.
   * @returns active projected nodes for the tenant.
   */
  listAssets(tenantId: string, signal?: AbortSignal): Promise<AssetNode[]>
  /**
   * @param tenantId - tenant boundary.
   * @param atMs - instant whose effective bindings are required.
   * @param signal - caller cancellation.
   * @returns bindings effective at the instant.
   */
  listBindings(tenantId: string, atMs: number, signal?: AbortSignal): Promise<MeterBinding[]>
}

/** Optional dependency overrides. */
export interface NilmAssetsDependencies {
  /** Repository replacing the project-database adapter. */
  repository?: AssetRepository
}

interface ScoredNode {
  node: AssetNode
  score: number
}

const LEVEL_ORDER: readonly ScopeLevel[] = ['factory', 'workshop', 'terminal', 'channel', 'appliance']

/** Project-database repository backed by the guarded source adapter. */
export class SourceAssetRepository implements AssetRepository {
  /**
   * @param source - lazily resolved source service.
   */
  constructor(private readonly source: () => NilmSourceService) {}

  /**
   * @param tenantId - tenant boundary.
   * @param signal - caller cancellation.
   * @returns active projected nodes.
   */
  async listAssets(tenantId: string, signal?: AbortSignal): Promise<AssetNode[]> {
    const rows = await this.source().queryLocalReadOnly<{
      nodeId: string
      parentId: string | null
      level: ScopeLevel
      nodeName: string
      pathName: string
      isActive: number
      channelType: 'main' | 'sub' | null
      applianceCategoryId: number | null
    }>(
      `SELECT node_id AS nodeId, parent_id AS parentId, level, node_name AS nodeName,
              path_name AS pathName, is_active AS isActive, channel_type AS channelType,
              appliance_category_id AS applianceCategoryId
         FROM nilm_asset_snapshot
        WHERE tenant_id = ? AND is_active = 1
        ORDER BY level, node_id`,
      [tenantId],
      signal,
    )
    return rows.map(row => ({
      nodeId: row.nodeId,
      ...(row.parentId === null ? {} : { parentId: row.parentId }),
      level: row.level,
      nodeName: row.nodeName,
      pathName: row.pathName,
      isActive: row.isActive === 1,
      ...(row.channelType === null ? {} : { channelType: row.channelType }),
      ...(row.applianceCategoryId === null ? {} : { applianceCategoryId: row.applianceCategoryId }),
    }))
  }

  /**
   * @param tenantId - tenant boundary.
   * @param atMs - binding instant in epoch milliseconds.
   * @param signal - caller cancellation.
   * @returns effective bindings.
   */
  async listBindings(tenantId: string, atMs: number, signal?: AbortSignal): Promise<MeterBinding[]> {
    const instant = new Date(atMs)
    const rows = await this.source().queryLocalReadOnly<{
      terminalId: string
      channelId: string
      role: MeterRole
      parentChannelId: string | null
    }>(
      `SELECT terminal_id AS terminalId, channel_id AS channelId, role,
              parent_channel_id AS parentChannelId
         FROM nilm_measurement_binding
        WHERE tenant_id = ? AND effective_from <= ?
          AND (effective_to IS NULL OR ? < effective_to)
        ORDER BY terminal_id, channel_id`,
      [tenantId, instant, instant],
      signal,
    )
    return rows.map(row => ({
      terminalId: row.terminalId,
      channelId: row.channelId,
      role: row.role,
      ...(row.parentChannelId === null ? {} : { parentChannelId: row.parentChannelId }),
    }))
  }
}

/** Tenant-scoped topology resolver and non-overlapping meter-set selector. */
export class NilmAssetsService extends Service {
  private readonly repository: AssetRepository

  /**
   * @param ctx - owning plugin context.
   * @param dependencies - repository override for tests or alternate projections.
   */
  constructor(ctx: Context, dependencies: NilmAssetsDependencies = {}) {
    super(ctx, 'nilmAssets')
    this.repository = dependencies.repository ?? new SourceAssetRepository(() => ctx.get('nilmSource')!)
  }

  /**
   * Resolve one caller target inside the tenant and its allowed scope.
   * @param callContext - verified caller identity.
   * @param query - requested level, identifier, path, or name.
   * @param signal - optional caller cancellation.
   * @returns matched nodes, ambiguity, warnings, and the non-overlapping meter set.
   */
  async resolveScope(
    callContext: CallContext,
    query: ScopeTarget,
    signal?: AbortSignal,
  ): Promise<ScopeResolution> {
    const assets = await this.repository.listAssets(callContext.tenantId, signal)
    const allMatches = rankMatches(assets, query)
    if (allMatches.length === 0) {
      throw new NilmError('SCOPE_NOT_FOUND', `no ${query.level} matches ${describe(query)}`)
    }
    const allowed = allowedNodes(assets, callContext)
    const ranked = rankMatches(allowed, query)
    if (ranked.length === 0) {
      throw new NilmError('SCOPE_FORBIDDEN', `${query.level} ${describe(query)} is outside the caller allowed scope`)
    }
    const best = ranked[0]!.score
    const matches = ranked.filter(entry => entry.score === best).map(entry => entry.node)
    const ambiguous = matches.length > 1
    const resolution: ScopeResolution = {
      matched: matches.map(toTarget),
      ambiguous,
      meterSet: [],
    }
    if (ambiguous) {
      resolution.warnings = [`multiple authorized nodes match ${describe(query)}; request clarification`]
      return resolution
    }
    const selected = matches[0]!
    resolution.resolvedPath = selected.pathName
    const meters = await this.meterSetFor(callContext, assets, selected, signal)
    resolution.meterSet = meters.meterSet
    resolution.warnings = meters.warnings
    return resolution
  }

  /**
   * Resolve every channel below a workshop without duplicating a total and its branches.
   * @param callContext - verified caller identity.
   * @param workshopId - workshop identifier.
   * @param signal - optional caller cancellation.
   * @returns non-overlapping meter points.
   */
  async getWorkshopChannels(
    callContext: CallContext,
    workshopId: string,
    signal?: AbortSignal,
  ): Promise<MeterPoint[]> {
    const resolution = await this.resolveScope(
      callContext,
      { level: 'workshop', id: workshopId },
      signal,
    )
    if (resolution.ambiguous) {
      throw new NilmError('AMBIGUOUS_SCOPE', `workshop ${workshopId} is ambiguous`)
    }
    return resolution.meterSet
  }

  /**
   * Resolve exactly one authorized scope and return its non-overlapping meters.
   * @param callContext - verified caller identity.
   * @param scope - requested scope.
   * @param signal - optional caller cancellation.
   * @returns non-overlapping meter points.
   */
  async resolveMeterSet(
    callContext: CallContext,
    scope: ScopeTarget,
    signal?: AbortSignal,
  ): Promise<MeterPoint[]> {
    const resolution = await this.resolveScope(callContext, scope, signal)
    if (resolution.ambiguous) throw new NilmError('AMBIGUOUS_SCOPE', `scope ${describe(scope)} is ambiguous`)
    return resolution.meterSet
  }

  private async meterSetFor(
    callContext: CallContext,
    assets: readonly AssetNode[],
    selected: AssetNode,
    signal?: AbortSignal,
  ): Promise<{ meterSet: MeterPoint[]; warnings: string[] }> {
    if (selected.level === 'appliance') {
      const parent = parentNode(assets, selected)
      if (parent?.level !== 'channel') {
        throw new NilmError('DATA_UNAVAILABLE', `appliance ${selected.nodeId} has no parent channel`)
      }
      return {
        meterSet: [{
          terminalId: terminalFor(assets, parent) as TerminalId,
          channelId: parent.nodeId as ChannelId,
          role: 'appliance',
        }],
        warnings: ['appliance energy is an estimate and is excluded from settlement aggregation'],
      }
    }
    const channels = channelNodes(assets, selected)
    if (channels.length === 0) {
      return { meterSet: [], warnings: [`${selected.pathName} has no projected channels`] }
    }

    const bindings = await this.repository.listBindings(callContext.tenantId, Date.now(), signal)
    const byChannel = new Map(bindings.map(binding => [binding.channelId, binding]))
    const warnings: string[] = []
    const candidates: Array<{ channel: AssetNode; terminalId: string; role: MeterRole; parentChannelId?: string }> = []
    for (const channel of channels) {
      const terminal = terminalFor(assets, channel)
      if (terminal === undefined) {
        warnings.push(`channel ${channel.nodeId} has no terminal ancestor and was excluded`)
        continue
      }
      const binding = byChannel.get(channel.nodeId)
      const role = binding?.role ?? (channel.channelType === 'main' ? 'terminal_total' : 'branch')
      if (role === 'reference') continue
      const resolvedParentChannelId = binding?.parentChannelId ?? parentChannel(assets, channel)?.nodeId
      candidates.push({
        channel,
        terminalId: terminal,
        role,
        ...(resolvedParentChannelId === undefined ? {} : { parentChannelId: resolvedParentChannelId }),
      })
    }
    if (bindings.length === 0) warnings.push('no effective measurement bindings; channel_type projection was used')

    const byTerminal = new Map<string, typeof candidates>()
    for (const candidate of candidates) {
      const group = byTerminal.get(candidate.terminalId) ?? []
      group.push(candidate)
      byTerminal.set(candidate.terminalId, group)
    }
    const meterSet: MeterPoint[] = []
    for (const terminalId of [...byTerminal.keys()].sort()) {
      const group = byTerminal.get(terminalId)!
      const totals = group.filter(entry => entry.role === 'terminal_total')
      if (totals.length > 1) {
        throw new NilmError('DATA_UNAVAILABLE', `terminal ${terminalId} has multiple total-inlet channels`)
      }
      if (totals.length === 1) {
        const total = totals[0]!
        meterSet.push({
          terminalId: terminalId as TerminalId,
          channelId: total.channel.nodeId as ChannelId,
          role: 'terminal_total',
          pathName: total.channel.pathName,
        })
        if (group.length > 1) {
          warnings.push(`terminal ${terminalId} uses its total inlet; ${String(group.length - 1)} branch channels were excluded`)
        }
        continue
      }
      const branches = group.filter(entry => entry.role === 'branch')
      const parents = new Set(branches.flatMap(entry => entry.parentChannelId === undefined ? [] : [entry.parentChannelId]))
      const leaves = branches.filter(entry => !parents.has(entry.channel.nodeId))
      for (const leaf of leaves.sort((left, right) => left.channel.nodeId.localeCompare(right.channel.nodeId))) {
        meterSet.push({
          terminalId: terminalId as TerminalId,
          channelId: leaf.channel.nodeId as ChannelId,
          role: 'branch',
          pathName: leaf.channel.pathName,
          ...(leaf.parentChannelId === undefined ? {} : { parentChannelId: leaf.parentChannelId as ChannelId }),
        })
      }
    }
    if (meterSet.length === 0) warnings.push(`${selected.pathName} resolved no authorized metering channel`)
    return { meterSet, warnings }
  }
}

function allowedNodes(assets: readonly AssetNode[], callContext: CallContext): readonly AssetNode[] {
  if (callContext.allowedScope === undefined) return assets
  if (callContext.allowedScope.length === 0) return []
  const allowedRoots = new Set<string>()
  for (const target of callContext.allowedScope) {
    const matches = rankMatches(assets, target)
    const best = matches[0]?.score
    if (best === undefined) {
      throw new NilmError('SCOPE_FORBIDDEN', `allowed scope ${describe(target)} is not present in the projection`)
    }
    for (const match of matches.filter(entry => entry.score === best)) {
      allowedRoots.add(match.node.nodeId)
      for (const descendant of descendants(assets, match.node)) allowedRoots.add(descendant.nodeId)
    }
  }
  return assets.filter(asset => allowedRoots.has(asset.nodeId))
}

function rankMatches(assets: readonly AssetNode[], query: ScopeTarget): ScoredNode[] {
  const wantedLevel = query.level
  const id = query.id === undefined ? undefined : normalizeKey(query.id)
  const path = query.path === undefined ? undefined : normalizePath(query.path)
  const name = query.name === undefined ? undefined : normalizeKey(query.name)
  if (id === undefined && path === undefined && name === undefined) {
    throw new NilmError('INVALID_ARGUMENT', 'scope requires an id, path, or name')
  }
  const ranked: ScoredNode[] = []
  for (const node of assets) {
    if (node.level !== wantedLevel) continue
    let score = 0
    if (id !== undefined && normalizeKey(node.nodeId) === id) score = Math.max(score, 100)
    if (path !== undefined) {
      const candidatePath = normalizePath(node.pathName)
      if (candidatePath === path) score = Math.max(score, 90)
      else if (candidatePath.endsWith(`/${path}`)) score = Math.max(score, 60)
    }
    if (name !== undefined) {
      const candidateName = normalizeKey(node.nodeName)
      if (candidateName === name) score = Math.max(score, 80)
      else if (candidateName.includes(name) || name.includes(candidateName)) score = Math.max(score, 40)
    }
    if (score > 0) ranked.push({ node, score })
  }
  ranked.sort((left, right) => right.score - left.score
    || LEVEL_ORDER.indexOf(left.node.level) - LEVEL_ORDER.indexOf(right.node.level)
    || left.node.pathName.localeCompare(right.node.pathName)
    || left.node.nodeId.localeCompare(right.node.nodeId))
  return ranked
}

function descendants(assets: readonly AssetNode[], root: AssetNode): AssetNode[] {
  const children = new Map<string, AssetNode[]>()
  for (const asset of assets) {
    if (asset.parentId === undefined) continue
    const group = children.get(asset.parentId) ?? []
    group.push(asset)
    children.set(asset.parentId, group)
  }
  const out: AssetNode[] = []
  const queue = [...(children.get(root.nodeId) ?? [])]
  while (queue.length > 0) {
    const node = queue.shift()!
    out.push(node)
    queue.push(...(children.get(node.nodeId) ?? []))
  }
  return out
}

function channelNodes(assets: readonly AssetNode[], selected: AssetNode): AssetNode[] {
  if (selected.level === 'channel') return [selected]
  if (selected.level === 'appliance') return []
  return descendants(assets, selected).filter(node => node.level === 'channel')
}

function parentNode(assets: readonly AssetNode[], node: AssetNode): AssetNode | undefined {
  return node.parentId === undefined ? undefined : assets.find(asset => asset.nodeId === node.parentId)
}

function parentChannel(assets: readonly AssetNode[], node: AssetNode): AssetNode | undefined {
  let current = parentNode(assets, node)
  while (current !== undefined) {
    if (current.level === 'channel') return current
    current = parentNode(assets, current)
  }
  return undefined
}

function terminalFor(assets: readonly AssetNode[], node: AssetNode): string | undefined {
  let current: AssetNode | undefined = node
  while (current !== undefined) {
    if (current.level === 'terminal') return current.nodeId
    current = parentNode(assets, current)
  }
  return undefined
}

function toTarget(node: AssetNode): ScopeTarget {
  return { level: node.level, id: node.nodeId, name: node.nodeName, path: node.pathName }
}

function describe(query: ScopeTarget): string {
  return query.id ?? query.path ?? query.name ?? query.level
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePath(value: string): string {
  return normalizeKey(value).replace(/\s*[/>]\s*/g, '/').replace(/^\/+|\/+$/g, '')
}

export default NilmAssetsService
