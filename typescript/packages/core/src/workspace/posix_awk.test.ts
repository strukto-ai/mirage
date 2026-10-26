import { Workspace } from './workspace/workspace.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeIntegrationWS, runResult } from '../../tests/workspace/fixtures/integration_fixture.ts'

interface Case {
  id: string
  command: string
  expect: { exit: number; stdout: string; stderr: string }
  seed?: boolean
}

// The fixture files the getline cases read, as every integ target seeds them.
const FIXTURES =
  "printf '1\\n2\\n3\\n' > /data/b.txt; printf '10\\n2\\n30\\n4\\n5\\n' > /data/numbers.txt; " +
  "printf 'alice 30 engineer\\nbob 25 designer\\ncarol 40 manager\\n' > /data/fields.txt"
const cases = ['bash/test/posix.json', 'unix/awk/redirect.json', 'unix/awk/getline.json'].flatMap(
  (name) => {
    const data = JSON.parse(
      readFileSync(new URL(`../../../../../integ/${name}`, import.meta.url), 'utf8'),
    ) as { cases: Case[] }
    return data.cases.map((c) => ({ ...c, seed: name === 'unix/awk/getline.json' }))
  },
)

describe('POSIX classes and awk output across the shell', () => {
  it.each(cases)('$id', async (test) => {
    const { ws } = makeIntegrationWS()
    try {
      if (test.seed) await runResult(ws, FIXTURES)
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
    { mode: MountMode.WRITE },
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
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.READ })
  try {
    expect((await runResult(ws, `awk 'BEGIN {print "x" > "/data/out"}'`))[0]).toBe(2)
    expect((await runResult(ws, 'test -e /data/out'))[0]).toBe(1)
  } finally {
    await ws.close()
  }
})

// mawk 1.3.4 over /m1 and /m2 as two directories: awk keeps every operand's
// name and position when its operands span mounts.
const CROSS_MOUNT: [string, number, string, string][] = [
  [
    "awk '{print x, $0, FILENAME, FNR, NR}' /m1/a x=5 /m2/b",
    0,
    ' 1 /m1/a 1 1\n5 2 /m2/b 1 2\n5 3 /m2/b 2 3\n',
    '',
  ],
  ["awk 'FNR==1{getline; print FILENAME, $0, NR, FNR}' /m1/a /m2/b", 0, '/m2/b 2 2 1\n', ''],
  [
    "awk 'BEGIN{for(i=0;i<ARGC;i++) print i, ARGV[i]}' /m1/a x=1 /m2/b",
    0,
    '0 awk\n1 /m1/a\n2 x=1\n3 /m2/b\n',
    '',
  ],
  ['awk \'{print FILENAME ":" $0}\' /m1/nonl /m2/c', 0, '/m1/nonl:x\n/m2/c:y\n', ''],
  ["awk 'END{print x, NR, FILENAME}' x=3 /m1/a /m2/b", 0, '3 3 /m2/b\n', ''],
  ["awk '{print; nextfile}' /m1/a /m2/b", 0, '1\n2\n', ''],
  [
    "awk '{print}' /m1/a /m2/nope /m2/b",
    2,
    '1\n',
    'awk: cannot open "/m2/nope" (No such file or directory)\n',
  ],
  [
    "printf 'in\\n' | awk '{print FILENAME, $0}' /m1/a - /m2/b",
    0,
    '/m1/a 1\n- in\n/m2/b 2\n/m2/b 3\n',
    '',
  ],
]

it.each(CROSS_MOUNT)('keeps ARGV across mounts in %j', async (command, code, out, err) => {
  const ws = new Workspace({ '/m1': new RAMVFS(), '/m2': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await runResult(
      ws,
      "printf '1\\n' > /m1/a; printf '2\\n3\\n' > /m2/b; printf 'x' > /m1/nonl; printf 'y\\n' > /m2/c",
    )
    expect(await runResult(ws, command)).toEqual([code, out, err])
  } finally {
    await ws.close()
  }
})
