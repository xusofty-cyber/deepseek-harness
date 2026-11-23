/**
 * Deterministic stage-3 rule evaluation. Every threshold arrives from the
 * tenant rule row; these functions never read storage, time, or a model.
 * @module @deepseek-ai/dsh-nilm-sentinel/rules
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type { AlertSeverity, SentinelRuleId } from './model.ts'

/** One deterministic rule finding; the scanner attaches tenant, scope, and keys. */
export interface RuleFinding {
  /** Rule severity after any amount-based promotion. */
  severity: AlertSeverity
  /** Stored metric name. */
  metric: string
  /** Observed numeric value. */
  value: number
  /** Configured threshold used by escalation checks. */
  threshold: number | null
  /** Metric unit. */
  unit: string
  /** Deterministic summary safe for the customer application. */
  summary: string
  /** Extra facts copied into the notification payload. */
  facts: Readonly<Record<string, string | number | boolean | null>>
}

/** `R-01a` thresholds. */
export interface R01aThresholds {
  /** Power increment over the non-work baseline required for one sample, in kW. */
  stepKw: number
  /** Minimum absolute increment required to avoid noise, in kW. */
  minIncrementKw: number
  /** Consecutive 5-second samples required. */
  samples: number
  /** Optional hourly-waste amount that promotes the finding to critical. */
  criticalCostPerHour?: number
}

/** `R-01b` thresholds. */
export interface R01bThresholds {
  /** Multiplier over the non-work baseline; defaults to 1.2 in provisioning examples. */
  baselineMultiplier: number
  /** Sustained deviation window in minutes. */
  sustainedMinutes: number
  /** Optional hourly-waste amount that promotes the finding to critical. */
  criticalCostPerHour?: number
}

/** `R-02` thresholds. */
export interface R02Thresholds {
  /** Power below which a running appliance is considered idle, in kW. */
  idlePowerKw: number
  /** Sustained idle window in minutes. */
  sustainedMinutes: number
}

/** `R-03` thresholds. */
export interface R03Thresholds {
  /** Multiplier over rated power that defines overload. */
  overloadRatio: number
}

/** `R-04` thresholds. */
export interface R04Thresholds {
  /** Maximum current deviation from the three-phase mean, in percent. */
  unbalancePercent: number
  /** Percentage above which the finding becomes critical. */
  criticalPercent: number
  /** Sustained window in minutes. */
  sustainedMinutes: number
}

/** `R-05` thresholds. */
export interface R05Thresholds {
  /** Voltage deviation from nominal, in percent. */
  deviationPercent: number
  /** Percentage above which the finding becomes critical. */
  criticalPercent: number
  /** Sustained window in minutes. */
  sustainedMinutes: number
  /** Nominal phase voltage in volts; defaults to the deployment setting when omitted. */
  nominalVoltageV?: number
}

/** Union of every typed threshold payload. */
export type RuleThresholds =
  | R01aThresholds
  | R01bThresholds
  | R02Thresholds
  | R03Thresholds
  | R04Thresholds
  | R05Thresholds

/** Three-phase current snapshot in amperes. */
export interface PhaseCurrents {
  a: number
  b: number
  c: number
}

/** Three-phase voltage snapshot in volts. */
export interface PhaseVoltages {
  a: number
  b: number
  c: number
}

/** Input accepted by {@link evaluateR01a}. */
export interface R01aInput {
  /** Recent non-work power samples in chronological order. */
  samples: readonly number[]
  /** Tenant non-work baseline in kW. */
  baselineKw: number
  /** Effective energy price in currency units per kWh. */
  energyPricePerKwh?: number
  /** Parsed rule thresholds. */
  thresholds: R01aThresholds
}

/** Input accepted by {@link evaluateR01b}. */
export interface R01bInput {
  /** Latest total power in kW. */
  powerKw: number
  /** Tenant non-work baseline in kW. */
  baselineKw: number
  /** Whether the condition has covered the configured window. */
  sustained: boolean
  /** Effective energy price in currency units per kWh. */
  energyPricePerKwh?: number
  /** Parsed rule thresholds. */
  thresholds: R01bThresholds
}

