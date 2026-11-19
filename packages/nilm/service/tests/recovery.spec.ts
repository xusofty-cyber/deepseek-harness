/**
 * Offline evidence for the G4-2 contract that does not need a cluster: the
 * tenant-scoped Session directory, torn-tail reads, and cross-process write
 * exclusion. The write half needs the repository's platform flock package and
 * is skipped only where that native artifact is not installed.
 */

import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { tenantSessionRoot } from '../src/paths.ts'

const TENANT = 'tenant-recovery'
const SESSION = brandString<SessionId>('conv_0000000000000000000000000000c0de')
const roots: string[] = []
const contexts: Context[] = []

const COMMITTED = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const
const CRASH_TAIL = [
  JSON.stringify({ type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } }),
  '{"type":"assistant/chunk","seq":3,"ti',
].join('\n')

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nilm-recovery-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return context
}

function header(cwd: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 1_000, cwd, isSeeded: false }
}

/** Write one physically valid log directly, then append a crash fragment. */
async function writeCrashedLog(root: string): Promise<string> {
  const cwd = tenantSessionRoot(root, TENANT)
  const path = logPath(root, cwd, SESSION, 'none')
  await mkdir(dirname(path), { recursive: true })
  const head = JSON.stringify({
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: SESSION,
    createdAt: 1_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  })
  const lines = [head, ...COMMITTED.map(event => JSON.stringify(event))]
  await writeFile(path, `${lines.join('\n')}\n${CRASH_TAIL}`, 'utf8')
  return path
}

function nativeFlockAvailable(): boolean {
  try {
    const require = createRequire(import.meta.url)
    require.resolve(`@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`)
    return true
  } catch {
    return false
  }
}

describe('G4-2 same-shard Session recovery', () => {
  it('stores a tenant Session under its PVC directory and ignores a torn tail on read', async () => {
    const root = await freshRoot()
    const path = await writeCrashedLog(root)
    const context = await mount(root)

    const snapshot = await context.sessionPersistence.stat(SESSION)
    expect(snapshot?.header.cwd).toBe(tenantSessionRoot(root, TENANT))
    expect(snapshot?.location?.path).toBe(path)

    const reader = await context.sessionPersistence.open(SESSION, 'read')
    const loaded = await reader.read()
    await reader.close()
    expect(loaded.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(loaded.events.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'turn/start'])
    expect(await readFile(path, 'utf8')).toContain('"type":"assistant/chunk"')
  })

  it.skipIf(!nativeFlockAvailable())('refuses a second writer, then truncates the fragment and continues', async () => {
    const root = await freshRoot()
    const cwd = tenantSessionRoot(root, TENANT)
    const first = await mount(root)
    const writer = await first.sessionPersistence.create(header(cwd))
    await writer.append([...COMMITTED])
    await writer.flush()
    const path = (await first.sessionPersistence.stat(SESSION))?.location?.path as string
    await writeFile(path, CRASH_TAIL, { flag: 'a' })

    const second = await mount(root)
    await expect(second.sessionPersistence.open(SESSION, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    // A terminated Pod releases the kernel lock; the successor reattaches to
    // the same file, repairs the fragment, and continues the stored sequence.
    await writer.close()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const successor = await second.sessionPersistence.open(SESSION, 'write')
    await successor.append([
      { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ])
    await successor.flush()
    await successor.close()

    const repaired = await readFile(path, 'utf8')
    expect(repaired).not.toContain('assistant/chunk')
    const reader = await second.sessionPersistence.open(SESSION, 'read')
    const loaded = await reader.read()
    await reader.close()
    expect(loaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
    expect(loaded.events.at(-1)?.type).toBe('turn/end')
  })
})
