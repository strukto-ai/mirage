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
import { FakeFiles } from '../../../../tests/fixtures/machine_files.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { MountSpec, WorkspaceOptions } from '../../workspace/types.ts'
import { Workspace } from '../../workspace/workspace.ts'

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

describe('link routing', () => {
  it("makes and reads a link in the machine's folder there", async () => {
    const files = new FakeFiles({ '/tmp/a.py': 'x' }, [...TOOLS, 'ln', 'readlink'])
    const ws = one(files)
    await ws.shell('printf x | ln -s a.py /tmp/link')
    await ws.shell('readlink /tmp/link')
    expect(files.ran).toEqual(['ln -s a.py /tmp/link', 'readlink /tmp/link'])
    await ws.close()
  })

  it('makes a link in a folder both machines hold on a machine', async () => {
    const a = new FakeFiles({ '/tmp/a.py': 'x' }, ['ln'])
    const b = new FakeFiles({ '/tmp/d/t': 't' }, ['ln'])
    const first = new ScriptedMachine('a', a.answer)
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        machines: { a: first, b: new ScriptedMachine('b', b.answer) },
      },
    )
    await ws.shell('ln -s /tmp/a.py /tmp/link')
    await ws.shell('ln -s /tmp/d/t /tmp/d/link')
    await ws.shell('ln -s /tmp/a.py /tmp/named', { machine: 'b' })
    await ws.shell('ln -s /tmp/nowhere /tmp/dangling', { machine: 'b' })
    await ws.shell('cd /tmp && ln -s a.py beside')
    expect(first.cwds.at(-1)).toBe('/tmp')
    await ws.shell('cd /data && ln -s /tmp/a.py /tmp/from-store')
    expect(first.cwds.at(-1)).toBe('/')
    await ws.shell('cd /data && ln -s /tmp/a.py ../tmp/typed-relative')
    expect(a.ran).toEqual([
      'ln -s /tmp/a.py /tmp/link',
      'ln -s /tmp/a.py /tmp/named',
      'ln -s a.py beside',
      'ln -s /tmp/a.py /tmp/from-store',
    ])
    expect(b.ran).toEqual(['ln -s /tmp/d/t /tmp/d/link', 'ln -s /tmp/nowhere /tmp/dangling'])
    expect(await out(ws, 'readlink /tmp/typed-relative')).toBe('/tmp/a.py\n')
    await ws.close()
  })

  it("keeps a link Mirage's that another machine would break", async () => {
    const a = new FakeFiles({ '/tmp/only/kept': 'k', '/tmp/existing': 'e' }, ['ln'])
    const b = new FakeFiles({ '/tmp/target': 't' }, ['ln'])
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    await ws.shell('ln -s /tmp/target /tmp/only/link')
    expect(await out(ws, 'readlink /tmp/only/link')).toBe('/tmp/target\n')
    const taken = await ws.shell('ln -sT /tmp/target /tmp/existing')
    expect(taken.exitCode).toBe(1)
    expect(new TextDecoder().decode(taken.stderr)).toContain('File exists')
    expect([a.ran, b.ran]).toEqual([[], []])
    await ws.close()
  })

  it("makes a hard link into one machine's folder there", async () => {
    const a = new FakeFiles({ '/tmp/t': 'old' }, ['ln'])
    const b = new FakeFiles({ '/tmp/t': 't', '/srv/kept': 'k' }, ['ln'])
    const ws = new Workspace(
      { '/srv': '@b' },
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    b.answer('cat > /tmp/t', new TextEncoder().encode('newer'))
    expect((await ws.shell('ln /tmp/t /srv/link')).exitCode).toBe(0)
    expect([a.ran, b.ran]).toEqual([[], ['ln /tmp/t /srv/link']])
    await ws.close()
  })

  it('makes a link below a file shown over a folder nowhere', async () => {
    const a = new FakeFiles({ '/tmp/d/kept': 'k', '/tmp/t': 't' }, ['ln'])
    const b = new FakeFiles({ '/tmp/d': 'file' }, ['ln'])
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    b.answer('cat > /tmp/d', new TextEncoder().encode('newer'))
    const made = await ws.shell('ln -s /tmp/t /tmp/d/link')
    expect(made.exitCode).toBe(1)
    expect([a.ran, b.ran]).toEqual([[], []])
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
