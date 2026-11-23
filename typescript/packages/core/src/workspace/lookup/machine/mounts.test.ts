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
import { FakeFiles, TOOLS, one, out } from '../../../../tests/fixtures/machine_files.ts'
import type { Action, VfsContext } from '../../../policy/types.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const DEC = new TextDecoder()

describe('machine mounts', () => {
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
    expect(await out(ws, 'cat /tmp/both')).toBe('1')
    expect([a.ran, b.ran]).toEqual([['cat /tmp/a.py'], []])
    await ws.close()
  })

  it("runs a command on the machine holding its path from a shared mount's root", async () => {
    const a = new FakeFiles({}, ['cat'])
    const b = new FakeFiles({ '/tmp/data/f': 'x' }, ['cat'])
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    expect(await out(ws, 'cd /tmp && cat data/f')).toBe('ran\n')
    expect([a.ran, b.ran]).toEqual([[], ['cat data/f']])
    await ws.close()
  })

  it('keeps a name on two machines with Mirage from any folder', async () => {
    const a = new FakeFiles({ '/srv/k': 'k', '/tmp/both': 'old' }, TOOLS)
    const b = new FakeFiles({ '/tmp/both': 'b' }, TOOLS)
    const ws = new Workspace(
      { '/srv': '@a' },
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
      },
    )
    b.answer('cat > /tmp/both', new TextEncoder().encode('new'))
    expect(await out(ws, 'cd /srv && cat /tmp/both')).toBe('new')
    expect(await out(ws, 'cd /srv && ls /tmp')).toBe('both\n')
    expect([a.ran, b.ran]).toEqual([[], []])
    expect(await out(ws, 'cd /srv && cat k')).toBe('ran\n')
    expect([a.ran, b.ran]).toEqual([['cat k'], []])
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
})
