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
import { ScriptedMachine, failed } from '../../../../tests/fixtures/machine.ts'
import { FakeFiles, two } from '../../../../tests/fixtures/machine_files.ts'
import type { Action, CommandContext, Route } from '../../../policy/types.ts'
import type { RunAnswer } from '../../../runtime/types.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

/** A machine that cannot be reached. */
class Down extends ScriptedMachine {
  override connect(): Promise<void> {
    return Promise.reject(new Error('unreachable'))
  }
}

/** A machine that is served the session's restricted view. */
class Serving extends ScriptedMachine {
  override servesSession(): boolean {
    return true
  }
}

describe('searchedMachine', () => {
  it('runs a program only a later machine has there', async () => {
    const a = new FakeFiles({}, ['both'])
    const b = new FakeFiles({}, ['both', 'smi'])
    const ws = two(a, b, { '/data': new RAMVFS() })
    expect((await ws.shell('smi -L')).exitCode).toBe(0)
    expect((await ws.shell('both')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([['both'], ['smi -L']])
    await ws.close()
  })

  it('leaves a program no machine has to the first', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const ws = two(a, b)
    await ws.shell('nowhere')
    expect([a.ran, b.ran]).toEqual([['nowhere'], []])
    await ws.close()
  })

  it('runs the program on a named machine whoever has it', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    await ws.shell('smi', { machine: 'a' })
    expect([a.ran, b.ran]).toEqual([['smi'], []])
    await ws.close()
  })

  it('runs a program both have where the folder is', async () => {
    const a = new FakeFiles({ '/tmp/both/k': 'k' }, ['py'])
    const b = new FakeFiles({ '/srv/k': 'k', '/tmp/only/k': 'k', '/tmp/both/k': 'k' }, ['py'])
    const ws = two(a, b, { '/srv': '@b' })
    await ws.shell('cd /srv && py one')
    await ws.shell('cd /tmp/only && py two')
    await ws.shell('cd /tmp/both && py three')
    expect([a.ran, b.ran]).toEqual([['py three'], ['py one', 'py two']])
    await ws.close()
  })

  it('runs a program both have where the path it names is', async () => {
    const a = new FakeFiles({ '/tmp/both.py': 'a' }, ['py'])
    const b = new FakeFiles({ '/srv/job.py': 'j', '/tmp/only.py': 'o', '/tmp/both.py': 'b' }, [
      'py',
    ])
    const ws = two(a, b, { '/srv': '@b', '/data': new RAMVFS() })
    await ws.shell('cd /data && py /srv/job.py')
    await ws.shell('py /tmp/only.py')
    await ws.shell('py /tmp/both.py')
    await ws.shell('py /tmp/new.py')
    expect(a.ran).toEqual(['py /tmp/both.py', 'py /tmp/new.py'])
    expect(b.ran).toEqual(['py /srv/job.py', 'py /tmp/only.py'])
    await ws.close()
  })

  it('lets the folder decide before the path', async () => {
    const a = new FakeFiles({ '/srv/a/k': 'k' }, ['py'])
    const b = new FakeFiles({ '/srv/b/job.py': 'j' }, ['py'])
    const ws = two(a, b, { '/srv/a': '@a', '/srv/b': '@b' })
    await ws.shell('cd /srv/a && py /srv/b/job.py')
    expect([a.ran, b.ran]).toEqual([['py /srv/b/job.py'], []])
    await ws.close()
  })

  it("leaves a program its folder's machine lacks to another", async () => {
    const a = new FakeFiles({ '/srv/k': 'k' })
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b, { '/srv': '@a' })
    await ws.shell('cd /srv && smi')
    expect([a.ran, b.ran]).toEqual([[], ['smi']])
    await ws.close()
  })

  it("lands a program's redirect on the machine search picked", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    expect((await ws.shell('smi > /tmp/out')).exitCode).toBe(0)
    expect([a.files.has('/tmp/out'), b.files.has('/tmp/out')]).toEqual([false, true])
    await ws.close()
  })

  it("writes on its machine what reads a searched program's pipe", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    expect((await ws.shell('smi | tee /tmp/piped')).exitCode).toBe(0)
    expect((await ws.shell('nice smi | tee /tmp/wrapped')).exitCode).toBe(0)
    expect([...b.files.keys()].sort()).toEqual(['/tmp/piped', '/tmp/wrapped'])
    expect(a.files.size).toBe(0)
    await ws.close()
  })

  it('searches for a wrapped program too', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    expect((await ws.shell('nice smi > /tmp/out')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([[], ['nice smi']])
    expect([a.files.has('/tmp/out'), b.files.has('/tmp/out')]).toEqual([false, true])
    await ws.close()
  })

  it('asks the machine search order picks for a lookup', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    await ws.shell('which smi')
    expect([a.ran, b.ran]).toEqual([[], ['which smi']])
    await ws.close()
  })

  it('runs it on the first machine with it under a file policy', async () => {
    const a = new FakeFiles({}, ['py'])
    const b = new FakeFiles({ '/tmp/only.py': 'o' }, ['py', 'smi'])
    const ws = two(a, b)
    ws.policies.add({ preVfs: (): Action | null => null })
    await ws.shell('py /tmp/only.py')
    await ws.shell('smi')
    expect([a.ran, b.ran]).toEqual([['py /tmp/only.py'], ['smi']])
    await ws.close()
  })

  it('finds a program installed since the last look', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const ws = two(a, b)
    await ws.shell('tool')
    b.programs.add('tool')
    await ws.shell('tool')
    expect([a.ran, b.ran]).toEqual([['tool'], ['tool']])
    await ws.close()
  })

  it('looks for a program on the PATH the session set', async () => {
    const second = new ScriptedMachine('b', new FakeFiles({}, ['smi']).answer)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', new FakeFiles().answer), b: second },
      },
    )
    await ws.shell('export PATH=/opt/mr:/usr/bin; smi')
    expect(second.lines).toEqual(["PATH='/opt/mr:/usr/bin' command -v smi >/dev/null 2>&1", 'smi'])
    await ws.close()
  })

  it('asks one machine nothing before it runs a program', async () => {
    const machine = new ScriptedMachine('a', new FakeFiles().answer)
    const ws = new Workspace({}, { mode: MountMode.WRITE, machines: { a: machine } })
    await ws.shell('smi')
    expect(machine.lines).toEqual(['smi'])
    await ws.close()
  })

  it.each(['a', 'b'])('keeps no program off another when %s is down', async (down) => {
    const files = new FakeFiles({}, ['smi'])
    const machines = Object.fromEntries(
      ['a', 'b'].map((name) => [
        name,
        name === down
          ? new Down(name, new FakeFiles().answer)
          : new ScriptedMachine(name, files.answer),
      ]),
    )
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, machines })
    await ws.shell('cd /data && smi')
    expect(files.ran).toEqual(['smi'])
    await ws.close()
  })

  it("places a pipe's writer by the paths it names", async () => {
    const a = new FakeFiles({}, ['py'])
    const b = new FakeFiles({ '/srv/job.py': 'j' }, ['py'])
    const ws = two(a, b, { '/srv': '@b' })
    expect((await ws.shell('py /srv/job.py | tee /tmp/piped')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([[], ['py /srv/job.py']])
    expect([a.files.has('/tmp/piped'), b.files.has('/tmp/piped')]).toEqual([false, true])
    await ws.close()
  })

  it('looks for a program on the PATH its own prefix sets', async () => {
    const second = new ScriptedMachine('b', new FakeFiles({}, ['smi']).answer)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', new FakeFiles().answer), b: second },
      },
    )
    await ws.shell('PATH=/opt/bin smi')
    expect(second.lines).toEqual(['PATH=/opt/bin command -v smi >/dev/null 2>&1', 'smi'])
    await ws.close()
  })

  it('looks again for a program removed since the last look', async () => {
    const a = new FakeFiles({}, ['tool'])
    const b = new FakeFiles({}, ['tool'])
    const first = (line: string, data: Uint8Array | null): RunAnswer =>
      line === 'tool' && !a.programs.has('tool')
        ? failed('tool: command not found\n', 127)
        : a.answer(line, data)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', first), b: new ScriptedMachine('b', b.answer) },
      },
    )
    await ws.shell('tool')
    a.programs.delete('tool')
    expect((await ws.shell('tool')).exitCode).toBe(127)
    expect((await ws.shell('tool')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([['tool'], ['tool']])
    await ws.close()
  })

  it('looks on a PATH that leans on the folder from that folder', async () => {
    const files = new FakeFiles({ '/tmp/w/k': 'k' }, ['smi'])
    const second = new ScriptedMachine('b', files.answer)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', new FakeFiles().answer), b: second },
      },
    )
    await ws.shell('cd /tmp/w && PATH=bin:/usr/bin smi')
    const looked = "PATH='bin:/usr/bin' command -v smi >/dev/null 2>&1"
    expect(second.lines).toContain(`cd -- /tmp/w 2>/dev/null && ${looked}`)
    expect(files.ran).toEqual(['smi'])
    await ws.close()
  })

  it('runs the program of a /usr/bin path where search finds it', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['tool'])
    const ws = two(a, b)
    await ws.shell('/usr/bin/tool -x')
    expect([a.ran, b.ran]).toEqual([[], ['tool -x']])
    await ws.close()
  })

  it('asks the machine search picks for a lookup past a function', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['smi'])
    const ws = two(a, b)
    await ws.shell('smi() { :; }; which smi')
    expect([a.ran, b.ran]).toEqual([[], ['which smi']])
    await ws.close()
  })

  it('lets a route that comes with the redirect decide over the search', async () => {
    const a = new FakeFiles({}, ['tool'])
    const b = new FakeFiles({}, ['tool'])
    const ws = two(a, b)
    ws.policies.add({
      preCommand: (ctx: CommandContext): Route | null =>
        ctx.paths.some((path) => path.virtual === '/tmp/out')
          ? { kind: 'route', machine: 'b' }
          : null,
    })
    await ws.shell('tool')
    await ws.shell('tool > /tmp/out')
    expect([a.ran, b.ran]).toEqual([['tool'], ['tool']])
    await ws.close()
  })

  it('does not hide who holds a path when a machine is down', async () => {
    const a = new FakeFiles({}, ['smi'])
    const b = new FakeFiles({ '/tmp/only.txt': 'o' }, ['smi'])
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: {
          a: new ScriptedMachine('a', a.answer),
          b: new ScriptedMachine('b', b.answer),
          c: new Down('c', new FakeFiles().answer),
        },
      },
    )
    await ws.shell('smi /tmp/only.txt')
    expect([a.ran, b.ran]).toEqual([[], ['smi /tmp/only.txt']])
    await ws.close()
  })

  it('searches the PATH a prefix sets through a reference', async () => {
    const second = new ScriptedMachine('b', new FakeFiles({}, ['smi']).answer)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', new FakeFiles().answer), b: second },
      },
    )
    await ws.shell('declare -n P=PATH; P=/opt/bin smi')
    expect(second.lines).toEqual(['PATH=/opt/bin command -v smi >/dev/null 2>&1', 'smi'])
    await ws.close()
  })

  it('takes a machine that refuses the session as no candidate', async () => {
    const a = new FakeFiles()
    const second = new ScriptedMachine('b', new FakeFiles({}, ['smi']).answer)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new Serving('a', a.answer), b: second },
        profiles: { agent: { paths: { hide: ['/tmp/secret'] } } },
      },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    await agent.shell('smi')
    expect([a.ran, second.lines]).toEqual([['smi'], []])
    await ws.close()
  })

  it('searches for a /usr/bin path past a function of its name', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({}, ['tool'])
    const ws = two(a, b)
    await ws.shell('tool() { :; }; /usr/bin/tool -x')
    expect([a.ran, b.ran]).toEqual([[], ['tool -x']])
    await ws.close()
  })

  it('does not hide who holds a path under a hide when a machine is down', async () => {
    const a = new FakeFiles({}, ['smi'])
    const b = new FakeFiles({ '/tmp/only.txt': 'o' }, ['smi'])
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: {
          a: new Serving('a', a.answer),
          b: new Serving('b', b.answer),
          c: new Down('c', new FakeFiles().answer),
        },
        profiles: { agent: { paths: { hide: ['/tmp/secret'] } } },
      },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    await agent.shell('smi /tmp/only.txt')
    expect([a.ran, b.ran]).toEqual([[], ['smi /tmp/only.txt']])
    await ws.close()
  })
})

describe('a pipe', () => {
  it("runs the program reading it on its writer's machine", async () => {
    const a = new FakeFiles({}, ['both'])
    const b = new FakeFiles({}, ['gen', 'both'])
    const ws = two(a, b)
    expect((await ws.shell('gen | both')).exitCode).toBe(0)
    expect((await ws.shell('both')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([['both'], ['gen', 'both']])
    await ws.close()
  })
})

describe('a middle stage', () => {
  it('is placed where its own writer put it', async () => {
    const a = new FakeFiles({}, ['filter'])
    const b = new FakeFiles({}, ['gen', 'filter', 'sink'])
    const ws = two(a, b)
    expect((await ws.shell('gen | filter | sink')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([[], ['gen', 'filter', 'sink']])
    await ws.close()
  })

  it('refuses a reader only another machine has', async () => {
    const a = new FakeFiles({}, ['sink'])
    const b = new FakeFiles({}, ['gen', 'filter'])
    const ws = two(a, b)
    const done = await ws.shell('gen | filter | sink')
    expect(done.exitCode).toBe(126)
    expect(new TextDecoder().decode(done.stderr)).toBe('sink: Permission denied\n')
    expect(a.ran).toEqual([])
    await ws.close()
  })
})
