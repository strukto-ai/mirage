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
import { FakeFiles, out, two } from '../../../../tests/fixtures/machine_files.ts'
import type { Action } from '../../../policy/types.ts'
import type { RunAnswer } from '../../../runtime/types.ts'
import { MountMode } from '../../../types.ts'
import { LOCALHOST_WORD } from '../constants.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const REQUEST = 'http://127.0.0.1:1/x'
const CLIENTS = ['curl', 'wget']

describe('factMachine', () => {
  it('asks a machine fact of the machine the command is about', async () => {
    const a = new FakeFiles({}, ['uname'])
    const b = new FakeFiles({ '/srv/k': 'k' }, ['uname'])
    const first = new ScriptedMachine('a', a.answer)
    const ws = new Workspace(
      { '/srv': '@b', '/data': new RAMVFS() },
      { mode: MountMode.WRITE, machines: { a: first, b: new ScriptedMachine('b', b.answer) } },
    )
    await ws.shell('cd /data && uname -m')
    await ws.shell('cd /data && uname -r', { machine: 'b' })
    await ws.shell('cd /srv && uname -s')
    expect([a.ran, b.ran]).toEqual([['uname -m'], ['uname -r', 'uname -s']])
    expect(first.cwds).toEqual(['/'])
    await ws.close()
  })

  it('leaves the fact to Mirage where no machine has the program', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const ws = two(a, b)
    expect(await out(ws, 'uname -s')).toBe('Linux\n')
    expect([a.ran, b.ran]).toEqual([[], []])
    await ws.close()
  })

  it('runs a request to localhost on the machine it is about', async () => {
    const a = new FakeFiles({}, ['curl'])
    const b = new FakeFiles({}, ['curl'])
    const ws = two(a, b, { '/data': new RAMVFS() })
    await ws.shell('cd /data && curl -s localhost:8000/health')
    await ws.shell('curl -s http://127.0.0.1:8000/x', { machine: 'b' })
    expect(a.ran).toEqual(['curl -s localhost:8000/health'])
    expect(b.ran).toEqual(['curl -s http://127.0.0.1:8000/x'])
    await ws.close()
  })

  it('keeps a request to localhost with Mirage under a network policy', async () => {
    const a = new FakeFiles({}, ['curl'])
    const b = new FakeFiles({}, ['curl'])
    const ws = two(a, b)
    ws.policies.add({ preNetwork: (): Action | null => null })
    const done = await ws.shell('curl -s --max-time 2 http://127.0.0.1:1/x')
    expect(done.exitCode).not.toBe(0)
    expect([a.ran, b.ran]).toEqual([[], []])
    await ws.close()
  })

  it.each([
    [`curl -s --max-time 2 ${REQUEST}`, 'network'],
    [`cd /srv && curl -s --max-time 2 ${REQUEST}`, 'network'],
    ['cd /srv && curl -s --max-time 2 http://0.0.0.0:1/x', 'network'],
    [`cd /srv && wget -q -T 2 -O - ${REQUEST}`, 'network'],
    [`curl -s --max-time 2 ${REQUEST}`, 'policy'],
    [`cd /srv && curl -s --max-time 2 ${REQUEST}`, 'policy'],
    ['cd /srv && curl -s --max-time 2 http://0.0.0.0:1/x', 'policy'],
    [`cd /srv && wget -q -T 2 -O - ${REQUEST}`, 'policy'],
  ])('keeps %s with Mirage on a watched %s', async (line, limit) => {
    const a = new FakeFiles({}, CLIENTS)
    const b = new FakeFiles({ '/srv/k': 'k' }, CLIENTS)
    const ws = two(a, b, { '/srv': '@b' }, limit === 'network' ? { network: false } : {})
    if (limit === 'policy') ws.policies.add({ postNetwork: (): Action | null => null })
    await ws.shell(line)
    expect([a.ran, b.ran]).toEqual([[], []])
    await ws.close()
  })

  it("runs a request where the files it reads are the machine's", async () => {
    const a = new FakeFiles({}, CLIENTS)
    const b = new FakeFiles({ '/srv/k': 'k' }, CLIENTS)
    const ws = two(a, b, { '/srv': '@b', '/data': new RAMVFS() })
    await ws.shell('echo d > /data/body')
    await ws.shell(`cd /srv && curl -s -d @k -b jar -w @k ${REQUEST}`)
    await ws.shell(`cd /srv && curl -s --data-binary @/data/body ${REQUEST}`)
    await ws.shell(`cd /srv && curl -s --data-urlencode n@/data/body ${REQUEST}`)
    await ws.shell(`cd /srv && curl -s -F f=@k ${REQUEST}`)
    await ws.shell(`cd /srv && curl -s -T k ${REQUEST}`)
    await ws.shell(`cd /data && curl -s -d @body ${REQUEST}`)
    expect(a.ran).toEqual([])
    expect(b.ran).toEqual([`curl -s -d @k -b jar -w @k ${REQUEST}`])
    await ws.close()
  })

  it('keeps a request reading a file with Mirage under a file policy', async () => {
    const a = new FakeFiles({}, CLIENTS)
    const b = new FakeFiles({ '/srv/k': 'k' }, CLIENTS)
    const ws = two(a, b, { '/srv': '@b' })
    ws.policies.add({ preVfs: (): Action | null => null })
    await ws.shell(`cd /srv && curl -s --data-binary @/srv/k ${REQUEST}`)
    await ws.shell(`cd /srv && curl -s ${REQUEST}`)
    expect([a.ran, b.ran]).toEqual([[], [`curl -s ${REQUEST}`]])
    await ws.close()
  })

  it('lands a download in the folder only its machine holds', async () => {
    const a = new FakeFiles({}, CLIENTS)
    const b = new FakeFiles({ '/srv/k': 'k' }, CLIENTS)
    const ws = two(a, b, { '/srv': '@b', '/data': new RAMVFS() })
    await ws.shell(`cd /data && wget -q -T 2 ${REQUEST}`)
    await ws.shell(`cd /data && wget -q -T 2 ${REQUEST} /srv/out`)
    await ws.shell(`cd /data && wget -q -T 2 -O - ${REQUEST}`)
    await ws.shell(`cd /data && wget -q -T 2 --spider ${REQUEST}`)
    await ws.shell(`cd /srv && wget -q -T 2 ${REQUEST}`)
    expect(a.ran).toEqual([`wget -q -T 2 -O - ${REQUEST}`, `wget -q -T 2 --spider ${REQUEST}`])
    expect(b.ran).toEqual([`wget -q -T 2 ${REQUEST}`])
    await ws.close()
  })

  it('asks a fact from a shared folder of the machine holding it', async () => {
    const a = new FakeFiles({}, ['uname'])
    const b = new FakeFiles({ '/tmp/only/k': 'k' }, ['uname'])
    const ws = two(a, b)
    await ws.shell('cd /tmp/only && echo x | uname -s')
    expect([a.ran, b.ran]).toEqual([[], ['uname -s']])
    await ws.close()
  })

  it('lands a new download in the shared folder its machine holds', async () => {
    const a = new FakeFiles({}, CLIENTS)
    const b = new FakeFiles({ '/tmp/only/k': 'k' }, CLIENTS)
    const ws = two(a, b)
    await ws.shell(`cd /tmp/only && wget -q -T 2 ${REQUEST}`)
    await ws.shell(`cd /tmp/only && curl -s -o new.txt ${REQUEST}`)
    await ws.shell(`cd /tmp/only && curl -s -o /tmp/new.txt ${REQUEST}`)
    expect(a.ran).toEqual([])
    expect(b.ran).toEqual([`wget -q -T 2 ${REQUEST}`, `curl -s -o new.txt ${REQUEST}`])
    await ws.close()
  })

  it("leaves a fact to Mirage where the run's PATH finds nothing", async () => {
    const a = new FakeFiles({}, ['uname'])
    const b = new FakeFiles({}, ['uname'])
    const lost = (line: string, data: Uint8Array | null): RunAnswer =>
      line.includes('command -v') && line.includes('PATH=/empty ')
        ? failed('')
        : a.answer(line, data)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', lost), b: new ScriptedMachine('b', b.answer) },
      },
    )
    expect(await out(ws, 'PATH=/empty uname -s')).toBe('Linux\n')
    await ws.shell('uname -s')
    expect([a.ran, b.ran]).toEqual([['uname -s'], []])
    await ws.close()
  })

  it.each([
    ['localhost', true],
    ['localhost:8000/health', true],
    ['http://LOCALHOST/', true],
    ['https://127.0.0.1:8443/a?b=1', true],
    ['http://[::1]:80/', true],
    ['user@localhost:8000', true],
    ['http://localhost.example.com/', false],
    ['http://localhost@example.com/', false],
    ['localhosts', false],
    ['Host: localhost', false],
    ['example.com', false],
  ])('tells whether %s addresses its own machine', (word, local) => {
    expect(LOCALHOST_WORD.test(word)).toBe(local)
  })
})
