/**
 * Stage-0 connectivity probe; exits nonzero when any check fails.
 * @module @deepseek-ai/dsh-nilm-source/scripts/connectivity
 */

import { Context } from '@deepseek-ai/cordis'
import NilmSourceService, { loadSourceConfigFromEnv } from '../src/index.ts'

const config = loadSourceConfigFromEnv()
const ctx = new Context()
const service = new NilmSourceService(ctx, config)
try {
  const report = await service.probe()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
} finally {
  await service.close()
  await ctx.fiber.dispose()
}
