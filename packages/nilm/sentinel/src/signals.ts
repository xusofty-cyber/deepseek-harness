/**
 * Authorized signal collection for energy rules. The provider reuses the
 * tenant-scoped assets and timeseries services; it never widens scope.
 * @module @deepseek-ai/dsh-nilm-sentinel/signals
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CallContext, MeterPoint, SessionId, TenantId, TimeRangeSpec } from '@deepseek-ai/dsh-nilm-core'
import type { ApplianceStatePoint } from '@deepseek-ai/dsh-nilm-timeseries'
import type {} from '@deepseek-ai/dsh-nilm-assets'
import type {} from '@deepseek-ai/dsh-nilm-timeseries'
import type { AlertRuleRow } from './store.ts'
import type { PhaseCurrents, PhaseVoltages } from './rules.ts'

/** One collected total-power snapshot. */
export interface PowerSignal {
  /** Sum of the latest authorized meter samples in kW. */
  powerKw: number
  /** Per-timestamp sum of authorized meters in kW, ascending. */
  samples: readonly { tsMs: number; powerKw: number }[]
  /** Authorized meters that contributed a finite sample. */
  meterCount: number
  /** Meter samples older than this instant are ignored. */
  latestSampleAtMs: number
}

/** One appliance-state observation. */
export interface ApplianceSignal {
  /** Stable display name derived from the upstream category number. */
  name: string
  /** Whether the latest sample reports the appliance running. */
  running: boolean
  /** Latest power in kW. */
  powerKw: number
  /** Start of the current running interval. */
  stateSinceMs: number
}

/** Signal collection seam replaced in tests. */
export interface RuleSignalProvider {
  /**
   * @param tenantId - tenant boundary.
   * @param rule - rule whose scope selects the meters.
   * @param atMs - evaluation instant.
   * @returns the latest total power, or `undefined` when no authorized meter reported.
   */
  totalPower(tenantId: string, rule: AlertRuleRow, atMs: number): Promise<PowerSignal | undefined>
  /**
   * @param tenantId - tenant boundary.
   * @param rule - rule whose scope selects the meters.
   * @param atMs - evaluation instant.
   * @param idlePowerKw - idle threshold used to derive the running interval.
   * @returns appliance observations under the rule scope.
   */
  appliances(tenantId: string, rule: AlertRuleRow, atMs: number, idlePowerKw: number): Promise<ApplianceSignal[]>
  /**
   * @param tenantId - tenant boundary.
   * @param rule - rule whose scope selects the meters.
   * @param atMs - evaluation instant.
   * @returns phase voltages when the upstream exposes an RMS voltage.
   */
  voltages(tenantId: string, rule: AlertRuleRow, atMs: number): Promise<{ voltages: PhaseVoltages; nominalVoltageV: number } | undefined>
  /**
   * @param tenantId - tenant boundary.
   * @param rule - rule whose scope selects the meters.
   * @param atMs - evaluation instant.
   * @returns phase currents when the upstream exposes three phases.
   */
  currents(tenantId: string, rule: AlertRuleRow, atMs: number): Promise<PhaseCurrents | undefined>
}

/** Default provider backed by the project's authorized assets and timeseries services. */
export class SourceRuleSignalProvider implements RuleSignalProvider {
  private readonly meterCache = new Map<string, { expiresAtMs: number; meters: readonly MeterPoint[] }>()

  /**
   * @param ctx - owning context; `nilmAssets` and `nilmTimeseries` must be mounted.
   * @param nominalVoltageV - fallback nominal phase voltage when a rule omits one.
   * @param cacheTtlMs - topology cache lifetime.
   */
  constructor(
    private readonly ctx: () => Context,
    private readonly nominalVoltageV: number = 220,
    private readonly cacheTtlMs: number = 300_000,
  ) {}

  /** @param tenantId - tenant boundary. @param rule - rule scope. @param atMs - evaluation instant. @returns latest total power. */
  async totalPower(tenantId: string, rule: AlertRuleRow, atMs: number): Promise<PowerSignal | undefined> {
    const result = await this.realtime(tenantId, rule, atMs, ['power'])
    const latest = latestByMeter(result.points)
    if (latest.length === 0) return undefined
    const byInstant = new Map<number, number>()
    for (const point of result.points) {
      if (!Number.isFinite(point.value)) continue
      byInstant.set(point.tsMs, (byInstant.get(point.tsMs) ?? 0) + point.value)
    }
    const samples = [...byInstant.entries()]
      .map(([tsMs, powerKw]) => ({ tsMs, powerKw }))
      .sort((left, right) => left.tsMs - right.tsMs)
    if (samples.length === 0) return undefined
    return {
      powerKw: latest.reduce((sum, point) => sum + point.value, 0),
      samples,
      meterCount: latest.length,
      latestSampleAtMs: Math.max(...latest.map(point => point.tsMs)),
    }
  }

