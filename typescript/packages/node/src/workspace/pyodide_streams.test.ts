import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { Workspace } from '../workspace.ts'

interface StreamCase {
  id: string
  world: { mounts: { '/ram': { files?: Record<string, string> } } }
  steps: { command: string; expect: { exit: number; stdout: string; stderr: string } }[]
}

describe('Pyodide captured streams', { timeout: 120_000 }, () => {
  it.each([
    ['ram', 'json_tool_closes_output'],
    ['disk', 'json_tool_closes_output'],
    ['ram', 'memory_growth_output'],
    ['disk', 'memory_growth_output'],
  ])('runs %s mount stream integration: %s', async (kind, id) => {
    const suite = JSON.parse(
      await readFile(new URL('../../../../../integ/runtime/pyodide.json', import.meta.url), 'utf8'),
    ) as { cases: StreamCase[] }
    const fixture = suite.cases.find((testCase) => testCase.id === id)
    if (fixture === undefined) throw new Error(`Missing stream integration fixture: ${id}`)
    const root = await mkdtemp(join(tmpdir(), 'mirage-streams-'))
    const vfs = kind === 'disk' ? new DiskVFS({ root }) : new RAMVFS()
    const ws = new Workspace(
      { '/ram': vfs },
      { mode: MountMode.EXEC, runtimes: ['pyodide', 'workspace'] },
    )
    try {
      for (const [name, content] of Object.entries(fixture.world.mounts['/ram'].files ?? {})) {
        await ws.dispatch('write', `/ram/${name}`, [new TextEncoder().encode(content)])
      }
      for (const step of fixture.steps) {
        const result = await ws.shell(step.command)
        expect(result.exitCode, step.command).toBe(step.expect.exit)
        expect(new TextDecoder().decode(result.stdout), step.command).toBe(step.expect.stdout)
        expect(new TextDecoder().decode(result.stderr), step.command).toBe(step.expect.stderr)
      }
    } finally {
      await ws.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
