/**
 * Default scheduled-report data collection over the authorized NILM services.
 * Every read is tenant-scoped; the scheduler never accepts a tenant id from a
 * model or caller request.
 * @module @deepseek-ai/dsh-nilm-scheduler/data-source
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import type { NilmAssetsService } from '@deepseek-ai/dsh-nilm-assets'
import {
  NilmError,
  type CallContext,
  type ChannelId,
  type EnergyBucket,
  type MeterPoint,
  type NilmDataQuality,
  type SessionId,
  type TerminalId,
  type TenantId,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'
import type { NilmTariffService, TariffSlice } from '@deepseek-ai/dsh-nilm-tariff'
import type { NilmTimeseriesService } from '@deepseek-ai/dsh-nilm-timeseries'
import type { DailyEnergy } from './pf.ts'
import type { DataQualityObservation } from './quality.ts'
import type { WorkshopEnergy } from './report.ts'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** Morning-report facts collected from the authorized data services. */
export interface MorningData {
  /** Hourly energy buckets for the completed day. */
  buckets: EnergyBucket[]
  /** Coverage and provenance of the total energy query. */
  dataQuality: Pick<NilmDataQuality, 'coverage' | 'source'>
  /** Effective tariff and priced totals when available. */
  tariff?: { planId: string; cost: CostBreakdown }
  /** Workshop totals. */
  workshops: WorkshopEnergy[]
  /** Deterministic collection caveats. */
  warnings: string[]
}

/** Monthly power-factor facts collected from a configured preaggregation. */
export interface MonthlyData {
  /** Completed daily active and reactive energy rows. */
  days: DailyEnergy[]
  /** Deterministic collection caveats. */
  warnings: string[]
}

/** R-08 observations and collection caveats. */
export interface QualityData {
  /** Observations for every terminal with both parent and child meters. */
  observations: DataQualityObservation[]
  /** Deterministic collection caveats. */
  warnings: string[]
}

/** Data-collection seam used by the scheduler and by tests. */
export interface SchedulerDataSource {
  /**
   * @param tenantId - tenant boundary.
   * @param dayStartMs - inclusive completed-day start.
   * @param dayEndMs - exclusive completed-day end.
   * @returns morning-report facts.
   */
  collectMorning(tenantId: string, dayStartMs: number, dayEndMs: number): Promise<MorningData>
  /**
   * @param tenantId - tenant boundary.
   * @param monthStartMs - inclusive month start.
   * @param asOfDate - last completed business date.
   * @param asOfEndMs - exclusive end of the as-of date.
   * @returns monthly energy facts.
   */
  collectMonthly(tenantId: string, monthStartMs: number, asOfDate: string, asOfEndMs: number): Promise<MonthlyData>
  /**
   * @param tenantId - tenant boundary.
   * @param dayStartMs - inclusive completed-day start.
   * @param dayEndMs - exclusive completed-day end.
   * @returns R-08 observations.
   */
  collectQuality(tenantId: string, dayStartMs: number, dayEndMs: number): Promise<QualityData>
}

/** Upstream monthly active/reactive preaggregation seam. */
export interface MonthlyEnergySource {
  /**
   * @param tenantId - tenant boundary.
   * @param startMs - inclusive month start.
   * @param endMs - exclusive end of completed days.
   * @returns completed daily active and reactive energy.
   */
  listDaily(tenantId: string, startMs: number, endMs: number): Promise<DailyEnergy[]>
}

/** Explicit failure when no monthly preaggregation is configured. */
export class UnavailableMonthlyEnergySource implements MonthlyEnergySource {
  /** @param tenantId - tenant boundary. @param startMs - month start. @param endMs - completed-day end. @throws NilmError with `DATA_UNAVAILABLE`. */
  async listDaily(tenantId: string, startMs: number, endMs: number): Promise<DailyEnergy[]> {
    throw new NilmError(
      'DATA_UNAVAILABLE',
      `tenant ${tenantId} has no monthly active/reactive preaggregation for ${businessIso(startMs)}..${businessIso(endMs)}`,
    )
  }
}

/** Narrow services required by the default collector. */
export interface SchedulerDataSourceDependencies {
  /** Guarded project-database reader. */
  source: Pick<NilmSourceService, 'queryLocalReadOnly'>
  /** Authorized topology resolver. */
  assets: Pick<NilmAssetsService, 'resolveMeterSet' | 'getWorkshopChannels'>
  /** Authorized energy router. */
  timeseries: Pick<NilmTimeseriesService, 'queryAggregatedEnergy'>
  /** Effective tariff reader. */
  tariff: Pick<NilmTariffService, 'effectivePlan' | 'splitByTariff'>
  /** Energy-cost calculator. */
  analytics: {
    calculateEnergyCosts(
      buckets: readonly EnergyBucket[],
      slices: readonly TariffSlice[],
      plan: { planId: string },
    ): CostBreakdown
  }
  /** Monthly active/reactive preaggregation. */
  monthlyEnergy?: MonthlyEnergySource
}

