/**
 * Bind the BFF-verified caller context to an Agent ID without persisting it.
 * @module @deepseek-ai/dsh-nilm-context
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NilmToolError,
  type CallContext,
  type ScopeTarget,
} from '@deepseek-ai/dsh-nilm-core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmContext: NilmContextService
  }
}

/** Freeze the caller context and its scope list so later mutations cannot widen authority. */
function immutableCallContext(callContext: CallContext): CallContext {
  const { allowedScope, ...rest } = callContext
  if (rest.tenantId.length === 0 || rest.userRef.length === 0 || rest.requestId.length === 0 || rest.sessionId.length === 0) {
    throw new NilmToolError('UNAUTHORIZED_TENANT', 'call context requires non-empty tenant, user, request, and session identifiers')
  }
  const scope = allowedScope === undefined
    ? {}
    : { allowedScope: Object.freeze(allowedScope.map((target): ScopeTarget => Object.freeze({ ...target }))) }
  return Object.freeze({ ...rest, ...scope })
}

/** Process-memory binding from Agent ID to the caller context of its current request. */
export class NilmContextService extends Service {
  private readonly contexts = new Map<string, CallContext>()

  constructor(ctx: Context) {
    super(ctx, 'nilmContext')
  }

  /**
   * Bind one Agent to a verified caller context. Rebinding replaces the previous value.
   * @param agentId - runtime Agent identifier.
   * @param callContext - immutable context derived from a verified request.
   * @returns a disposer that removes only this exact binding.
   */
  bind(agentId: string, callContext: CallContext): () => void {
    if (agentId.length === 0) throw new NilmToolError('TENANT_CONTEXT_UNAVAILABLE', 'agent id is required')
    const stored = immutableCallContext(callContext)
    this.contexts.set(agentId, stored)
    return () => {
      if (this.contexts.get(agentId) === stored) this.contexts.delete(agentId)
    }
  }

  /**
   * Read the current caller context for one Agent.
   * @param agentId - runtime Agent identifier.
   * @returns the bound immutable caller context.
   * @throws NilmToolError with `TENANT_CONTEXT_UNAVAILABLE` when no binding exists.
   */
  require(agentId: string): CallContext {
    const context = this.contexts.get(agentId)
    if (context === undefined) {
      throw new NilmToolError('TENANT_CONTEXT_UNAVAILABLE', `no NILM caller context is bound to agent '${agentId}'`)
    }
    return context
  }

  /**
   * Read the current caller context without treating an absent binding as a
   * tool failure. Security auditing must not mask the original rejection.
   * @param agentId - runtime Agent identifier.
   * @returns the bound immutable caller context, or `undefined` when none exists.
   */
  current(agentId: string): CallContext | undefined {
    return this.contexts.get(agentId)
  }

  /**
   * Remove the binding for one Agent. Revoking an absent binding is a no-op.
   * @param agentId - runtime Agent identifier.
   */
  revoke(agentId: string): void {
    this.contexts.delete(agentId)
  }
}

export default NilmContextService
