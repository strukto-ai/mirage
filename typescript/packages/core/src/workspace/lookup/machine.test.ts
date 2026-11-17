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
import { ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { FakeFiles } from '../../../tests/fixtures/machine_files.ts'
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
    'cd /data && cat /tmp/a.py',
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
})
