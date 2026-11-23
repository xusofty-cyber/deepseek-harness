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
export { NilmError, NilmSourceError, NilmToolError, SECURITY_TOOL_FAILURE_CODES } from './errors.ts'
export type { NilmErrorCode } from './errors.ts'
export { assertHttpEndpoint, readBoundedResponseText, ResponseLimitError } from './fetch-body.ts'
export { REDACTED, redactText, redactValue } from './redact.ts'
export type { SecurityAuditEvent, SecurityAuditSink } from './audit.ts'
