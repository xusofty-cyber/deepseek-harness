/**
 * NILM bundle startup guard: reject any tool outside the nilm_* namespace.
 * @module @deepseek-ai/dsh-nilm-app
 */

import type { Context } from '@deepseek-ai/cordis'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'nilm-tool-guard'
/** The tool registry must be mounted before the guard runs. */
export const inject = ['tools']

/**
 * Assert that a registered tool surface contains only NILM tools.
 * @param names - final registered tool names.
 * @throws NilmError with `INTERNAL_ERROR` when a tool is outside the `nilm_*` namespace.
 */
export function assertNilmToolSurface(names: readonly string[]): void {
  const unexpected = names.filter(tool => !/^nilm_/.test(tool))
  if (unexpected.length > 0) {
    throw new NilmError('INTERNAL_ERROR', `NILM profile registered forbidden tools: ${unexpected.join(', ')}`)
  }
}

/**
 * Assert that the final registered tool surface contains only NILM tools.
 * @param ctx - plugin context with a mounted tool registry.
 */
export function apply(ctx: Context): void {
  assertNilmToolSurface(ctx.tools.schemas().map(schema => schema.name))
}
