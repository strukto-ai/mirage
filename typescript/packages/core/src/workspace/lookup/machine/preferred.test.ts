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
import { FakeFiles, two, run, texts } from '../../../../tests/fixtures/machine_files.ts'
import type { Action } from '../../../policy/types.ts'
import { MachineVFS } from '../../../vfs/machine/machine.ts'

describe('preferredMachine', () => {
  it('gives a named machine the new names Mirage makes', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const ws = two(a, b)
    expect((await ws.shell('touch /tmp/here')).exitCode).toBe(0)
    expect((await ws.shell('touch /tmp/there', { machine: 'b' })).exitCode).toBe(0)
    expect((await ws.shell('mkdir /tmp/d', { machine: 'b' })).exitCode).toBe(0)
    expect([texts(a), texts(b)]).toEqual([{ '/tmp/here': '' }, { '/tmp/there': '' }])
    expect([a.dirs.has('/tmp/d'), b.dirs.has('/tmp/d')]).toEqual([false, true])
    await ws.close()
  })

  it('gives a folder one machine shows the new names made from it', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/srv/kept': 'k' })
    const ws = two(a, b, { '/srv': '@b' })
    expect((await run(ws, 'cd /srv && touch /tmp/from-b'))[0]).toBe(0)
    expect((await run(ws, 'cd /tmp && touch /tmp/from-tmp'))[0]).toBe(0)
    expect([texts(a), Object.keys(texts(b)).sort()]).toEqual([
      { '/tmp/from-tmp': '' },
      ['/srv/kept', '/tmp/from-b'],
    ])
    await ws.close()
  })

  it("writes on a program's machine what reads that program's pipe", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/srv/k': 'k' })
    const tmp = new MachineVFS({ root: '/tmp', defaultMachine: 'b' })
    const ws = two(a, b, { '/tmp': tmp, '/srv': '@b' })
    expect((await run(ws, 'echo x > /tmp/alone'))[0]).toBe(0)
    expect((await run(ws, 'gen | tee /tmp/piped'))[0]).toBe(0)
    expect((await run(ws, 'cd /srv && gen | tee /tmp/from-b'))[0]).toBe(0)
    expect(Object.keys(texts(a)).sort()).toEqual(['/tmp/piped'])
    expect(Object.keys(texts(b)).sort()).toEqual(['/srv/k', '/tmp/alone', '/tmp/from-b'])
    await ws.close()
  })

  it("keeps the writer's machine for a child shell reading the pipe", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const tmp = new MachineVFS({ root: '/tmp', defaultMachine: 'b' })
    const ws = two(a, b, { '/tmp': tmp })
    expect((await run(ws, 'gen | (tee /tmp/sub)'))[0]).toBe(0)
    expect((await run(ws, 'gen | ( (tee /tmp/nested) )'))[0]).toBe(0)
    expect((await run(ws, 'gen | { tee /tmp/group | cat; }'))[0]).toBe(0)
    expect((await run(ws, 'nice gen | tee /tmp/wrapped'))[0]).toBe(0)
    expect((await run(ws, 'gen | (tee /tmp/other) < /tmp/sub'))[0]).toBe(0)
    expect(Object.keys(texts(a)).sort()).toEqual([
      '/tmp/group',
      '/tmp/nested',
      '/tmp/sub',
      '/tmp/wrapped',
    ])
    expect(Object.keys(texts(b)).sort()).toEqual(['/tmp/other'])
    await ws.close()
  })

  it('keeps the machine its writer started on for a reader that moves', async () => {
    const a = new FakeFiles({ '/srv/k': 'k' })
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b, { '/srv': '@a' })
    expect((await run(ws, '/tmp/tool | (cd /srv && tee /tmp/moved)'))[0]).toBe(0)
    const looped = '/tmp/tool | while read l; do echo $l >> /tmp/looped; done'
    expect((await run(ws, looped))[0]).toBe(0)
    expect(Object.keys(texts(a)).sort()).toEqual(['/srv/k'])
    expect(Object.keys(texts(b)).sort()).toEqual(['/tmp/looped', '/tmp/moved', '/tmp/tool'])
    await ws.close()
  })

  it('finds a writer named from its folder from that folder', async () => {
    const a = new FakeFiles({ '/tmp/other/tool': '\x7fELF' })
    const b = new FakeFiles({ '/tmp/start/tool': '\x7fELF' })
    const ws = two(a, b)
    const line = 'cd /tmp/start && ./tool | (cd /tmp/other; tee /tmp/out)'
    expect((await run(ws, line))[0]).toBe(0)
    expect(['/tmp/out' in texts(a), '/tmp/out' in texts(b)]).toEqual([false, true])
    await ws.close()
  })

  it('runs a path-named writer on no machine under a file policy', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b)
    ws.policies.add({ preVfs: (): Action | null => null })
    await run(ws, '/tmp/tool | tee /tmp/out')
    await run(ws, '/tmp/tool > /tmp/direct')
    expect([a.ran, b.ran]).toEqual([[], []])
    expect(Object.keys(texts(a)).sort()).toEqual(['/tmp/direct', '/tmp/out'])
    expect(Object.keys(texts(b)).sort()).toEqual(['/tmp/tool'])
    await ws.close()
  })

  it('finds a wrapped writer named by its path on its machine', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b)
    expect((await run(ws, 'nice /tmp/tool | tee /tmp/out'))[0]).toBe(0)
    expect(['/tmp/out' in texts(a), '/tmp/out' in texts(b)]).toEqual([false, true])
    await ws.close()
  })

  it("writes on its machine what reads a path-named program's pipe", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/tool': '\x7fELF' })
    const ws = two(a, b)
    expect((await run(ws, '/tmp/tool | tee /tmp/by-tool'))[0]).toBe(0)
    expect(['/tmp/by-tool' in texts(a), '/tmp/by-tool' in texts(b)]).toEqual([false, true])
    await ws.close()
  })
})
