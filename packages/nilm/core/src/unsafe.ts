/**
 * Shared classification of upstream `nilm_unsafe_record` hazard types, used by
 * both the Sentinel scanner and the on-demand safety query so one record never
 * receives two different severities.
 * @module @deepseek-ai/dsh-nilm-core/unsafe
 */

/** Confirmed hazard family of an upstream unsafe-record type. */
export type UnsafeHazardFamily = 'transient' | 'overload' | 'unbalance' | 'voltage'

/** Family and base severity of one confirmed upstream type. */
export interface UnsafeHazardClass {
  /** Hazard family that owns the type. */
  family: UnsafeHazardFamily
  /** Base severity: transient (R-01a) and overload (R-03) are critical; unbalance (R-04) and voltage (R-05) are warning. */
  severity: 'critical' | 'warning'
}

const FAMILIES: ReadonlyArray<readonly [UnsafeHazardFamily, UnsafeHazardClass['severity'], readonly string[]]> = [
  ['transient', 'critical', ['transient', 'step', 'shock', 'arc', 'flashover']],
  ['overload', 'critical', ['overload', 'over_current', 'overcurrent', 'current_over', 'power_over']],
  ['unbalance', 'warning', ['unbalance', 'imbalance', 'three_phase', 'phase_loss']],
  ['voltage', 'warning', ['voltage', 'over_voltage', 'under_voltage', 'voltage_deviation']],
]

/**
 * Classify one upstream hazard type by confirmed name fragments, in rule order.
 * @param unsafeType - upstream type name.
 * @returns the family and base severity, or `undefined` for an unconfirmed type.
 */
export function classifyUnsafeHazard(unsafeType: string): UnsafeHazardClass | undefined {
  const normalized = unsafeType.trim().toLowerCase().replaceAll(/[\s-]+/g, '_')
  if (normalized.length === 0) return undefined
  for (const [family, severity, fragments] of FAMILIES) {
    if (fragments.some(fragment => normalized.includes(fragment))) return { family, severity }
  }
  return undefined
}
