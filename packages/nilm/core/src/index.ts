/**
 * L0 NILM domain types: identifiers, shared structures, charts, and errors.
 * @module @deepseek-ai/dsh-nilm-core
 */

export type {
  ApplianceId,
  ChannelId,
  ConversationId,
  SessionId,
  TenantId,
  TerminalId,
  TurnId,
  WorkshopId,
} from './ids.ts'
export type {
  AlertCard,
  CallContext,
  ChartSpec,
  MeterPoint,
  MeterRole,
  EnergyBucket,
  NilmDataQuality,
  NilmToolResult,
  ScopeLevel,
  ScopeResolution,
  ScopeTarget,
  SystemContext,
  TelemetryPoint,
  TimeRangeSpec,
} from './types.ts'
export { NilmError, NilmSourceError, NilmToolError } from './errors.ts'
export type { NilmErrorCode } from './errors.ts'
