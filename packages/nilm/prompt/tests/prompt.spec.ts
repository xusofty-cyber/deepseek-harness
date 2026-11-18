import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, NILM_POLICY } from '../src/index.ts'

describe('nilm prompt policy', () => {
  it('registers one stable policy section', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: '',
        personaSuffix: '',
      })
      apply(ctx)
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'nilm:policy')?.text).toBe(NILM_POLICY)
      expect(NILM_POLICY).toContain('Never replace missing data with zero')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
