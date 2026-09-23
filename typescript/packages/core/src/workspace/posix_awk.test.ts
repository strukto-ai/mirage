import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeIntegrationWS, runResult } from './fixtures/integration_fixture.ts'

interface Case {
  id: string
  command: string
  expect: { exit: number; stdout: string; stderr: string }
}
const cases = ['bash/test/posix.json', 'unix/awk/redirect.json'].flatMap((name) => {
  const data = JSON.parse(
    readFileSync(new URL(`../../../../../integ/${name}`, import.meta.url), 'utf8'),
  ) as { cases: Case[] }
  return data.cases
})

describe('POSIX classes and awk output across the shell', () => {
  it.each(cases)('$id', async (test) => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await runResult(ws, test.command)).toEqual([
        test.expect.exit,
        test.expect.stdout,
        test.expect.stderr,
      ])
    } finally {
      await ws.close()
    }
  })
})

it('dispatches awk output across mounts and stops on write failure', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS(), '/other': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    expect(
      await runResult(
        ws,
        `echo hi > /data/in; awk '{print > "/other/out"}' /data/in; cat /other/out`,
      ),
    ).toEqual([0, 'hi\n', ''])
    const result = await runResult(
      ws,
      `awk 'BEGIN {print "before"; print "x" > "/data/missing/out"; print "after" > "/other/after"} END {print "end"}'`,
    )
    expect(result[0]).toBe(2)
    expect(result[1]).toBe('before\n')
    expect(result[2]).toContain('No such file or directory')
    expect((await runResult(ws, 'test -e /other/after'))[0]).toBe(1)
  } finally {
    await ws.close()
  }
})

it('respects a read-only mount for awk output', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.READ, shellParser: await getTestParser() },
  )
  try {
    expect((await runResult(ws, `awk 'BEGIN {print "x" > "/data/out"}'`))[0]).toBe(2)
    expect((await runResult(ws, 'test -e /data/out'))[0]).toBe(1)
  } finally {
    await ws.close()
  }
})
