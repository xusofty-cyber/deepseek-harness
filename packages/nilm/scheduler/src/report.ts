/**
 * Deterministic morning-report and power-factor payload builders. Numbers come
 * only from persisted or freshly calculated facts; a model may author the
 * summary text but never the structured payload.
 * @module @deepseek-ai/dsh-nilm-scheduler/report
 */

import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import type { ChartSpec, EnergyBucket, NilmDataQuality } from '@deepseek-ai/dsh-nilm-core'
import type { TariffPeriodType } from '@deepseek-ai/dsh-nilm-tariff'
import type { AlertCounts } from './model.ts'
import type { PowerFactorForecast, PowerFactorRisk } from './pf.ts'

const PERIODS: readonly TariffPeriodType[] = ['sharp', 'peak', 'flat', 'valley']

/** One workshop energy total used for ranking. */
export interface WorkshopEnergy {
  /** Workshop display name. */
  name: string
  /** Energy over the report day in kWh. */
  energyKwh: number
}

/** Power-factor facts carried into the morning report. */
export interface MorningPowerFactor {
  /** Projected month-end power factor. */
  projectedPowerFactor?: number
  /** Billing threshold. */
  threshold: number
  /** Projection risk. */
  risk: PowerFactorRisk
  /** Latest completed date used by the projection. */
  asOfDate: string
}

/** Inputs required to build the deterministic morning report. */
export interface MorningReportInput {
  /** Tenant boundary. */
  tenantId: string
  /** Tenant display name. */
  tenantName: string
  /** Completed business date described by the report. */
  reportDate: string
  /** Inclusive day start. */
  dayStartMs: number
  /** Exclusive day end. */
  dayEndMs: number
  /** Hourly energy buckets. */
  buckets: readonly EnergyBucket[]
  /** Coverage and provenance of the total energy query. */
  dataQuality: Pick<NilmDataQuality, 'coverage' | 'source'>
  /** Tariff plan id and priced totals when a plan was available. */
  tariff?: { planId: string; cost: CostBreakdown }
  /** Workshop totals. */
  workshops: readonly WorkshopEnergy[]
  /** Alert counts detected in the day. */
  alerts: AlertCounts
  /** Latest monthly power-factor projection, when available. */
  powerFactor?: MorningPowerFactor
  /** Deterministic caveats from data collection. */
  warnings: readonly string[]
}

/** Deterministic report content ready for persistence. */
export interface BuiltReport {
  /** Structured report payload. */
  payload: MorningReportPayload | PowerFactorReportPayload
  /** Optional chart protocol. */
  chart?: ChartSpec
  /** Fallback summary when no model summary is available. */
  summaryText: string
}

/** Structured morning-report payload. */
export interface MorningReportPayload {
  /** Payload discriminator. */
  kind: 'morning_report'
  /** Tenant boundary. */
  tenantId: string
  /** Tenant display name. */
  tenantName: string
  /** Business date. */
  reportDate: string
  /** Half-open day window. */
  window: { startMs: number; endMs: number }
  /** Total energy and coverage. */
  energy: { totalKwh: number; coverage: number; source: NilmDataQuality['source'] }
  /** Priced cost breakdown, or null when no effective plan exists. */
  cost: null | {
    planId: string
    totalCost: number
    precise: boolean
    unpricedEnergyKwh: number
    byPeriod: Record<TariffPeriodType, { energyKwh: number; cost: number; share: number }>
  }
  /** Peak/flat/valley/sharp shares even when no tariff was available. */
  periodShares: Record<TariffPeriodType, number | null>
  /** Highest-energy workshops. */
  workshopRanking: Array<{ name: string; energyKwh: number; share: number }>
  /** Alert counts for the day. */
  alerts: AlertCounts
  /** Power-factor forecast, or null when no projection exists. */
  powerFactor: MorningPowerFactor | null
  /** Deterministic caveats. */
  warnings: string[]
  /** Stated projection and costing assumptions. */
  assumptions: string[]
}