  /** @param tenantId - tenant boundary. @param rule - rule scope. @param atMs - evaluation instant. @param idlePowerKw - idle threshold. @returns appliance observations. */
  async appliances(
    tenantId: string,
    rule: AlertRuleRow,
    atMs: number,
    idlePowerKw: number,
  ): Promise<ApplianceSignal[]> {
    const context = callContext(tenantId)
    const meters = await this.meters(tenantId, rule, atMs)
    if (meters.length === 0) return []
    const range = timeRange(atMs - 60 * 60_000, atMs, 'minute')
    const result = await this.ctx().get('nilmTimeseries')!.queryApplianceStates(context, meters, range)
    const groups = new Map<string, ApplianceStatePoint[]>()
    for (const point of result.points) {
      const key = `${point.terminalId}:${String(point.applianceNum)}`
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [point])
      else list.push(point)
    }
    const observations: ApplianceSignal[] = []
    for (const points of groups.values()) {
      points.sort((left, right) => left.tsMs - right.tsMs)
      const last = points[points.length - 1]
      if (last === undefined || last.powerKw === null) continue
      const stateSinceMs = runningSince(points, idlePowerKw)
      observations.push({
        name: `品类${String(last.applianceNum)}`,
        running: last.running,
        powerKw: last.powerKw,
        stateSinceMs,
      })
    }
    return observations
  }

  /** @param tenantId - tenant boundary. @param rule - rule scope. @param atMs - evaluation instant. @returns phase voltages from the RMS voltage metric. */
  async voltages(
    tenantId: string,
    rule: AlertRuleRow,
    atMs: number,
  ): Promise<{ voltages: PhaseVoltages; nominalVoltageV: number } | undefined> {
    const result = await this.realtime(tenantId, rule, atMs, ['urms'])
    const latest = latestByMeter(result.points)
    if (latest.length === 0) return undefined
    const voltage = latest.reduce((sum, point) => sum + point.value, 0) / latest.length
    const nominalVoltageV = nominalFromRule(rule, this.nominalVoltageV)
    return { voltages: { a: voltage, b: voltage, c: voltage }, nominalVoltageV }
  }

  /** @param tenantId - tenant boundary. @param rule - rule scope. @param atMs - evaluation instant. @returns no currents because upstream has no phase split. */
  async currents(_tenantId: string, _rule: AlertRuleRow, _atMs: number): Promise<PhaseCurrents | undefined> {
    // The confirmed realtime projection exposes one `irms` value per meter and no phase column.
    return undefined
  }

  private async realtime(tenantId: string, rule: AlertRuleRow, atMs: number, metrics: readonly string[]): Promise<{ points: Array<{ tsMs: number; value: number; meter: string }> }> {
    const context = callContext(tenantId)
    const meters = await this.meters(tenantId, rule, atMs)
    if (meters.length === 0) return { points: [] }
    const range = timeRange(atMs - 5 * 60_000, atMs, 'second')
    const result = await this.ctx().get('nilmTimeseries')!.queryRealtimePoints(context, meters, range, metrics)
    return {
      points: result.points.map(point => ({
        tsMs: point.tsMs,
        value: point.value,
        meter: `${point.deviceId}:${String(point.channelId ?? '')}`,
      })),
    }
  }

  private async meters(tenantId: string, rule: AlertRuleRow, atMs: number): Promise<readonly MeterPoint[]> {
    const key = `${tenantId}\n${rule.scope.level}\n${rule.scope.id}`
    const cached = this.meterCache.get(key)
    if (cached !== undefined && cached.expiresAtMs > atMs) return cached.meters
    const meters = await this.ctx().get('nilmAssets')!.resolveMeterSet(callContext(tenantId), {
      level: rule.scope.level,
      id: rule.scope.id,
    }, undefined, atMs)
    this.meterCache.set(key, { expiresAtMs: atMs + this.cacheTtlMs, meters })
    return meters
  }
}

/**
 * Build a system-owned caller context for authorized tenant-wide reads.
 * @param tenantId - tenant boundary.
 * @returns a synthetic context that never impersonates a customer user.
 */
function callContext(tenantId: string): CallContext {
  return {
    tenantId: brandString<TenantId>(tenantId),
    userRef: 'system:sentinel',
    requestId: `sentinel:${tenantId}`,
    sessionId: brandString<SessionId>(`sentinel:${tenantId}`),
  }
}

/**
 * Build a business-time range.
 * @param startMs - inclusive start.
 * @param endMs - exclusive end.
 * @param granularity - query granularity.
 * @returns the range.
 */
function timeRange(startMs: number, endMs: number, granularity: TimeRangeSpec['granularity']): TimeRangeSpec {
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), timeZone: 'Asia/Shanghai', granularity }
}

/**
 * Keep the newest finite sample per meter.
 * @param points - realtime points in ascending order.
 * @returns one latest point per meter.
 */
function latestByMeter(points: readonly { tsMs: number; value: number; meter: string }[]): Array<{ tsMs: number; value: number; meter: string }> {
  const latest = new Map<string, { tsMs: number; value: number; meter: string }>()
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue
    const current = latest.get(point.meter)
    if (current === undefined || point.tsMs >= current.tsMs) latest.set(point.meter, point)
  }
  return [...latest.values()]
}

/**
 * Derive the start of the current running interval from appliance samples.
 * @param points - chronological samples for one appliance.
 * @param idlePowerKw - idle threshold.
 * @returns the first instant of the contiguous latest run, or the latest sample instant.
 */
function runningSince(points: readonly ApplianceStatePoint[], idlePowerKw: number): number {
  const last = points[points.length - 1]
  if (last === undefined) return Date.now()
  if (!last.running) return last.tsMs
  let start = last.tsMs
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const point = points[index]!
    if (!point.running || point.powerKw === null || point.powerKw >= idlePowerKw) break
    start = point.tsMs
  }
  return start
}

/**
 * Read the optional nominal voltage from an R-05 threshold payload.
 * @param rule - rule row.
 * @param fallback - deployment default.
 * @returns nominal phase voltage.
 */
function nominalFromRule(rule: AlertRuleRow, fallback: number): number {
  const value = (rule.thresholds as { nominalVoltageV?: unknown }).nominalVoltageV
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