/** Input accepted by {@link evaluateR02}. */
export interface R02Input {
  /** Appliance display name. */
  name: string
  /** Latest appliance power in kW. */
  powerKw: number
  /** Whether upstream reports the appliance as running. */
  running: boolean
  /** Start of the current running/idle interval in epoch milliseconds. */
  stateSinceMs: number
  /** Evaluation instant in epoch milliseconds. */
  nowMs: number
  /** Parsed rule thresholds. */
  thresholds: R02Thresholds
}

/** Input accepted by {@link evaluateR03}. */
export interface R03Input {
  /** Latest device power in kW. */
  powerKw: number
  /** Nameplate rating in kW. */
  ratedPowerKw: number
  /** Parsed rule thresholds. */
  thresholds: R03Thresholds
}

/** Input accepted by {@link evaluateR04}. */
export interface R04Input {
  /** Latest three-phase currents. */
  currents: PhaseCurrents
  /** Whether the condition has covered the configured window. */
  sustained: boolean
  /** Parsed rule thresholds. */
  thresholds: R04Thresholds
}

/** Input accepted by {@link evaluateR05}. */
export interface R05Input {
  /** Latest three-phase voltages. */
  voltages: PhaseVoltages
  /** Nominal phase voltage in volts. */
  nominalVoltageV: number
  /** Whether the condition has covered the configured window. */
  sustained: boolean
  /** Parsed rule thresholds. */
  thresholds: R05Thresholds
}

/**
 * Parse a tenant rule's threshold JSON into the typed shape for its rule id.
 * @param ruleId - rule whose payload is being parsed.
 * @param raw - decoded JSON value or JSON text.
 * @returns the typed thresholds.
 * @throws NilmError with `INVALID_ARGUMENT` for missing or non-numeric fields.
 */
export function parseThresholds(ruleId: SentinelRuleId, raw: unknown): RuleThresholds {
  const value = typeof raw === 'string' ? parseJson(raw) : raw
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NilmError('INVALID_ARGUMENT', `${ruleId} threshold_json must be an object`)
  }
  const object = value as Record<string, unknown>
  switch (ruleId) {
    case 'R-01a':
      return {
        stepKw: positive(object, ruleId, 'stepKw'),
        minIncrementKw: nonNegative(object, ruleId, 'minIncrementKw'),
        samples: positiveInteger(object, ruleId, 'samples'),
        ...optionalPositive(object, 'criticalCostPerHour'),
      }
    case 'R-01b':
      return {
        baselineMultiplier: positive(object, ruleId, 'baselineMultiplier'),
        sustainedMinutes: positive(object, ruleId, 'sustainedMinutes'),
        ...optionalPositive(object, 'criticalCostPerHour'),
      }
    case 'R-02':
      return {
        idlePowerKw: nonNegative(object, ruleId, 'idlePowerKw'),
        sustainedMinutes: positive(object, ruleId, 'sustainedMinutes'),
      }
    case 'R-03':
      return { overloadRatio: positive(object, ruleId, 'overloadRatio') }
    case 'R-04':
      return {
        unbalancePercent: positive(object, ruleId, 'unbalancePercent'),
        criticalPercent: positive(object, ruleId, 'criticalPercent'),
        sustainedMinutes: positive(object, ruleId, 'sustainedMinutes'),
      }
    case 'R-05':
      return {
        deviationPercent: positive(object, ruleId, 'deviationPercent'),
        criticalPercent: positive(object, ruleId, 'criticalPercent'),
        sustainedMinutes: positive(object, ruleId, 'sustainedMinutes'),
        ...optionalVoltage(object),
      }
  }
}

/**
 * Evaluate `R-01a`: consecutive non-work step above the baseline.
 * @param input - recent samples, baseline, price, and thresholds.
 * @returns the finding, or `undefined` when the condition is absent.
 */
