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
} from '../../../tests/fixtures/machine.ts'
import { FakeFiles } from '../../../tests/fixtures/machine_files.ts'
import type { ByteSource } from '../../io/types.ts'
import { RUN_PROGRAM_AT, isRun } from '../../machine/constants.ts'
import type { OutputFn, RunResult } from '../../runtime/types.ts'
import type { Action, CommandContext, VfsContext } from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { MountSpec, WorkspaceOptions } from '../workspace/types.ts'
import { Workspace } from '../workspace/workspace.ts'

const TOOLS = ['ls', 'cat', 'grep', 'wc']
const DEC = new TextDecoder()

function one(
  files: FakeFiles,
  mounts: Record<string, MountSpec> = {},
  options: WorkspaceOptions = {},
): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
    machines: { box: new ScriptedMachine('box', files.answer) },
    ...options,
  })
}

async function out(ws: Workspace, line: string): Promise<string> {
  return DEC.decode((await ws.shell(line)).stdout)
}

describe('operand routing', () => {
  it("runs a command on the machine's paths there whole", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files)
    expect(await out(ws, 'ls -la /tmp')).toBe('ran\n')
    expect(files.ran).toEqual(['ls -la /tmp'])
    await ws.close()
  })

  it('leaves a program the machine lacks to Mirage', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' })
    const ws = one(files)
    expect(await out(ws, 'ls /tmp')).toBe('a.py\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('hands the program the matches of a glob', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x', '/tmp/b.py': 'y', '/tmp/c.txt': 'z' }, TOOLS)
    const ws = one(files)
    await out(ws, 'grep -n x /tmp/*.py')
    expect(files.ran).toEqual(['grep -n x /tmp/a.py /tmp/b.py'])
    await ws.close()
  })

  it.each([
    'cat /tmp/a.py /data/b',
    'cd /data && ls',
    'cd /data && cat ../tmp/a.py',
    'echo hi | wc -l',
    'echo hi | cat /tmp/a.py',
  ])('keeps %j, which reaches past the machine, with Mirage', async (line) => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('echo b > /data/b')
    await ws.shell(line)
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it("runs absolute paths there from / off the machine's folders", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const box = new ScriptedMachine('box', files.answer)
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, machines: { box } },
    )
    expect(await out(ws, 'cd /data && cat /tmp/a.py')).toBe('ran\n')
    expect([files.ran, box.cwds]).toEqual([['cat /tmp/a.py'], ['/']])
    expect(await out(ws, 'cd /tmp && cat /tmp/a.py')).toBe('ran\n')
    expect(box.cwds.at(-1)).toBe('/tmp')
    await ws.close()
  })

  it.each(['tar -xf /tmp/a.tar', 'find /tmp -exec cat a.py \\;', 'wc -l /tmp/a.py'])(
    "runs %j, which may use its folder, only from the machine's",
    async (line) => {
      const files = new FakeFiles({ '/tmp/a.py': 'x', '/tmp/a.tar': 'x' }, [
        ...TOOLS,
        'find',
        'tar',
      ])
      const ws = one(files, { '/data': new RAMVFS() })
      await ws.shell(`cd /data && ${line}`)
      const name = line.split(' ')[0]
      expect(files.ran.filter((r) => r.split(' ')[0] === name)).toEqual([])
      await ws.close()
    },
  )

  it('names in explain the machine the run hands a command to', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('cd /data')
    const placed = async (line: string): Promise<[string, string][]> => {
      const said = await ws.explain(line)
      return said.node.children.flatMap((c) =>
        'command' in c ? [[c.command, c.machine] as [string, string]] : [],
      )
    }
    expect(await placed('cat /tmp/a.py')).toEqual([['cat', 'box']])
    expect(await placed('ls')).toEqual([['ls', '']])
    expect(await placed('cat /tmp/a.py /data/b')).toEqual([['cat', '']])
    expect(await placed('wc -l /tmp/a.py')).toEqual([['wc', '']])
    await ws.shell('cd /tmp')
    expect(await placed('find /tmp -exec cat /tmp/a.py \\;')).toEqual([['find', 'box']])
    expect(await placed('find /tmp -exec cat /data/b \\;')).toEqual([['find', '']])
    await ws.close()
  })

  it('runs a command naming no path from a cwd on the machine', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files)
    expect(await out(ws, 'cd /tmp && ls')).toBe('ran\n')
    expect(files.ran).toEqual(['ls'])
    await ws.close()
  })

  it('keeps a restricted or read-only mount with Mirage', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files, {}, { profiles: { agent: { paths: { hide: ['/tmp/secret'] } } } })
    const agent = await ws.session('agent', { profile: 'agent' })
    expect(DEC.decode((await agent.shell('ls /tmp')).stdout)).toBe('a.py\n')
    await ws.close()
    const readOnly = one(files, {}, { mode: MountMode.READ })
    expect(await out(readOnly, 'ls /tmp')).toBe('a.py\n')
    expect(files.ran).toEqual([])
    await readOnly.close()
  })

  it('runs it on two machines only where one holds every path', async () => {
    const a = new FakeFiles({ '/tmp/a.py': 'x', '/tmp/both': '1' }, TOOLS)
    const b = new FakeFiles({ '/tmp/both': '2' }, TOOLS)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    expect(await out(ws, 'cat /tmp/a.py')).toBe('ran\n')
    expect([a.ran, b.ran]).toEqual([['cat /tmp/a.py'], []])
    const both = await ws.shell('cat /tmp/both')
    expect(both.exitCode).toBe(1)
    expect(DEC.decode(both.stderr)).toContain('on several machines: a, b')
    expect([a.ran, b.ran]).toEqual([['cat /tmp/a.py'], []])
    await ws.close()
  })

  it('runs a program named by a path the machine holds there', async () => {
    const files = new FakeFiles({ '/tmp/venv/bin/python': '\x7fELF\x00' })
    const ws = one(files)
    expect(await out(ws, 'cd /tmp && venv/bin/python -V')).toBe('ran\n')
    expect(await out(ws, '/tmp/venv/bin/python -V')).toBe('ran\n')
    expect(files.ran).toEqual(['venv/bin/python -V', '/tmp/venv/bin/python -V'])
    await ws.close()
  })

  it('keeps a hidden program path with Mirage', async () => {
    const files = new FakeFiles({ '/tmp/secret/run': '\x7fELF\x00' })
    const ws = one(files, {}, { profiles: { agent: { paths: { hide: ['/tmp/secret'] } } } })
    const agent = await ws.session('agent', { profile: 'agent' })
    const done = await agent.shell('/tmp/secret/run')
    expect(done.exitCode).not.toBe(0)
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('leaves a read loop its input', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files)
    const line = "printf 'a\\nb\\n' | while read l; do ls /tmp >/dev/null; echo $l; done"
    expect(await out(ws, line)).toBe('a\nb\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('runs a command reading /dev/null there whole', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x', '/tmp/b.py': 'y' }, TOOLS)
    const ws = one(files)
    expect(await out(ws, 'grep -l x /tmp/a.py < /dev/null')).toBe('ran\n')
    expect(await out(ws, "printf '/tmp/a.py /tmp/b.py' | xargs grep -l x")).toBe('ran\n')
    expect(files.ran).toEqual(['grep -l x /tmp/a.py', 'grep -l x /tmp/a.py /tmp/b.py'])
    await ws.close()
  })

  it("makes and reads a link in the machine's folder there", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, [...TOOLS, 'ln', 'readlink'])
    const ws = one(files)
    await ws.shell('printf x | ln -s a.py /tmp/link')
    await ws.shell('readlink /tmp/link')
    expect(files.ran).toEqual(['ln -s a.py /tmp/link', 'readlink /tmp/link'])
    await ws.close()
  })

  it("keeps a link to another mount Mirage's, read through", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, [...TOOLS, 'ln', 'readlink'])
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('echo b > /data/b && ln -s /data/b /tmp/l')
    expect(await out(ws, 'cat /tmp/l')).toBe('b\n')
    expect(await out(ws, 'readlink /tmp/l')).toBe('/data/b\n')
    expect(await out(ws, 'ls /tmp')).toBe('a.py\nl\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('keeps a command in Mirage while a coded file policy speaks', async () => {
    const files = new FakeFiles({ '/tmp/secret': 's', '/tmp/a.py': 'x' }, TOOLS)
    const ws = one(files)
    ws.policies.add({
      preVfs(ctx: VfsContext): Action | null {
        return ctx.path.virtual.includes('secret') ? { kind: 'deny', reason: 'secret' } : null
      },
    })
    expect((await ws.shell('cat /tmp/secret')).exitCode).not.toBe(0)
    expect(await out(ws, 'cat /tmp/a.py')).toBe('x')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('keeps a glob matching a Mirage link with Mirage', async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, [...TOOLS, 'ln'])
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('echo y > /data/y && ln -s /data/y /tmp/l')
    expect(await out(ws, 'cat /tmp/*')).toBe('xy\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('never reaches a machine for a refused command', async () => {
    const a = new ScriptedMachine('a', new FakeFiles({ '/tmp/x': 'x' }, TOOLS).answer)
    const b = new ScriptedMachine('b', new FakeFiles({}, TOOLS).answer)
    const ws = new Workspace({}, { mode: MountMode.WRITE, machines: { a, b } })
    ws.policies.add({
      preCommand(ctx: CommandContext): Action | null {
        return ctx.command === 'cat' ? { kind: 'deny', reason: 'no cat' } : null
      },
    })
    const before = [a.lines.length, b.lines.length]
    const done = await ws.shell('cat /tmp/x > /dev/null')
    expect(done.exitCode).toBe(126)
    expect([a.lines.length, b.lines.length]).toEqual(before)
    await ws.close()
  })

  it("keeps an option naming another mount's file with Mirage", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x\n' }, TOOLS)
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('echo x > /data/p')
    expect(await out(ws, 'grep -f /data/p /tmp/a.py')).toBe('x\n')
    expect(await out(ws, 'grep --file=/data/p /tmp/a.py')).toBe('x\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })

  it('reads a machine link to a hidden name as missing', async () => {
    const files = new FakeFiles({ '/tmp/secret': 's', '/tmp/a.py': 'x' }, TOOLS)
    files.links.set('/tmp/public', '/tmp/secret')
    const ws = one(files, {}, { profiles: { agent: { paths: { hide: ['/tmp/secret'] } } } })
    const agent = await ws.session('agent', { profile: 'agent' })
    const done = await agent.shell('cat /tmp/public')
    expect([done.exitCode, DEC.decode(done.stdout)]).toEqual([1, ''])
    expect(DEC.decode((await agent.shell('cat /tmp/a.py')).stdout)).toBe('x')
    expect(await out(ws, 'cat /tmp/public')).toBe('ran\n')
    await ws.close()
  })

  it("keeps a find -exec naming another mount's file with Mirage", async () => {
    const files = new FakeFiles({ '/tmp/d/f': 'x' }, [...TOOLS, 'find'])
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell('echo y > /data/x')
    expect(await out(ws, 'find /tmp/d -maxdepth 0 -exec cat /data/x \\;')).toBe('y\n')
    expect(files.ran).toEqual([])
    await ws.close()
  })
})

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
