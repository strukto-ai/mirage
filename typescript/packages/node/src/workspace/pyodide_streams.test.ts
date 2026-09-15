import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { DiskResource } from '../resource/disk/disk.ts'
import { Workspace } from '../workspace.ts'

interface StreamCase {
  id: string
  world: { mounts: { '/ram': { files: Record<string, string> } } }
  steps: { command: string; expect: { exit: number; stdout: string; stderr: string } }[]
}

describe('Pyodide captured streams', { timeout: 120_000 }, () => {
  it.each(['ram', 'disk'])('runs the json.tool integration on a %s mount', async (kind) => {
    const suite = JSON.parse(
      await readFile(new URL('../../../../../integ/runtime/pyodide.json', import.meta.url), 'utf8'),
    ) as { cases: StreamCase[] }
    const fixture = suite.cases.find((testCase) => testCase.id === 'json_tool_closes_output')
    if (fixture === undefined) throw new Error('Missing json.tool integration fixture')
    const root = await mkdtemp(join(tmpdir(), 'mirage-streams-'))
    const resource = kind === 'disk' ? new DiskResource({ root }) : new RAMResource()
    const ws = new Workspace(
      { '/ram': resource },
      { mode: MountMode.EXEC, runtimes: ['pyodide', 'vfs'] },
    )
    try {
      for (const [name, content] of Object.entries(fixture.world.mounts['/ram'].files)) {
        await ws.dispatch('write', `/ram/${name}`, [new TextEncoder().encode(content)])
      }
      for (const step of fixture.steps) {
        const result = await ws.execute(step.command)
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