export function evaluateR01a(input: R01aInput): RuleFinding | undefined {
  const { samples, baselineKw, thresholds } = input
  if (samples.length < thresholds.samples) return undefined
  const recent = samples.slice(-thresholds.samples)
  const floor = baselineKw + thresholds.stepKw
  if (!recent.every(power => power > floor)) return undefined
  const current = recent[recent.length - 1]!
  const increment = current - baselineKw
  if (increment <= thresholds.minIncrementKw) return undefined
  const wasteCostPerHour = hourlyCost(increment, input.energyPricePerKwh)
  const severity: AlertSeverity = thresholds.criticalCostPerHour !== undefined
    && wasteCostPerHour !== undefined
    && wasteCostPerHour >= thresholds.criticalCostPerHour ? 'critical' : 'warning'
  const costText = wasteCostPerHour === undefined
    ? '未配置电价，未估算浪费金额'
    : `按当前电价估算每小时浪费约 ${wasteCostPerHour.toFixed(2)} 元`
  return {
    severity,
    metric: 'non_work_step_kw',
    value: round(increment),
    threshold: round(thresholds.stepKw),
    unit: 'kW',
    summary: `非工作时段功率阶跃：较基载 ${baselineKw.toFixed(2)} kW 上升 ${increment.toFixed(2)} kW，${costText}。`,
    facts: {
      baselineKw: round(baselineKw),
      powerKw: round(current),
      incrementKw: round(increment),
      samples: thresholds.samples,
      wasteCostPerHour: wasteCostPerHour === undefined ? null : round(wasteCostPerHour),
    },
  }
}

/**
 * Evaluate `R-01b`: sustained non-work base-load deviation.
 * @param input - current power, baseline, sustained flag, and thresholds.
 * @returns the finding, or `undefined` when the condition is absent.
 */
export function evaluateR01b(input: R01bInput): RuleFinding | undefined {
  const { powerKw, baselineKw, thresholds } = input
  const threshold = baselineKw * thresholds.baselineMultiplier
  if (!input.sustained || !(powerKw > threshold)) return undefined
  const increment = powerKw - baselineKw
  const wasteCostPerHour = hourlyCost(increment, input.energyPricePerKwh)
  const severity: AlertSeverity = thresholds.criticalCostPerHour !== undefined
    && wasteCostPerHour !== undefined
    && wasteCostPerHour >= thresholds.criticalCostPerHour ? 'critical' : 'warning'
  const costText = wasteCostPerHour === undefined
    ? '未配置电价，未估算浪费金额'
    : `估算每小时多耗电费约 ${wasteCostPerHour.toFixed(2)} 元`
  return {
    severity,
    metric: 'non_work_base_load_kw',
    value: round(powerKw),
    threshold: round(threshold),
    unit: 'kW',
    summary: `非工作时段基载偏离：持续 ${thresholds.sustainedMinutes} 分钟高于基线 ${(thresholds.baselineMultiplier - 1) * 100}%，${costText}。`,
    facts: {
      baselineKw: round(baselineKw),
      powerKw: round(powerKw),
      sustainedMinutes: thresholds.sustainedMinutes,
      wasteCostPerHour: wasteCostPerHour === undefined ? null : round(wasteCostPerHour),
    },
  }
}

/**
 * Evaluate `R-02`: an appliance running in a non-production period with idle power.
 * @param input - appliance state, duration, and thresholds.
 * @returns the finding, or `undefined` when the condition is absent.
 */
export function evaluateR02(input: R02Input): RuleFinding | undefined {
  const { powerKw, running, stateSinceMs, nowMs, thresholds } = input
  if (!running || powerKw >= thresholds.idlePowerKw) return undefined
  const sustainedMs = nowMs - stateSinceMs
  if (sustainedMs < thresholds.sustainedMinutes * 60_000) return undefined
  return {
    severity: 'warning',
    metric: 'appliance_idle_power_kw',
    value: round(powerKw),
    threshold: round(thresholds.idlePowerKw),
    unit: 'kW',
    summary: `非生产时段设备「${input.name}」持续运行约 ${Math.floor(sustainedMs / 60_000)} 分钟且功率低于空载阈值 ${thresholds.idlePowerKw} kW，请核查是否忘记停机。`,
    facts: {
      appliance: input.name,
      powerKw: round(powerKw),
      idlePowerKw: round(thresholds.idlePowerKw),
      sustainedMinutes: Math.floor(sustainedMs / 60_000),
    },
  }
}