/** Structured power-factor report payload. */
export interface PowerFactorReportPayload {
  /** Payload discriminator. */
  kind: 'pf_forecast'
  /** Tenant boundary. */
  tenantId: string
  /** Tenant display name. */
  tenantName: string
  /** Report business date. */
  reportDate: string
  /** Complete deterministic projection. */
  forecast: PowerFactorForecast
  /** Required delivery on the 20th and 25th. */
  mandatory: true
  /** Deterministic caveats. */
  warnings: string[]
}

/**
 * Build the morning report payload, chart, and fallback summary.
 * @param input - deterministic day facts.
 * @returns report content ready for persistence.
 */
export function buildMorningReport(input: MorningReportInput): BuiltReport {
  const buckets = [...input.buckets].sort((left, right) => left.startMs - right.startMs)
  const totalKwh = sum(buckets.map(bucket => bucket.energyKwh))
  const periodShares = emptyPeriodShares()
  if (input.tariff !== undefined) {
    for (const period of PERIODS) {
      periodShares[period] = totalKwh === 0 ? 0 : input.tariff.cost.byPeriod[period].energyKwh / totalKwh
    }
  }
  const byPeriod = emptyPeriodRecord()
  if (input.tariff !== undefined) {
    for (const period of PERIODS) {
      byPeriod[period] = {
        energyKwh: input.tariff.cost.byPeriod[period].energyKwh,
        cost: input.tariff.cost.byPeriod[period].cost,
        share: periodShares[period] ?? 0,
      }
    }
  }
  const workshops = [...input.workshops]
    .filter(workshop => Number.isFinite(workshop.energyKwh) && workshop.energyKwh >= 0)
    .sort((left, right) => right.energyKwh - left.energyKwh || left.name.localeCompare(right.name))
    .slice(0, 5)
    .map(workshop => ({
      name: workshop.name,
      energyKwh: workshop.energyKwh,
      share: totalKwh === 0 ? 0 : workshop.energyKwh / totalKwh,
    }))
  const warnings = [...new Set(input.warnings)]
  const assumptions = [
    'energy totals come from the authorized timeseries route for the completed business day',
    'costs use the tenant tariff plan effective on the report date',
    'power-factor risk is the latest monthly projection and is not recalculated from this day alone',
  ]
  const payload: MorningReportPayload = {
    kind: 'morning_report',
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    reportDate: input.reportDate,
    window: { startMs: input.dayStartMs, endMs: input.dayEndMs },
    energy: {
      totalKwh,
      coverage: input.dataQuality.coverage,
      source: input.dataQuality.source,
    },
    cost: input.tariff === undefined ? null : {
      planId: input.tariff.planId,
      totalCost: input.tariff.cost.totalCost,
      precise: input.tariff.cost.precise,
      unpricedEnergyKwh: input.tariff.cost.unpricedEnergyKwh,
      byPeriod,
    },
    periodShares,
    workshopRanking: workshops,
    alerts: input.alerts,
    powerFactor: input.powerFactor ?? null,
    warnings,
    assumptions,
  }
  return {
    payload,
    chart: morningChart(input.tenantName, input.reportDate, buckets, input.dataQuality),
    summaryText: morningSummary(payload),
  }
}

/**
 * Build the monthly power-factor report payload and fallback summary.
 * @param input - tenant, report date, and deterministic forecast.
 * @returns report content ready for persistence.
 */
export function buildPowerFactorReport(input: {
  tenantId: string
  tenantName: string
  reportDate: string
  forecast: PowerFactorForecast
}): BuiltReport {
  const payload: PowerFactorReportPayload = {
    kind: 'pf_forecast',
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    reportDate: input.reportDate,
    forecast: input.forecast,
    mandatory: true,
    warnings: input.forecast.warnings,
  }
  return { payload, summaryText: powerFactorSummary(input.tenantName, payload) }
}

/**
 * Build the hourly energy chart.
 * @param tenantName - tenant label.
 * @param reportDate - business date.
 * @param buckets - hourly buckets.
 * @param dataQuality - coverage and provenance.
 * @returns a `ChartSpec v1` line chart.
 */
