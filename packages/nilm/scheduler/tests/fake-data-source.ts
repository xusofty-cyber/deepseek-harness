import type {
  DailyEnergy,
  MorningData,
  MonthlyData,
  QualityData,
  SchedulerDataSource,
} from '../src/index.ts'

export class FakeSchedulerDataSource implements SchedulerDataSource {
  readonly morning = new Map<string, MorningData>()
  readonly monthly = new Map<string, MonthlyData>()
  readonly quality = new Map<string, QualityData>()
  readonly errors = new Map<string, Error>()

  async collectMorning(tenantId: string): Promise<MorningData> {
    this.throwIfConfigured(tenantId)
    return this.morning.get(tenantId) ?? emptyMorning()
  }

  async collectMonthly(tenantId: string): Promise<MonthlyData> {
    this.throwIfConfigured(tenantId)
    return this.monthly.get(tenantId) ?? { days: [], warnings: [] }
  }

  async collectQuality(tenantId: string): Promise<QualityData> {
    this.throwIfConfigured(tenantId)
    return this.quality.get(tenantId) ?? { observations: [], warnings: [] }
  }

  private throwIfConfigured(tenantId: string): void {
    const error = this.errors.get(tenantId)
    if (error !== undefined) throw error
  }
}

export function emptyMorning(): MorningData {
  return {
    buckets: [],
    dataQuality: { coverage: 0, source: 'raw' },
    workshops: [],
    warnings: ['no samples'],
  }
}

export function energyDays(count: number, activeKwh: number, reactiveKvarh: number): DailyEnergy[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-11-${String(index + 1).padStart(2, '0')}`,
    activeKwh,
    reactiveKvarh,
  }))
}
