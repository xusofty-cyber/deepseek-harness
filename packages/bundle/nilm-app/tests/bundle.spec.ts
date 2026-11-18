/** The standalone NILM bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'

interface Row {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: unknown
}

type Patch = { id?: string; insert?: Row[]; disabled?: boolean }

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const production = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')) as Patch[]

function rows(patches: Patch[]): Row[] {
  return patches.flatMap(patch => patch.insert ?? [])
}

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-nilm-app bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(production).toHaveLength(1)
    expect(rows(production).map(row => [row.id, row.name])).toEqual([
      ['llm-deepseek', '@deepseek-ai/dsh-llm-deepseek-api-key'],
      ['timer', '@deepseek-ai/cordis-plugin-timer'],
      ['llm', '@deepseek-ai/dsh-llm'],
      ['llm-retry', '@deepseek-ai/dsh-llm-retry'],
      ['session', '@deepseek-ai/dsh-session'],
      ['session-projection', '@deepseek-ai/dsh-session-projection'],
      ['token-meter', '@deepseek-ai/dsh-token-meter'],
      ['compaction-basic', '@deepseek-ai/dsh-compaction-basic'],
      ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
      ['tools', '@deepseek-ai/dsh-tools'],
      ['tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'],
      ['agent', '@deepseek-ai/dsh-agent'],
      ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
      ['sessions', '@deepseek-ai/dsh-session-persistence-jsonl'],
      ['session-checkpoint-policy', '@deepseek-ai/dsh-session-checkpoint-policy'],
      ['nilm-context', '@deepseek-ai/dsh-nilm-context'],
      ['nilm-source', '@deepseek-ai/dsh-nilm-source'],
      ['nilm-assets', '@deepseek-ai/dsh-nilm-assets'],
      ['nilm-timeseries', '@deepseek-ai/dsh-nilm-timeseries'],
      ['nilm-tariff', '@deepseek-ai/dsh-nilm-tariff'],
      ['nilm-analytics', '@deepseek-ai/dsh-nilm-analytics'],
      ['nilm-safety', '@deepseek-ai/dsh-nilm-safety'],
      ['nilm-prompt', '@deepseek-ai/dsh-nilm-prompt'],
      ['nilm-tools', '@deepseek-ai/dsh-nilm-tools'],
      ['nilm-sentinel', '@deepseek-ai/dsh-nilm-sentinel'],
      ['nilm-notify', '@deepseek-ai/dsh-nilm-notify'],
      ['nilm-service', '@deepseek-ai/dsh-nilm-service'],
      ['nilm-tool-guard', '@deepseek-ai/dsh-nilm-app'],
    ])
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
    const missing = [...new Set(rows(production).flatMap(row => row.name === undefined ? [] : [packageName(row.name)]))]
      .filter(name => name !== manifest.name && !dependencies.has(name))
    expect(missing).toEqual([])
  })

  it('keeps the stdio transport and keyless provider out of production', () => {
    const names = rows(production).map(row => row.name ?? '')
    expect(names.some(name => name.includes('sdk-jsonrpc-server'))).toBe(false)
    expect(names.some(name => name.includes('dummy'))).toBe(false)
    expect(production.some(patch => patch.id === 'llm-deepseek' && patch.disabled === true)).toBe(false)
  })

  it('does not include the forbidden DeepSeek extension packages', () => {
    const text = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    for (const packageName of [
      'deepseek-llm-api-extensions',
      'session-log-deepseek',
      'plugin-package-inventory-deepseek',
    ]) {
      expect(text).not.toContain(packageName)
    }
  })

  it('does not mount shell, filesystem, web, MCP, terminal, sandbox, or subagent rows', () => {
    const names = rows(production).map(row => row.name ?? '')
    for (const packageName of [
      'dsh-tool-bash',
      'dsh-tool-fs',
      'dsh-tool-web',
      'dsh-mcp-client',
      'dsh-mcp-resources',
      'dsh-terminal',
      'dsh-sandbox',
      'dsh-subagent',
      'dsh-tool-subagent',
    ]) {
      expect(names.some(name => name.includes(packageName))).toBe(false)
    }
  })

  it('does not embed database addresses or connection strings', () => {
    const text = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(text).not.toContain('mysql://')
    for (const line of text.split('\n').filter(candidate => /\bhost:/.test(candidate))) {
      expect(line).toMatch(/process\.env\./)
    }
  })
})
