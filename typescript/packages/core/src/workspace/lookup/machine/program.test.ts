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
import { FakeFiles, one, out, two } from '../../../../tests/fixtures/machine_files.ts'
import { SessionProfile } from '../../../policy/profile.ts'

describe('programMachine', () => {
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