/** Default collector backed by the NILM services. */
export class SourceSchedulerDataSource implements SchedulerDataSource {
  private readonly monthlyEnergy: MonthlyEnergySource

  /**
   * @param dependencies - authorized services and optional monthly preaggregation.
   */
  constructor(private readonly dependencies: SchedulerDataSourceDependencies) {
    this.monthlyEnergy = dependencies.monthlyEnergy ?? new UnavailableMonthlyEnergySource()
  }

  /** @param tenantId - tenant boundary. @param dayStartMs - inclusive start. @param dayEndMs - exclusive end. @returns morning facts. */
  async collectMorning(tenantId: string, dayStartMs: number, dayEndMs: number): Promise<MorningData> {
    const caller = systemCaller(tenantId, `morning:${businessIso(dayStartMs)}`)
    const warnings: string[] = []
    const range = hourRange(dayStartMs, dayEndMs)
    const buckets: EnergyBucket[] = []
    let dataQuality: Pick<NilmDataQuality, 'coverage' | 'source'> = { coverage: 0, source: 'raw' }
    let meters: MeterPoint[] = []
    try {
      meters = await this.dependencies.assets.resolveMeterSet(caller, { level: 'factory' })
    } catch (error) {
      if (!isRecoverable(error)) throw error
      warnings.push(`factory meter set is unavailable: ${errorText(error)}`)
    }
    if (meters.length > 0) {
      const energy = await this.dependencies.timeseries.queryAggregatedEnergy(caller, meters, range, 'hour')
      buckets.push(...energy.buckets)
      dataQuality = { coverage: energy.dataQuality.coverage, source: energy.dataQuality.source }
      warnings.push(...energy.warnings)
    } else {
      warnings.push('no authorized factory meter is available for the morning report')
    }

    let tariff: MorningData['tariff']
    try {
      const plan = await this.dependencies.tariff.effectivePlan(caller, dayStartMs)
      const segmentation = await this.dependencies.tariff.splitByTariff(caller, range, plan.planId)
      const cost = this.dependencies.analytics.calculateEnergyCosts(buckets, segmentation.slices, plan)
      tariff = { planId: plan.planId, cost }
      warnings.push(...cost.warnings)
      warnings.push(...segmentation.warnings)
    } catch (error) {
      if (!isRecoverable(error)) throw error
      warnings.push(`tariff plan is unavailable: ${errorText(error)}`)
    }

    const workshops = await this.collectWorkshops(caller, range, warnings)
    return { buckets, dataQuality, ...(tariff === undefined ? {} : { tariff }), workshops, warnings }
  }

  /** @param tenantId - tenant boundary. @param monthStartMs - inclusive month start. @param asOfDate - last completed date. @param asOfEndMs - exclusive end. @returns monthly facts. */
  async collectMonthly(tenantId: string, monthStartMs: number, asOfDate: string, asOfEndMs: number): Promise<MonthlyData> {
    const days = await this.monthlyEnergy.listDaily(tenantId, monthStartMs, asOfEndMs)
    const warnings: string[] = []
    if (days.length === 0) warnings.push(`no completed daily energy is available for ${asOfDate}`)
    return { days, warnings }
  }

