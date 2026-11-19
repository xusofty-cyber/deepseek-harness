/**
 * Shared security-audit seam: the BFF registers a recorder, and NILM plugins
 * emit tenant-bound rejection events without owning persistence.
 * @module @deepseek-ai/dsh-nilm-core/audit
 */

import type {} from '@deepseek-ai/cordis'

/** One security-relevant NILM event; implementations must not include bodies, prompts, or secrets. */
export interface SecurityAuditEvent {
  /** Stable event class, such as `tool.rejected` or `request.rejected`. */
  readonly type: string
  /** Caller correlation identifier when one exists. */
  readonly requestId?: string
  /** Verified tenant, absent when authentication failed before identity was established. */
  readonly tenantId?: string
  /** Opaque caller-side user reference when identity was verified. */
  readonly userRef?: string
  /** Session that produced the event when one exists. */
  readonly sessionId?: string
  /** Registered tool name for tool events; never model-generated text. */
  readonly tool?: string
  /** Stable failure code for rejected events. */
  readonly code?: string
}

/** Recorder registered by the BFF for every NILM plugin. */
export interface SecurityAuditSink {
  /**
   * Accept one event without blocking the caller.
   * @param event - security event without request content or credentials.
   */
  record(event: SecurityAuditEvent): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared security-audit recorder; absent when the BFF is not mounted. */
    nilmAudit?: SecurityAuditSink
  }
}
