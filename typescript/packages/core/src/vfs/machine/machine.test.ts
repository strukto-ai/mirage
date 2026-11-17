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
import type { MountSpec } from '../../workspace/workspace/types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { MachineVFS } from './machine.ts'

const DEC = new TextDecoder()

function two(
  a: FakeFiles,
  b: FakeFiles,
  mounts: Record<string, MountSpec | string> = {},
): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
    machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
  })
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const result = await ws.shell(line)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

function texts(files: FakeFiles): Record<string, string> {
  return Object.fromEntries([...files.files].map(([k, v]) => [k, DEC.decode(v)]))
}

describe('MachineVFS', () => {
  it("lands a heredoc in the machine's own /tmp", async () => {
    const a = new FakeFiles()
    const ws = new Workspace(
      {},
      { mode: MountMode.WRITE, machines: { a: new ScriptedMachine('a', a.answer) } },
    )
    expect(await run(ws, "cat > /tmp/fix.py << 'EOF'\nprint(1)\nEOF")).toEqual([0, '', ''])
    expect(texts(a)['/tmp/fix.py']).toBe('print(1)\n')
    expect(await run(ws, 'cat /tmp/fix.py')).toEqual([0, 'print(1)\n', ''])
    await ws.close()
  })

  it('merges a listing across both machines', async () => {
    const ws = two(
      new FakeFiles({ '/tmp/out.csv': '1' }),
      new FakeFiles({ '/tmp/model.bin': '22', '/tmp/out.csv': '1' }),
    )
    expect(await run(ws, 'ls /tmp')).toEqual([0, 'model.bin\nout.csv\n', ''])
    await ws.close()
  })

  it('refuses a name on both machines as ambiguous', async () => {
    const ws = two(new FakeFiles({ '/tmp/x': 'a' }), new FakeFiles({ '/tmp/x': 'b' }))
    const [code, , err] = await run(ws, 'cat /tmp/x')
    expect(code).toBe(1)
    expect(err).toContain('on several machines: a, b')
    await ws.close()
  })

  it("keeps mv on the source's machine", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/m': 'm' })
    const ws = two(a, b)
    expect((await run(ws, 'mv /tmp/m /tmp/n'))[0]).toBe(0)
    expect([texts(b), texts(a)]).toEqual([{ '/tmp/n': 'm' }, {}])
    await ws.close()
  })

  it("replaces another machine's name on mv", async () => {
    const a = new FakeFiles({ '/tmp/src': 'new' })
    const b = new FakeFiles({ '/tmp/dst': 'old' })
    const ws = two(a, b)
    expect((await run(ws, 'mv /tmp/src /tmp/dst'))[0]).toBe(0)
    expect([texts(a), texts(b)]).toEqual([{ '/tmp/dst': 'new' }, {}])
    expect(await run(ws, 'cat /tmp/dst')).toEqual([0, 'new', ''])
    await ws.close()
  })

  it("keeps another machine's folder when a mv fails", async () => {
    const a = new FakeFiles({ '/tmp/src/f': 'x' })
    const b = new FakeFiles()
    b.dirs.add('/tmp/dst')
    const ws = two(a, b)
    expect((await run(ws, 'mv -T /tmp/src /tmp/dst'))[0]).toBe(1)
    expect(b.dirs.has('/tmp/dst')).toBe(true)
    await ws.close()
  })

  it("lists a folder under another machine's file", async () => {
    const ws = two(new FakeFiles({ '/tmp/d/sub/g': 'y' }), new FakeFiles({ '/tmp/d': 'f' }))
    expect(await run(ws, 'ls /tmp/d/sub')).toEqual([0, 'g\n', ''])
    await ws.close()
  })

  it("lands a program's output on the machine running it", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b)
    expect((await run(ws, '/tmp/tool > /tmp/new'))[0]).toBe(0)
    expect([texts(b)['/tmp/new'], '/tmp/new' in texts(a)]).toEqual(['ran\n', false])
    await ws.close()
  })

  it('moves the bytes through Mirage for a cp onto another machine', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/src': 'payload' })
    const ws = two(a, b)
    expect((await run(ws, 'cp /tmp/src /tmp/dst'))[0]).toBe(0)
    expect(texts(a)).toEqual({ '/tmp/dst': 'payload' })
    expect(texts(b)).toEqual({ '/tmp/src': 'payload' })
    await ws.close()
  })

  it('removes a directory on every machine with rm -r', async () => {
    const a = new FakeFiles({ '/tmp/d/x': '1' })
    const b = new FakeFiles({ '/tmp/d/y': '2' })
    const ws = two(a, b)
    expect((await run(ws, 'rm -r /tmp/d'))[0]).toBe(0)
    expect(a.dirs.has('/tmp/d') || b.dirs.has('/tmp/d')).toBe(false)
    await ws.close()
  })

  it("shows the machines' files at the same path for @local", async () => {
    const ws = two(new FakeFiles({ '/srv/app/main.py': 'x' }), new FakeFiles(), {
      '/srv': '@local',
    })
    expect(await run(ws, 'ls /srv/app')).toEqual([0, 'main.py\n', ''])
    await ws.close()
  })

  it("mounts a machine's tree at another prefix", async () => {
    const vfs = new MachineVFS({ machines: ['a'], root: '/srv' })
    const ws = two(new FakeFiles({ '/srv/app/main.py': 'x' }), new FakeFiles(), { '/box': vfs })
    expect(await run(ws, 'cat /box/app/main.py')).toEqual([0, 'x', ''])
    await ws.close()
  })

  it('needs machines for @local', () => {
    expect(() => new Workspace({ '/srv': '@local' })).toThrow('@local needs a workspace')
    expect(() => new Workspace({ '/box': new MachineVFS({}) })).toThrow(
      'needs a workspace with machines',
    )
  })

  it('mounts no /tmp without machines', () => {
    const prefixes = new Workspace({}).mounts().map((m) => m.prefix)
    expect(prefixes).not.toContain('/tmp/')
  })

  it('names the machines and the root as its storage location', () => {
    expect(new MachineVFS({ root: '/tmp/' }).storageLocation()).toBe('machine:*:/tmp')
    expect(new MachineVFS({ machines: ['a', 'b'], root: '/' }).storageLocation()).toBe(
      'machine:a,b:/',
    )
  })
})
