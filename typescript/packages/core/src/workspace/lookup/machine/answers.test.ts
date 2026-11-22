// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import {
  type Answer,
  ScriptedMachine,
  failed,
  ok,
  on,
  captured,
} from '../../../../tests/fixtures/machine.ts'
import { FakeFiles } from '../../../../tests/fixtures/machine_files.ts'
import type { ByteSource } from '../../../io/types.ts'
import { RUN_PROGRAM_AT, isRun } from '../../../machine/constants.ts'
import type { OutputFn, RunResult } from '../../../runtime/types.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const DEC = new TextDecoder()

async function out(ws: Workspace, line: string): Promise<string> {
  return DEC.decode((await ws.shell(line)).stdout)
}

/** The command a lookup runs in the machine's bash, null for a line the
 * machine runs as it is. */
function bashLine(line: string): string | null {
  const found = /exec \/bin\/bash -c ('[^']*'|\S+); fi/.exec(line)
  if (found === null) return null
  const quoted = found[1] ?? ''
  return quoted.startsWith("'") ? quoted.slice(1, -1) : quoted
}

/** A machine whose `which` and bash `type`/`command` find each name of
 * `found` at its paths, first first, and whose files are `files`. */
function asking(files: FakeFiles, found: Record<string, string[]>): Answer {
  return (line, data) => {
    const words = (bashLine(line) ?? line).split(/\s+/)
    const command = words[0] ?? ''
    if (!['which', 'type', 'command'].includes(command)) return files.answer(line, data)
    const letters = words[1]?.startsWith('-') === true ? words[1].slice(1) : ''
    const name = words[words.length - 1] ?? ''
    let paths = found[name] ?? []
    if (paths.length === 0) return failed('', 1)
    if (!letters.includes('a')) paths = paths.slice(0, 1)
    let text: string
    if (command === 'type' && letters.includes('t')) text = 'file\n'.repeat(paths.length)
    else if (
      (command === 'type' && !/[pP]/.test(letters)) ||
      (command === 'command' && letters.includes('V'))
    )
      text = paths.map((path) => `${name} is ${path}\n`).join('')
    else text = paths.map((path) => `${path}\n`).join('')
    return ok(text)
  }
}

function lookedUp(machine: ScriptedMachine): string[] {
  return machine.lines.filter((line) => line.startsWith('which ') || bashLine(line) !== null)
}

function lookupWs(
  found: Record<string, string[]>,
  captures: readonly string[] | null = null,
  files: FakeFiles = new FakeFiles(),
): [Workspace, ScriptedMachine] {
  const dev = new ScriptedMachine('dev', asking(files, found))
  if (captures !== null) captured(dev, captures)
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, ...on(dev) })
  return [ws, dev]
}

/** A machine that keeps the environment each lookup ran in. */
class Exported extends ScriptedMachine {
  readonly envs: Record<string, string>[] = []

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    if ((argv[argv.length - 1] ?? '').startsWith('which ')) this.envs.push({ ...env, cwd })
    return super.execArgv(argv, stdin, env, cwd, output, errors)
  }
}

/** A machine that reports a program it has no file for in the words the run
 * hands its wrapper (`PROGRAM_CHECK`), with status 127. */
class Reporting extends ScriptedMachine {
  constructor(
    name: string,
    answer: Answer,
    private readonly installed: ReadonlySet<string>,
  ) {
    super(name, answer)
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    if (isRun(argv) && !this.installed.has(argv[RUN_PROGRAM_AT] ?? '')) {
      await errors(new TextEncoder().encode(`${argv[5] ?? ''}${argv[6] ?? ''}\n`))
      return { exitCode: 127 }
    }
    return super.execArgv(argv, stdin, env, cwd, output, errors)
  }
}

