import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '../workspace.ts'

interface ProcessCase {
  id: string
  world: { mounts: { '/ram': { files: Record<string, string> } } }
  steps: { command: string; expect: { exit: number; stdout: string; stderr: string } }[]
}

const suite = JSON.parse(
  await readFile(
    new URL('../../../../../integ/runtime/pyodide/process.json', import.meta.url),
    'utf8',
  ),
) as { cases: ProcessCase[] }

describe('Pyodide processes', { timeout: 120_000 }, () => {
  it.each(suite.cases.map((testCase) => [testCase.id, testCase] as const))(
    '%s',
    async (_id, testCase) => {
      const ws = new Workspace(
        { '/ram': new RAMVFS() },
        { mode: MountMode.EXEC, runtimes: ['pyodide', 'workspace'] },
      )
      try {
        for (const [name, content] of Object.entries(testCase.world.mounts['/ram'].files))
          await ws.dispatch('write', `/ram/${name}`, [new TextEncoder().encode(content)])
        for (const step of testCase.steps) {
          const result = await ws.shell(step.command)
          expect(new TextDecoder().decode(result.stdout), step.command).toBe(step.expect.stdout)
          expect(new TextDecoder().decode(result.stderr), step.command).toBe(step.expect.stderr)
          expect(result.exitCode, step.command).toBe(step.expect.exit)
        }
      } finally {
        await ws.close()
      }
    },
  )
})