  /** @param tenantId - tenant boundary. @param dayStartMs - inclusive start. @param dayEndMs - exclusive end. @returns R-08 observations. */
  async collectQuality(tenantId: string, dayStartMs: number, dayEndMs: number): Promise<QualityData> {
    const caller = systemCaller(tenantId, `quality:${businessIso(dayStartMs)}`)
    const range = hourRange(dayStartMs, dayEndMs)
    const bindings = await this.dependencies.source.queryLocalReadOnly<{
      terminalId: string
      channelId: string
      role: MeterPoint['role']
      parentChannelId: string | null
    }>(
      `SELECT terminal_id AS terminalId, channel_id AS channelId, role, parent_channel_id AS parentChannelId
         FROM nilm_measurement_binding
        WHERE tenant_id = ? AND effective_from < ?
          AND (effective_to IS NULL OR ? <= effective_to)
        ORDER BY terminal_id, channel_id`,
      [tenantId, new Date(dayEndMs), new Date(dayEndMs)],
    )
    const byTerminal = new Map<string, MeterPoint[]>()
    for (const binding of bindings) {
      const meters = byTerminal.get(binding.terminalId) ?? []
      meters.push({
        terminalId: brandString<TerminalId>(binding.terminalId),
        channelId: brandString<ChannelId>(binding.channelId),
        role: binding.role,
        ...(binding.parentChannelId === null ? {} : { parentChannelId: brandString<ChannelId>(binding.parentChannelId) }),
      })
      byTerminal.set(binding.terminalId, meters)
    }
    const observations: DataQualityObservation[] = []
    const warnings: string[] = []
    for (const [terminalId, meters] of byTerminal) {
      const total = meters.find(meter => meter.role === 'terminal_total')
      const branches = meters.filter(meter => meter.role === 'branch')
      if (total === undefined || branches.length === 0) continue
      try {
        const totalEnergy = await this.dependencies.timeseries.queryAggregatedEnergy(caller, [total], range, 'hour')
        const branchEnergy = await Promise.all(branches.map(branch =>
          this.dependencies.timeseries.queryAggregatedEnergy(caller, [branch], range, 'hour')))
        observations.push({
          scopeId: terminalId,
          scopeName: terminalId,
          coverage: totalEnergy.dataQuality.coverage,
          parentEnergyKwh: sumBuckets(totalEnergy.buckets),
          childEnergyKwh: branchEnergy.reduce((totalKwh, result) => totalKwh + sumBuckets(result.buckets), 0),
        })
        warnings.push(...totalEnergy.warnings)
      } catch (error) {
        if (!isRecoverable(error)) throw error
        warnings.push(`terminal ${terminalId} quality query failed: ${errorText(error)}`)
      }
    }
    warnings.push('hot/cold consistency is not checked until a cold energy route is configured for R-08')
    return { observations, warnings }
  }

  /**
   * Collect workshop energy without duplicating total and branch meters.
   * @param caller - scheduler-owned tenant context.
   * @param range - completed-day range.
   * @param warnings - shared warning sink.
   * @returns ranked workshop totals.
   */
  private async collectWorkshops(
    caller: CallContext,
    range: TimeRangeSpec,
    warnings: string[],
  ): Promise<WorkshopEnergy[]> {
    const rows = await this.dependencies.source.queryLocalReadOnly<{ nodeId: string; nodeName: string }>(
      `SELECT node_id AS nodeId, node_name AS nodeName
         FROM nilm_asset_snapshot
        WHERE tenant_id = ? AND level = ? AND is_active = 1
        ORDER BY node_id`,
      [caller.tenantId, 'workshop'],
    )
    const workshops: WorkshopEnergy[] = []
    for (const workshop of rows) {
      try {
        const meters = await this.dependencies.assets.getWorkshopChannels(caller, workshop.nodeId)
        if (meters.length === 0) continue
        const energy = await this.dependencies.timeseries.queryAggregatedEnergy(caller, meters, range, 'hour')
        workshops.push({ name: workshop.nodeName, energyKwh: sumBuckets(energy.buckets) })
        warnings.push(...energy.warnings)
      } catch (error) {
        if (!isRecoverable(error)) throw error
        warnings.push(`workshop ${workshop.nodeId} energy query failed: ${errorText(error)}`)
      }
    }
    return workshops
  }
}

/**
 * Build the scheduler-owned caller context for one tenant.
 * @param tenantId - tenant boundary.
 * @param requestId - stable workload identifier.
 * @returns immutable call context.
 */
function systemCaller(tenantId: string, requestId: string): CallContext {
  return {
    tenantId: brandString<TenantId>(tenantId),
    userRef: 'system:scheduler',
    requestId,
    sessionId: brandString<SessionId>(requestId),
  }
}

/**
 * @param startMs - inclusive start.
 * @param endMs - exclusive end.
 * @returns hourly business-time range.
 */
function hourRange(startMs: number, endMs: number): TimeRangeSpec {
  return {
    start: businessIso(startMs),
    end: businessIso(endMs),
    timeZone: 'Asia/Shanghai',
    granularity: 'hour',
  }
}

/**
 * @param atMs - instant.
 * @returns ISO text with the Shanghai offset.
 */
function businessIso(atMs: number): string {
  return new Date(atMs + SHANGHAI_OFFSET_MS).toISOString().replace('.000Z', '+08:00')
}

/**
 * @param buckets - energy buckets.
 * @returns total energy.
 */
function sumBuckets(buckets: readonly EnergyBucket[]): number {
  return buckets.reduce((total, bucket) => total + bucket.energyKwh, 0)
}

/**
 * Decide whether a failure is a recoverable data gap for one tenant report.
 * @param error - thrown failure.
 * @returns true for stable data or scope gaps.
 */
function isRecoverable(error: unknown): error is NilmError {
  if (!(error instanceof NilmError)) return false
  return error.code === 'DATA_UNAVAILABLE'
    || error.code === 'DATA_PARTIAL'
    || error.code === 'SCOPE_NOT_FOUND'
    || error.code === 'COLD_LINK_UNAVAILABLE'
}

/**
 * @param error - thrown failure.
 * @returns bounded diagnostic text.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown failure'
}