describe('program lookups', () => {
  it('asks the machine that runs a name Mirage lacks', async () => {
    const [ws, dev] = lookupWs({ perl: ['/usr/bin/perl', '/bin/perl'] })
    expect(await out(ws, 'which perl')).toBe('/usr/bin/perl\n')
    expect(await out(ws, 'type perl')).toBe('perl is /usr/bin/perl\n')
    expect(await out(ws, 'type -t perl')).toBe('file\n')
    expect(await out(ws, 'command -v perl')).toBe('/usr/bin/perl\n')
    expect(await out(ws, 'command -V perl')).toBe('perl is /usr/bin/perl\n')
    // Without the machine's disk in Mirage, both of its paths run perl by
    // name, through the one /usr/bin file.
    expect(await out(ws, 'type -a perl')).toBe('perl is /usr/bin/perl\n')
    expect(lookedUp(dev)[0]).toBe('which perl')
    expect(lookedUp(dev)[1]).toContain("exec /bin/bash -c 'type perl'")
    await ws.close()
  })

  it('answers a name Mirage runs itself and asks no machine', async () => {
    const [ws, dev] = lookupWs({ grep: ['/usr/bin/grep'] })
    expect(await out(ws, 'which grep')).toBe('/usr/bin/grep\n')
    expect(await out(ws, 'type cd')).toBe('cd is a shell builtin\n')
    expect(lookedUp(dev)).toEqual([])
    await ws.close()
  })

  it('finds no name the machine lacks', async () => {
    const [ws] = lookupWs({})
    const which = await ws.shell('which nosuch')
    expect([DEC.decode(which.stdout), which.exitCode]).toEqual(['', 1])
    const typed = await ws.shell('type nosuch')
    expect(typed.exitCode).toBe(1)
    expect(DEC.decode(typed.stderr)).toBe('bash: line 1: type: nosuch: not found\n')
    await ws.close()
  })

  it('lets a function shadow the machine for type but not for which', async () => {
    const [ws, dev] = lookupWs({ perl: ['/usr/bin/perl'] })
    await ws.shell('perl() { :; }')
    expect(await out(ws, 'type -t perl')).toBe('function\n')
    expect(lookedUp(dev)).toEqual([])
    expect(await out(ws, 'which perl')).toBe('/usr/bin/perl\n')
    expect(await out(ws, 'type -P perl')).toBe('/usr/bin/perl\n')
    expect(await out(ws, 'type -at perl')).toBe('function\nfile\n')
    expect(await out(ws, 'type -f perl')).toBe('perl is /usr/bin/perl\n')
    await ws.close()
  })

  it("asks nothing of a machine that refuses the session's runs", async () => {
    const [ws, dev] = lookupWs({ perl: ['/usr/bin/perl'] })
    ws.createSession('restricted', { profile: { paths: { hide: ['/data/secret'] } } })
    const which = await ws.shell('which perl', { sessionId: 'restricted' })
    expect([DEC.decode(which.stdout), which.exitCode]).toEqual(['', 1])
    expect((await ws.shell('perl -v', { sessionId: 'restricted' })).exitCode).toBe(126)
    expect(lookedUp(dev)).toEqual([])
    await ws.close()
  })

  it('hands the machine a name with a leading dash after --', async () => {
    const [ws, dev] = lookupWs({ '-tool': ['/usr/local/bin/-tool'] })
    expect(await out(ws, 'which -- -tool')).toBe('/usr/bin/-tool\n')
    expect(await out(ws, 'type -t -- -tool')).toBe('file\n')
    expect(lookedUp(dev)[0]).toBe('which -- -tool')
    expect(lookedUp(dev)[1]).toContain("bash -c 'type -t -- -tool'; fi")
    expect(lookedUp(dev)[1]).toMatch(/exec \/bin\/sh -c 'type -t -tool'$/)
    await ws.close()
  })

  it('runs a lookup in the environment a program run gets', async () => {
    const dev = new Exported('dev', asking(new FakeFiles(), { tool: ['/opt/tools/tool'] }))
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, ...on(dev) })
    await ws.shell('export PATH=/opt/tools:$PATH TOOLS=on')
    expect(await out(ws, 'which tool')).toBe('/usr/bin/tool\n')
    const seen = dev.envs[0] ?? {}
    expect(seen.PATH?.startsWith('/opt/tools:')).toBe(true)
    expect([seen.TOOLS, seen.cwd]).toEqual(['on', '/'])
    await ws.close()
  })

  it('finds a name whose machine answer prints nothing', async () => {
    const files = new FakeFiles()
    const dev = new ScriptedMachine('dev', (line, data) =>
      bashLine(line) === 'type -p kill' ? ok('') : files.answer(line, data),
    )
    captured(dev, ['kill', '@external'])
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, ...on(dev) })
    const io = await ws.shell('type -p kill')
    expect([DEC.decode(io.stdout), io.exitCode]).toEqual(['', 0])
    await ws.close()
  })

  it('asks no machine when none would run the name', async () => {
    const [ws, dev] = lookupWs({ perl: ['/usr/bin/perl'] }, ['@python'])
    const which = await ws.shell('which perl')
    expect([DEC.decode(which.stdout), which.exitCode]).toEqual(['', 1])
    expect(lookedUp(dev)).toEqual([])
    await ws.close()
  })

  it("keeps a path shown as the machine's own and runs any other by name", async () => {
    const files = new FakeFiles({ '/tmp/bin/tool': '\x7fELF' })
    const [ws] = lookupWs(
      { tool: ['/tmp/bin/tool'], ldconfig: ['/usr/sbin/ldconfig'] },
      null,
      files,
    )
    expect(await out(ws, 'which tool')).toBe('/tmp/bin/tool\n')
    expect(await out(ws, 'which ldconfig')).toBe('/usr/bin/ldconfig\n')
    expect(await out(ws, 'type ldconfig')).toBe('ldconfig is /usr/bin/ldconfig\n')
    expect(await out(ws, '$(which ldconfig) -p')).toBe('ran\n')
    expect(files.ran[files.ran.length - 1]).toBe('ldconfig -p')
    await ws.close()
  })

  it.each([
    ['env nosuch', "env: 'nosuch': No such file or directory\n", 127],
    ['(exec nosuch)', 'bash: line 1: exec: nosuch: not found\n', 127],
    ['xargs nosuch </dev/null', 'xargs: nosuch: No such file or directory\n', 127],
    [
      'timeout 5 nosuch',
      "timeout: failed to run command 'nosuch': No such file or directory\n",
      127,
    ],
  ])(
    "reports a program the machine lacks in its runner's words: %j",
    async (line, said, status) => {
      const dev = new Reporting('dev', new FakeFiles().answer, new Set())
      const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, ...on(dev) })
      const io = await ws.shell(line)
      expect([DEC.decode(io.stderr), io.exitCode]).toEqual([said, status])
      await ws.close()
    },
  )

  it('counts a program that ran and exited 127 as a failed xargs command', async () => {
    const dev = new Reporting('dev', () => failed('', 127), new Set(['tool']))
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, ...on(dev) })
    const io = await ws.shell('echo x | xargs tool')
    expect(io.exitCode).toBe(123)
    const nested = await ws.shell('echo x | xargs xargs nosuch')
    expect([DEC.decode(nested.stderr), nested.exitCode]).toEqual([
      'xargs: nosuch: No such file or directory\n',
      123,
    ])
    await ws.close()
  })

  it('lets a machine that captures which answer every which', async () => {
    const [ws, dev] = lookupWs({ grep: ['/bin/grep'] }, ['which', '@external'])
    expect(await out(ws, 'which grep')).toBe('/bin/grep\n')
    expect(dev.lines).toContain('which grep')
    await ws.close()
  })
})
