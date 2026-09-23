import { Operand } from '../commands/spec/types.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult, materialize } from '../io/types.ts'
import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

async function workspace(): Promise<Workspace> {
  return new Workspace(
    { '/data': new RAMVFS(), '/work': new RAMVFS(), '/tmp': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
}

describe('shell operand regressions', () => {
  it.each([
    ['echo a - 2>&1', 'a -\n', ''],
    ['echo é - 2>/dev/null', 'é -\n', ''],
    ['echo a - 1>&2', '', 'a -\n'],
    ['echo a - 2>>/data/err', 'a -\n', ''],
    ['f() { echo "argc=$#"; }; f a - 2>&1', 'argc=2\n', ''],
    ['echo a - - 2>&1', 'a - -\n', ''],
    ['echo a "-" 2>&1', 'a -\n', ''],
    ['echo a - >/data/out; cat /data/out', 'a -\n', ''],
  ])('preserves dash arguments: %s', async (line, stdout, stderr) => {
    const ws = await workspace()
    try {
      const result = await ws.shell(line)
      expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([0, stdout, stderr])
    } finally {
      await ws.close()
    }
  })

  it.each(['tar -cf /data/o.tar', 'zip -qr /data/o.zip'])(
    'checks %s at execution time',
    async (archive) => {
      const ws = await workspace()
      try {
        await ws.shell('mkdir -p /data/nd; echo hi > /data/nd/a')
        const result = await ws.shell(`d=/data/nd; cd "$d" && ${archive} .; echo rc=$?`)
        expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([0, 'rc=0\n', ''])
        const refused = await ws.shell(`echo before > /data/marker; ${archive} /data; echo after`)
        expect(refused.stdoutText).toBe('after\n')
        expect(refused.stderrText).toContain('Device or resource busy')
        expect((await ws.shell('cat /data/marker')).stdoutText).toBe('before\n')
      } finally {
        await ws.close()
      }
    },
  )

  it.each([
    ['/work', '/tmp', true],
    ['/work', '/tmp', false],
    ['/tmp', '/work', true],
    ['/', '/tmp', false],
  ] as const)('creates mktemp from %s on %s (directory=%s)', async (cwd, target, directory) => {
    const ws = await workspace()
    try {
      const result = await ws.shell(`cd ${cwd}; mktemp ${directory ? '-d ' : ''}${target}/t.XXXXXX`)
      expect(result.exitCode, result.stderrText).toBe(0)
      const path = result.stdoutText.trim()
      expect(path.startsWith(target + '/t.')).toBe(true)
      expect((await ws.shell(`test -${directory ? 'd' : 'f'} ${path}`)).exitCode).toBe(0)
      if (cwd !== '/') expect((await ws.shell(`test -e ${cwd}${path}`)).exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  })
})

it.each([
  ['cat -', 'a\nb\n'],
  ['wc -l -', '2 -\n'],
  ['sort -', 'a\nb\n'],
  ['grep a -', 'a\n'],
  ['cut -c1 -', 'a\nb\n'],
  ['head -n1 -', 'a\n'],
  ['tail -n1 -', 'b\n'],
  ["sed 's/a/A/' -", 'A\nb\n'],
  ['uniq -', 'a\nb\n'],
  ["awk '{print $1}' -", 'a\nb\n'],
  ['paste -sd, -', 'a,b\n'],
  ['cat - -', 'a\nb\n'],
  ['tr a A < /dev/stdin', 'A\nb\n'],
  ['cat /data/file - /data/file', 'file\na\nb\nfile\n'],
  ['cat - 2>&1', 'a\nb\n'],
  ['cat /dev/stdin', 'a\nb\n'],
  ['paste - -', 'a\tb\n'],
])('reads stdin operands: %s', async (command, expected) => {
  const ws = await workspace()
  try {
    await ws.shell('echo file > /data/file')
    const result = await ws.shell("printf 'a\\nb\\n' | " + command)
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([0, expected, ''])
  } finally {
    await ws.close()
  }
})

it('keeps the stdin operand on an installed CLI before an fd redirect', async () => {
  const ws = await workspace()
  const seen: string[] = []
  try {
    ws.registerCli(
      'consume',
      new CLISpec({
        name: 'consume',
        rest: new Operand({ type: 'str' }),
        fn: async (inv) => {
          seen.push(...inv.texts)
          return [await materialize(inv.stdin), new IOResult()]
        },
      }),
    )
    const result = await ws.shell('printf body | consume - 2>&1')
    expect([result.exitCode, result.stdoutText, seen]).toEqual([0, 'body', ['-']])
  } finally {
    await ws.close()
  }
})