/**
 * Evaluate `R-03`: single-device overload.
 * @param input - device power, rating, and thresholds.
 * @returns the critical finding, or `undefined` when the condition is absent.
 */
export function evaluateR03(input: R03Input): RuleFinding | undefined {
  const threshold = input.ratedPowerKw * input.thresholds.overloadRatio
  if (!(input.powerKw > threshold)) return undefined
  return {
    severity: 'critical',
    metric: 'device_overload_kw',
    value: round(input.powerKw),
    threshold: round(threshold),
    unit: 'kW',
    summary: `单设备过载：当前功率 ${input.powerKw.toFixed(2)} kW 超过额定 ${input.ratedPowerKw.toFixed(2)} kW 的 ${(input.thresholds.overloadRatio * 100).toFixed(0)}%，请立即核查。`,
    facts: {
      powerKw: round(input.powerKw),
      ratedPowerKw: round(input.ratedPowerKw),
      overloadRatio: input.thresholds.overloadRatio,
    },
  }
}

/**
 * Evaluate `R-04`: sustained three-phase current unbalance.
 * @param input - phase currents, sustained flag, and thresholds.
 * @returns the finding, or `undefined` when the condition is absent.
 */
export function evaluateR04(input: R04Input): RuleFinding | undefined {
  const values = [input.currents.a, input.currents.b, input.currents.c]
  if (values.some(value => !Number.isFinite(value) || value < 0)) return undefined
  const mean = (values[0]! + values[1]! + values[2]!) / 3
  if (mean <= 0) return undefined
  const unbalance = Math.max(...values.map(value => Math.abs(value - mean))) / mean * 100
  if (!input.sustained || !(unbalance > input.thresholds.unbalancePercent)) return undefined
  return {
    severity: unbalance >= input.thresholds.criticalPercent ? 'critical' : 'warning',
    metric: 'three_phase_unbalance_percent',
    value: round(unbalance),
    threshold: round(input.thresholds.unbalancePercent),
    unit: '%',
    summary: `三相电流不平衡度 ${unbalance.toFixed(1)}% 超过阈值 ${input.thresholds.unbalancePercent}%，请检查单相负荷分配与接线。`,
    facts: {
      phaseCurrentA: round(input.currents.a),
      phaseCurrentB: round(input.currents.b),
      phaseCurrentC: round(input.currents.c),
      unbalancePercent: round(unbalance),
      sustainedMinutes: input.thresholds.sustainedMinutes,
    },
  }
}

/**
 * Evaluate `R-05`: sustained over/under voltage on any phase.
 * @param input - phase voltages, nominal voltage, sustained flag, and thresholds.
 * @returns the finding, or `undefined` when the condition is absent.
 */
export function evaluateR05(input: R05Input): RuleFinding | undefined {
  if (!(input.nominalVoltageV > 0)) return undefined
  const values = [input.voltages.a, input.voltages.b, input.voltages.c]
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return undefined
  const deviations = values.map(value => Math.abs(value - input.nominalVoltageV) / input.nominalVoltageV * 100)
  const worst = Math.max(...deviations)
  if (!input.sustained || !(worst > input.thresholds.deviationPercent)) return undefined
  const lowest = Math.min(...values)
  const direction = lowest < input.nominalVoltageV ? '偏低' : '偏高'
  return {
    severity: worst >= input.thresholds.criticalPercent ? 'critical' : 'warning',
    metric: 'voltage_deviation_percent',
    value: round(worst),
    threshold: round(input.thresholds.deviationPercent),
    unit: '%',
    summary: `三相电压${direction}：最大偏差 ${worst.toFixed(1)}%（额定 ${input.nominalVoltageV} V），请检查供电质量与线路压降。`,
    facts: {
      phaseVoltageA: round(input.voltages.a),
      phaseVoltageB: round(input.voltages.b),
      phaseVoltageC: round(input.voltages.c),
      nominalVoltageV: round(input.nominalVoltageV),
      worstDeviationPercent: round(worst),
      sustainedMinutes: input.thresholds.sustainedMinutes,
    },
  }
}

