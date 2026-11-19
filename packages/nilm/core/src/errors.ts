/**
 * Stable NILM failure vocabulary shared by tools, services, and BFF mapping.
 * @module @deepseek-ai/dsh-nilm-core/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable machine-routable NILM failure code. */
export type NilmErrorCode =
  | 'UNAUTHORIZED_TENANT'
  | 'TENANT_CONTEXT_UNAVAILABLE'
  | 'SCOPE_FORBIDDEN'
  | 'SCOPE_NOT_FOUND'
  | 'AMBIGUOUS_SCOPE'
  | 'DATA_UNAVAILABLE'
  | 'DATA_PARTIAL'
  | 'COLD_LINK_UNAVAILABLE'
  | 'QUERY_LIMIT_EXCEEDED'
  | 'QUERY_TIMEOUT'
  | 'TOOL_EXECUTION_TIMEOUT'
  | 'MODEL_TIMEOUT'
  | 'RATE_LIMITED'
  | 'CHART_TOO_LARGE'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED_SQL_OPERATION'
  | 'INVALID_SOURCE_CONFIG'
  | 'SOURCE_UNAVAILABLE'

/** Base NILM error carrying a stable code separate from diagnostic prose. */
export class NilmError extends HarnessError {
  /**
   * @param code - stable machine-routable failure class.
   * @param message - diagnostic detail; defaults to the code.
   * @param options - standard error options such as `cause`.
   */
  constructor(code: NilmErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** Failure surfaced to the model or BFF for an invalid or unavailable tool call. */
export class NilmToolError extends NilmError {}

/** Failure raised by the read-only source adapter or its query guard. */
export class NilmSourceError extends NilmError {}

/**
 * Failure codes that indicate an authorization or argument-boundary violation.
 * Shared by the tool wrapper and the BFF so both audit the same classes.
 */
export const SECURITY_TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'INVALID_ARGS',
  'SCOPE_FORBIDDEN',
  'UNAUTHORIZED_TENANT',
  'TENANT_CONTEXT_UNAVAILABLE',
  'TOOL_CONTEXT_UNAVAILABLE',
  'UNAUTHORIZED_SQL_OPERATION',
])
