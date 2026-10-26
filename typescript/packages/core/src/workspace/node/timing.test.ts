import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace/workspace.ts'

interface Case {
  id: string
  command: string
  expect: { exit: number; stdout: string; stderr: string }
}
const cases = ['bash/time.json', 'bash/heredoc/pipeline.json'].flatMap(
  (name) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../../../../../integ/${name}`, import.meta.url), 'utf8'),
      ) as { cases: Case[] }
    ).cases,
)
it.each(cases)('$id', async (row) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const result = await ws.shell(row.command.replaceAll('{mount}', '/data'))
    expect(result.exitCode).toBe(row.expect.exit)
    expect(new TextDecoder().decode(result.stdout)).toBe(row.expect.stdout)
    expect(new TextDecoder().decode(result.stderr)).toBe(row.expect.stderr)
  } finally {
    await ws.close()
  }
})
it('portable timing measures a complete pipeline', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const result = await ws.shell('time -p echo hi | cat')
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('hi\n')
    expect(new TextDecoder().decode(result.stderr)).toMatch(
      /^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/,
    )
  } finally {
    await ws.close()
  }
})
it.each([
  ['time time true', false],
  ['time -p time true', true],
  ['time time -p true', true],
  ['time ! time true', false],
  ['time', false],
])('%s reports once', async (line, portable) => {
  // bash 5.2.37: however many `time` words and `!` lead a pipeline, it
  // reports once, portable when any `time` takes `-p`.
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const result = await ws.shell(line)
    const lines = new TextDecoder().decode(result.stderr).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]?.startsWith(portable ? 'real ' : 'real\t')).toBe(true)
  } finally {
    await ws.close()
  }
})
