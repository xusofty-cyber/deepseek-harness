/**
 * Database- and model-independent NILM domain structures.
 * @module @deepseek-ai/dsh-nilm-core/types
 */

import type { ChannelId, SessionId, TenantId, TerminalId } from './ids.ts'

/** Supported topology level. */
export type ScopeLevel = 'factory' | 'workshop' | 'terminal' | 'channel' | 'appliance'

/** User- or caller-supplied target that still needs authorization resolution. */
export interface ScopeTarget {
  /** Requested topology level. */
  level: ScopeLevel
  /** Stable upstream identifier when known. */
  id?: string
  /** Human-readable node name when an identifier is unknown. */
  name?: string
  /** Full path used to disambiguate duplicate names. */
  path?: string
}

/** Role a metering channel plays in an aggregation set. */
export type MeterRole = 'terminal_total' | 'branch' | 'appliance' | 'reference'

/** One channel participating in an authorized metering set. */
export interface MeterPoint {
  /** Owning terminal. */
  terminalId: TerminalId
  /** Channel identifier. */
  channelId: ChannelId
  /** Aggregation role. */
  role: MeterRole
  /** Parent branch when the topology is hierarchical. */
  parentChannelId?: ChannelId
  /** Projected channel path, used by pre-aggregated lookups. */
  pathName?: string
}

/** One telemetry sample already scoped to an authorized meter. */
export interface TelemetryPoint {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Device that produced the sample. */
  deviceId: string
  /** Channel identifier when the source exposes it. */
  channelId?: ChannelId
  /** Upstream metric name. */
  metric: string
  /** Numeric value in the metric's upstream unit. */
  value: number
}

/** One energy amount covering a half-open interval. */
export interface EnergyBucket {
  /** Inclusive interval start in epoch milliseconds. */
  startMs: number
  /** Exclusive interval end in epoch milliseconds. */
  endMs: number
  /** Energy accumulated over the interval. */
  energyKwh: number
}

/** Resolved scope candidates and the non-overlapping meters they select. */
export interface ScopeResolution {
  /** Matched authorized nodes. */
  matched: ScopeTarget[]
  /** True when the query needs clarification before data access. */
  ambiguous: boolean
  /** Resolved path for a unique match. */
  resolvedPath?: string
  /** Deterministic topology or binding caveats that must reach the caller. */
  warnings?: string[]
  /** Meters selected for aggregation. */
  meterSet: MeterPoint[]
}

/** BFF-verified immutable caller identity; never present in Tool arguments. */
export interface CallContext {
  /** Tenant boundary. */
  readonly tenantId: TenantId
  /** Opaque caller-side user reference used for audit and idempotency. */
  readonly userRef: string
  /** Maximum scope the caller may access. */
  readonly allowedScope?: readonly ScopeTarget[]
  /** Request correlation identifier. */
  readonly requestId: string
  /** Session that owns this turn. */
  readonly sessionId: SessionId
}

/** Explicit identity for internal jobs that must not impersonate a user. */
export interface SystemContext {
  /** Internal workload that owns the operation. */
  readonly actor: 'sentinel' | 'scheduler' | 'notifier'
  /** Trace identifier shared by the workload and its logs. */
  readonly traceId: string
}

/** Half-open time range with its business granularity. */
export interface TimeRangeSpec {
  /** ISO 8601 start instant with an offset. */
  start: string
  /** ISO 8601 exclusive end instant with an offset. */
  end: string
  /** Business time zone fixed for this deployment. */
  timeZone: 'Asia/Shanghai'
  /** Query granularity. */
  granularity: 'second' | 'minute' | '15min' | 'hour' | 'day' | 'month'
}

/** Coverage and provenance attached to every query result. */
export interface NilmDataQuality {
  /** Ratio of expected samples that were present, from 0 to 1. */
  coverage: number
  /** Most recent valid sample instant. */
  lastSampleAt?: string
  /** True while upstream data may still change. */
  provisional: boolean
  /** Missing intervals in business time. */
  gaps: Array<{ start: string; end: string; reason: string }>
  /** Source path that produced the values. */
  source: 'preaggregated' | 'raw' | 'cold' | 'mixed'
  /** Parent/child or disaggregation warnings. */
  warnings: string[]
}

/** Stable chart protocol rendered by the caller's client, not an ECharts option. */
export interface ChartSpec {
  /** Protocol version. */
  version: 1
  /** Chart family. */
  type: 'line' | 'bar' | 'pie' | 'gauge' | 'stacked-bar'
  /** Chart title. */
  title: string
  /** Optional secondary title. */
  subtitle?: string
  /** Unit displayed with the values. */
  unit: string
  /** X-axis declaration. */
  xAxis?: { type: 'time' | 'category'; labels?: string[] }
  /** At most eight series with nulls marking gaps. */
  series: Array<{ name: string; data: Array<number | null>; colorKey?: string }>
  /** Event callouts; clients must not translate these into ECharts markLine/markPoint. */
  annotations?: Array<{ at: string | number; label: string; severity?: 'info' | 'warning' | 'critical' }>
  /** Quality subset rendered below the chart. */
  dataQuality?: Pick<NilmDataQuality, 'coverage' | 'source' | 'provisional'>
}

/** Critical/warning card shown by the caller's client. */
export interface AlertCard {
  /** Stable alert event identifier. */
  id: string
  /** Alert severity. */
  severity: 'critical' | 'warning' | 'info'
  /** Short card title. */
  title: string
  /** Occurrence location. */
  site: { tenant: string; workshop?: string; terminal?: string; channel?: string; phase?: 'A' | 'B' | 'C' }
  /** Source event instant. */
  occurredAt: string
  /** Threshold and observed metrics. */
  metrics: Array<{ label: string; value: string; unit: string; threshold?: string }>
  /** Deterministic finding. */
  finding: string
  /** Deterministic recommendation. */
  recommendation: string
  /** Client actions; no remote switching. */
  actions: Array<{ id: string; label: string; kind: 'ack' | 'call' | 'detail' }>
  /** Optional quality subset. */
  dataQuality?: Pick<NilmDataQuality, 'coverage' | 'provisional'>
}

/** Tool envelope whose facts are deterministic and whose summary is not model-authored. */
export interface NilmToolResult<T> {
  /** One-line deterministic conclusion with scope, range, and unit. */
  summaryText: string
  /** Structured facts. */
  facts: T
  /** Required data-quality metadata. */
  dataQuality: NilmDataQuality
  /** Limits, gaps, and estimation caveats. */
  warnings: string[]
  /** Optional chart for the caller's client. */
  chart?: ChartSpec
  /** Optional clarification or acknowledgement candidates. */
  actions?: Array<{ id: string; label: string; kind: 'clarify' | 'ack' | 'navigate' }>
}