function morningChart(
  tenantName: string,
  reportDate: string,
  buckets: readonly EnergyBucket[],
  dataQuality: Pick<NilmDataQuality, 'coverage' | 'source'>,
): ChartSpec {
  return {
    version: 1,
    type: 'line',
    title: `${tenantName} ${reportDate} 小时能耗`,
    unit: 'kWh',
    xAxis: {
      type: 'time',
      labels: buckets.map(bucket => new Date(bucket.startMs).toISOString()),
    },
    series: [{ name: '用电量', data: buckets.map(bucket => bucket.energyKwh) }],
    dataQuality: { coverage: dataQuality.coverage, source: dataQuality.source, provisional: false },
  }
}

/**
 * Build the deterministic Chinese morning summary.
 * @param payload - structured morning payload.
 * @returns bounded summary text.
 */
function morningSummary(payload: MorningReportPayload): string {
  const parts = [
    `${payload.tenantName} ${payload.reportDate} 用电 ${payload.energy.totalKwh.toFixed(2)} kWh，采集覆盖率 ${(payload.energy.coverage * 100).toFixed(1)}%。`,
  ]
  if (payload.cost === null) {
    parts.push('当日没有可执行的电价方案，费用未计算。')
  } else {
    const shares = PERIODS.map(period => `${periodLabel(period)} ${((payload.periodShares[period] ?? 0) * 100).toFixed(1)}%`).join('、')
    parts.push(`电度电费 ${payload.cost.totalCost.toFixed(2)} 元，峰平谷占比 ${shares}。`)
  }
  const top = payload.workshopRanking[0]
  if (top !== undefined) parts.push(`能耗最高车间为${top.name}，${top.energyKwh.toFixed(2)} kWh。`)
  parts.push(`当日告警：严重 ${String(payload.alerts.critical)} 条、警告 ${String(payload.alerts.warning)} 条、未处理 ${String(payload.alerts.unresolved)} 条。`)
  if (payload.powerFactor !== null) {
    const value = payload.powerFactor.projectedPowerFactor
    parts.push(`月累计功率因数${value === undefined ? '暂不可计算' : `预测 ${value.toFixed(3)}`}，风险 ${payload.powerFactor.risk}。`)
  }
  return parts.join('')
}

/**
 * Build the deterministic Chinese power-factor summary.
 * @param tenantName - tenant label.
 * @param payload - structured forecast payload.
 * @returns bounded summary text.
 */
function powerFactorSummary(tenantName: string, payload: PowerFactorReportPayload): string {
  const forecast = payload.forecast
  const projected = forecast.projectedPowerFactor === undefined
    ? '暂不可计算'
    : forecast.projectedPowerFactor.toFixed(4)
  return `${tenantName} ${payload.reportDate} 力调预测：月度功率因数 ${projected}，考核线 ${forecast.threshold.toFixed(4)}，风险 ${forecast.risk}。剩余 ${String(forecast.remainingDays)} 天按同工作日中位数外推到 ${forecast.monthEndDate}。`
}

/**
 * @param period - tariff period.
 * @returns Chinese period label.
 */
function periodLabel(period: TariffPeriodType): string {
  switch (period) {
    case 'sharp': return '尖'
    case 'peak': return '峰'
    case 'flat': return '平'
    case 'valley': return '谷'
  }
}

/**
 * @returns empty per-period energy record.
 */
function emptyPeriodRecord(): Record<TariffPeriodType, { energyKwh: number; cost: number; share: number }> {
  return {
    sharp: { energyKwh: 0, cost: 0, share: 0 },
    peak: { energyKwh: 0, cost: 0, share: 0 },
    flat: { energyKwh: 0, cost: 0, share: 0 },
    valley: { energyKwh: 0, cost: 0, share: 0 },
  }
}

/**
 * @returns empty per-period share record.
 */
function emptyPeriodShares(): Record<TariffPeriodType, number | null> {
  return { sharp: null, peak: null, flat: null, valley: null }
}

/**
 * @param values - finite numbers.
 * @returns the total.
 */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
