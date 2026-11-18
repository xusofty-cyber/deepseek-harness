import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import { assertNilmToolSurface } from '../src/index.ts'

describe('NILM tool-surface guard', () => {
  it('accepts the NILM namespace', () => {
    expect(() => { assertNilmToolSurface(['nilm_energy_query', 'nilm_alert_query']) }).not.toThrow()
  })

  it('rejects any tool outside the NILM namespace', () => {
    let thrown: unknown
    try { assertNilmToolSurface(['nilm_energy_query', 'bash', 'read_file']) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(NilmError)
    expect((thrown as NilmError).code).toBe('INTERNAL_ERROR')
    expect((thrown as NilmError).message).toContain('bash, read_file')
  })
})
