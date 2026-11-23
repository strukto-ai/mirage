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
import { ScriptedMachine } from '../../../../tests/fixtures/machine.ts'
import { FakeFiles, TOOLS, one, out, two } from '../../../../tests/fixtures/machine_files.ts'
import { SessionProfile } from '../../../policy/profile.ts'
import type { Action, CommandContext } from '../../../policy/types.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const DEC = new TextDecoder()

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

  it.each([
    'tar -xf /tmp/a.tar',
    'find /tmp -exec cat a.py \\;',
    'wc -l /tmp/a.py',
    'grep -r -f /tmp/a.py',
  ])("runs %j, which may use its folder, only from the machine's", async (line) => {
    const files = new FakeFiles({ '/tmp/a.py': 'x', '/tmp/a.tar': 'x' }, [...TOOLS, 'find', 'tar'])
    const ws = one(files, { '/data': new RAMVFS() })
    await ws.shell(`cd /data && ${line}`)
    const name = line.split(' ')[0]
    expect(files.ran.filter((r) => r.split(' ')[0] === name)).toEqual([])
    await ws.close()
  })

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
    expect(await placed('grep -r -f /tmp/a.py')).toEqual([['grep', '']])
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

  it('runs a program named by a path the machine holds there', async () => {
    const files = new FakeFiles({ '/tmp/venv/bin/python': '\x7fELF\x00' })
    const ws = one(files)
    expect(await out(ws, 'cd /tmp && venv/bin/python -V')).toBe('ran\n')
    expect(await out(ws, '/tmp/venv/bin/python -V')).toBe('ran\n')
    expect(files.ran).toEqual(['venv/bin/python -V', '/tmp/venv/bin/python -V'])
    await ws.close()
  })

  // The machine runs its own /tmp/ls or /tmp/perl, so a closed tree refuses the
  // path as it refuses one no machine holds, and a deny of the program's name
  // refuses it by that name.

  it.each([
    [{ '*': 'deny', ls: 'allow' }, '/tmp/ls'],
    [{ perl: 'deny' }, '/tmp/perl -e 1'],
  ] as const)('refuses a program the machine holds under %j', async (commands, line) => {
    const files = new FakeFiles({ '/tmp/ls': '\x7fELF\x00', '/tmp/perl': '\x7fELF\x00' })
    const ws = one(files, {}, { profiles: { agent: SessionProfile({ commands }) } })
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell(line)).exitCode).toBe(126)
    expect(files.ran).toEqual([])
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

  it('runs a program file two machines hold by search order', async () => {
    const a = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF', '/srv/k': 'k', '/tmp/in': 'i' })
    const ws = two(a, b, { '/srv': '@b' })
    expect((await ws.shell('/tmp/tool first')).exitCode).toBe(0)
    await ws.shell('/tmp/tool named', { machine: 'b' })
    await ws.shell('cd /srv && /tmp/tool folder')
    await ws.shell('/tmp/tool /tmp/in')
    expect(a.ran).toEqual(['/tmp/tool first'])
    expect(b.ran).toEqual(['/tmp/tool named', '/tmp/tool folder', '/tmp/tool /tmp/in'])
    await ws.close()
  })

  it('runs a program file one machine holds there whoever is named', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b)
    await ws.shell('/tmp/tool', { machine: 'a' })
    expect([a.ran, b.ran]).toEqual([[], ['/tmp/tool']])
    await ws.close()
  })
})
