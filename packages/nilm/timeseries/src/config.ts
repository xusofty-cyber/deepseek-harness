/**
 * Timeseries adapter configuration. Upstream table names are deployment-varying
 * contract values, not embedded SQL identifiers.
 * @module @deepseek-ai/dsh-nilm-timeseries/config
 */

import z from '@deepseek-ai/schemastery'

/** Complete timeseries adapter configuration. */
export interface TimeseriesConfig {
  /** Raw second/minute realtime supertable. */
  realtimeTable: string
  /** Three-phase summarized realtime supertable. */
  summarizedRealtimeTable: string
  /** Single-phase cumulative energy supertable. */
  energyTable: string
  /** Three-phase summarized cumulative energy supertable. */
  summarizedEnergyTable: string
  /** Daily pre-aggregated energy table. */
  dailyStatsTable: string
  /** NILM appliance disaggregation supertable. */
  applianceTable: string
  /** Maximum raw points fetched per meter and metric family. */
  rawPointLimit: number
  /** Maximum raw rows fetched across one analysis query, split evenly by meter. */
  analysisPointLimit: number
  /** Maximum points handed to a chart consumer. */
  chartPointLimit: number
  /** Age after which energy aggregates use the cold proxy. */
  hotDays: number
  /** Server-owned cold proxy template for daily energy. */
  coldTemplate: string
}

/** Default contract values for the reference upstream schema. */
export const DEFAULT_TIMESERIES_CONFIG: TimeseriesConfig = {
  realtimeTable: 'nilmdc_realtime_data',
  summarizedRealtimeTable: 'nilmdc_summarized_realtime_data',
  energyTable: 'nilmdc_energy_data',
  summarizedEnergyTable: 'nilmdc_summarized_energy_data',
  dailyStatsTable: 'consum_energy_day_statistics_info',
  applianceTable: 'nilmdc_appliance_identification',
  rawPointLimit: 2000,
  analysisPointLimit: 20_000,
  chartPointLimit: 500,
  hotDays: 90,
  coldTemplate: 'daily_energy',
}

/** Cordis configuration schema; every field defaults to the reference contract. */
export const Config: z<TimeseriesConfig> = z.object({
  realtimeTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.realtimeTable),
  summarizedRealtimeTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.summarizedRealtimeTable),
  energyTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.energyTable),
  summarizedEnergyTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.summarizedEnergyTable),
  dailyStatsTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.dailyStatsTable),
  applianceTable: z.string().default(DEFAULT_TIMESERIES_CONFIG.applianceTable),
  rawPointLimit: z.natural().min(1).max(100_000).default(DEFAULT_TIMESERIES_CONFIG.rawPointLimit),
  analysisPointLimit: z.natural().min(1).max(100_000).default(DEFAULT_TIMESERIES_CONFIG.analysisPointLimit),
  chartPointLimit: z.natural().min(1).max(5_000).default(DEFAULT_TIMESERIES_CONFIG.chartPointLimit),
  hotDays: z.natural().min(1).default(DEFAULT_TIMESERIES_CONFIG.hotDays),
  coldTemplate: z.string().default(DEFAULT_TIMESERIES_CONFIG.coldTemplate),
})

/**
 * Resolve explicit defaults for configuration supplied by a profile or tests.
 * @param request - optional partial configuration.
 * @returns complete configuration.
 */
export function resolveTimeseriesConfig(request: Partial<TimeseriesConfig> = {}): TimeseriesConfig {
  return { ...DEFAULT_TIMESERIES_CONFIG, ...request }
}