/**
 * Decide whether a boolean observation has held for the whole window.
 * @param samples - chronological observations, each with its instant and predicate result.
 * @param nowMs - window end in epoch milliseconds.
 * @param windowMs - required window width.
 * @param minimumSamples - minimum observations needed to avoid a single-sample decision.
 * @returns true when every sample inside the window violated the condition.
 */
export function isSustained(
  samples: readonly { tsMs: number; violated: boolean }[],
  nowMs: number,
  windowMs: number,
  minimumSamples: number,
): boolean {
  if (windowMs <= 0 || minimumSamples < 1) return false
  const startMs = nowMs - windowMs
  const inside = samples.filter(sample => sample.tsMs >= startMs && sample.tsMs <= nowMs)
  if (inside.length < minimumSamples) return false
  if (!inside.every(sample => sample.violated)) return false
  return inside[0]!.tsMs <= startMs + Math.min(windowMs, 60_000)
}

/**
 * Compute hourly waste cost from a power increment.
 * @param incrementKw - power increment in kW.
 * @param pricePerKwh - optional energy price.
 * @returns hourly cost, or `undefined` when no price is configured.
 */
function hourlyCost(incrementKw: number, pricePerKwh: number | undefined): number | undefined {
  if (pricePerKwh === undefined || !Number.isFinite(pricePerKwh) || pricePerKwh < 0) return undefined
  return incrementKw * pricePerKwh
}

/**
 * Parse threshold JSON text.
 * @param text - JSON text from MySQL.
 * @returns the decoded value.
 */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    throw new NilmError('INVALID_ARGUMENT', 'threshold_json is not valid JSON', { cause: error })
  }
}

/** @param object - decoded thresholds. @param ruleId - diagnostic rule. @param key - field. @returns a positive finite number. */
function positive(object: Record<string, unknown>, ruleId: string, key: string): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new NilmError('INVALID_ARGUMENT', `${ruleId} threshold ${key} must be a positive number`)
  }
  return value
}

/** @param object - decoded thresholds. @param ruleId - diagnostic rule. @param key - field. @returns a non-negative finite number. */
function nonNegative(object: Record<string, unknown>, ruleId: string, key: string): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new NilmError('INVALID_ARGUMENT', `${ruleId} threshold ${key} must be a non-negative number`)
  }
  return value
}

/** @param object - decoded thresholds. @param ruleId - diagnostic rule. @param key - field. @returns a positive integer. */
function positiveInteger(object: Record<string, unknown>, ruleId: string, key: string): number {
  const value = positive(object, ruleId, key)
  if (!Number.isInteger(value)) throw new NilmError('INVALID_ARGUMENT', `${ruleId} threshold ${key} must be an integer`)
  return value
}

/** @param object - decoded thresholds. @param key - optional field. @returns the field when present. */
function optionalPositive(object: Record<string, unknown>, key: 'criticalCostPerHour'): { criticalCostPerHour?: number } {
  const value = object[key]
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new NilmError('INVALID_ARGUMENT', `threshold ${key} must be a positive number when present`)
  }
  return { criticalCostPerHour: value }
}

/** @param object - decoded thresholds. @returns the optional nominal voltage. */
function optionalVoltage(object: Record<string, unknown>): { nominalVoltageV?: number } {
  const value = object.nominalVoltageV
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new NilmError('INVALID_ARGUMENT', 'threshold nominalVoltageV must be a positive number when present')
  }
  return { nominalVoltageV: value }
}

/**
 * Round a metric to the four-decimal storage precision.
 * @param value - raw value.
 * @returns rounded value.
 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
