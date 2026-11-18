import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  NilmError,
  NilmSourceError,
  NilmToolError,
  type ChartSpec,
  type TenantId,
} from '../src/index.ts'

describe('NILM core', () => {
  it('keeps branded identifiers at runtime strings', () => {
    const tenant = brandString<TenantId>('tenant-a')
    expect(tenant).toBe('tenant-a')
    expectTypeOf(tenant).toEqualTypeOf<TenantId>()
  })

  it('exposes stable error names and codes', () => {
    const error = new NilmSourceError('UNAUTHORIZED_SQL_OPERATION')
    expect(error).toBeInstanceOf(NilmError)
    expect(error).toBeInstanceOf(NilmSourceError)
    expect(error.name).toBe('NilmSourceError')
    expect(error.code).toBe('UNAUTHORIZED_SQL_OPERATION')
    expect(error.message).toBe('UNAUTHORIZED_SQL_OPERATION')
    expect(new NilmToolError('TENANT_CONTEXT_UNAVAILABLE').code).toBe('TENANT_CONTEXT_UNAVAILABLE')
  })

  it('accepts the versioned chart contract without ECharts marks', () => {
    const chart: ChartSpec = {
      version: 1,
      type: 'line',
      title: 'Power',
      unit: 'kW',
      series: [{ name: 'Total', data: [1, null, 2] }],
      annotations: [{ at: '2026-11-18T08:00:00+08:00', label: 'start', severity: 'warning' }],
    }
    expect(chart.version).toBe(1)
  })
})
