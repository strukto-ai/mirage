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
  failed,
  ok,
  ScriptedMachine,
  tableOf,
  type Answer,
} from '../../../tests/fixtures/machine.ts'
import { FakeFiles, spec } from '../../../tests/fixtures/machine_files.ts'
import type { Action, VfsContext } from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import type { MountSpec } from '../../workspace/workspace/types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { MachineVFS } from './machine.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

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

function shared(a: FakeFiles, b: FakeFiles): MachineVFS {
  const vfs = new MachineVFS({ root: '/tmp' })
  vfs.bindMachines(
    tableOf(new ScriptedMachine('a', a.answer), new ScriptedMachine('b', b.answer)),
    'a',
  )
  return vfs
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

  it('takes a name on both machines from the copy written last', async () => {
    const a = new FakeFiles({ '/tmp/x': 'a' })
    const b = new FakeFiles({ '/tmp/x': 'b' })
    const ws = two(a, b)
    expect(await run(ws, 'cat /tmp/x')).toEqual([0, 'a', ''])
    b.answer('cat > /tmp/x', ENC.encode('later'))
    expect(await run(ws, 'cat /tmp/x')).toEqual([0, 'later', ''])
    expect(await run(ws, 'wc -c < /tmp/x')).toEqual([0, '5\n', ''])
    expect(await run(ws, 'stat -c %s /tmp/x')).toEqual([0, '5\n', ''])
    expect(await run(ws, "ls -l /tmp | grep -c ' 5 '")).toEqual([0, '1\n', ''])
    await ws.close()
  })

  it('sends a write to the copy written last', async () => {
    const a = new FakeFiles({ '/tmp/x': 'a' })
    const b = new FakeFiles({ '/tmp/x': 'b' })
    const ws = two(a, b)
    b.answer('cat > /tmp/x', ENC.encode('later'))
    expect((await run(ws, 'echo more >> /tmp/x'))[0]).toBe(0)
    expect([texts(a)['/tmp/x'], texts(b)['/tmp/x']]).toEqual(['a', 'latermore\n'])
    expect((await run(ws, 'echo new > /tmp/x'))[0]).toBe(0)
    expect([texts(a)['/tmp/x'], texts(b)['/tmp/x']]).toEqual(['a', 'new\n'])
    await ws.close()
  })

  it('takes the name off every machine on rm', async () => {
    const a = new FakeFiles({ '/tmp/x': 'a' })
    const b = new FakeFiles({ '/tmp/x': 'b' })
    const ws = two(a, b)
    expect(await run(ws, 'rm /tmp/x')).toEqual([0, '', ''])
    expect([texts(a), texts(b)]).toEqual([{}, {}])
    const [code, , err] = await run(ws, 'cat /tmp/x')
    expect([code, err.includes('No such file or directory')]).toEqual([1, true])
    await ws.close()
  })

  it('takes the old name off every machine on mv', async () => {
    const a = new FakeFiles({ '/tmp/x': 'a' })
    const b = new FakeFiles({ '/tmp/x': 'b' })
    const ws = two(a, b)
    b.answer('cat > /tmp/x', ENC.encode('later'))
    expect((await run(ws, 'mv /tmp/x /tmp/y'))[0]).toBe(0)
    expect([texts(a), texts(b)]).toEqual([{}, { '/tmp/y': 'later' }])
    expect(await run(ws, 'ls /tmp')).toEqual([0, 'y\n', ''])
    await ws.close()
  })

  it('lands a new name where its folder is', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/d/kept': 'k' })
    const ws = two(a, b)
    expect((await run(ws, 'echo hi > /tmp/d/new'))[0]).toBe(0)
    expect((await run(ws, 'mkdir -p /tmp/d/sub/deep'))[0]).toBe(0)
    expect((await run(ws, 'touch /tmp/top'))[0]).toBe(0)
    expect([texts(a), texts(b)]).toEqual([
      { '/tmp/top': '' },
      { '/tmp/d/kept': 'k', '/tmp/d/new': 'hi\n' },
    ])
    expect([a.dirs.has('/tmp/d'), b.dirs.has('/tmp/d/sub/deep')]).toEqual([false, true])
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
    const refusing: Answer = (line, data) =>
      line.startsWith('mv ')
        ? failed("mv: cannot move '/tmp/src': Permission denied\n")
        : a.answer(line, data)
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: {
          a: new ScriptedMachine('a', refusing),
          b: new ScriptedMachine('b', b.answer),
        },
      },
    )
    expect((await run(ws, 'mv -T /tmp/src /tmp/dst'))[0]).toBe(1)
    expect(b.dirs.has('/tmp/dst')).toBe(true)
    await ws.close()
  })

  it("lists a folder under another machine's file", async () => {
    const ws = two(new FakeFiles({ '/tmp/d/sub/g': 'y' }), new FakeFiles({ '/tmp/d': 'f' }))
    expect(await run(ws, 'ls /tmp/d/sub')).toEqual([0, 'g\n', ''])
    await ws.close()
  })

  it('fails a mv into a folder no machine holds', async () => {
    const a = new FakeFiles({ '/tmp/src': 'x' })
    const b = new FakeFiles()
    const ws = two(a, b)
    const [code, , err] = await run(ws, 'mv /tmp/src /tmp/missing/dst')
    expect([code, err.includes('No such file or directory')]).toEqual([1, true])
    expect([texts(a), a.dirs.has('/tmp/missing') || b.dirs.has('/tmp/missing')]).toEqual([
      { '/tmp/src': 'x' },
      false,
    ])
    await ws.close()
  })

  it('drops only the machine whose link leads to a hidden name', async () => {
    const a = new FakeFiles({ '/tmp/cache/x': 'x' })
    const b = new FakeFiles({ '/tmp/secret/s': 's' })
    b.links.set('/tmp/cache', '/tmp/secret')
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
        profiles: { agent: { paths: { hide: ['/tmp/secret'] } } },
      },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    const done = await agent.shell('ls /tmp/cache')
    expect([done.exitCode, DEC.decode(done.stdout)]).toEqual([0, 'x\n'])
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

  it("keeps cp on the source's machine", async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/src': 'payload' })
    const ws = two(a, b)
    expect((await run(ws, 'cp /tmp/src /tmp/dst'))[0]).toBe(0)
    expect(texts(a)).toEqual({})
    expect(texts(b)).toEqual({ '/tmp/src': 'payload', '/tmp/dst': 'payload' })
    await ws.close()
  })

  it("replaces another machine's name with a cp onto it", async () => {
    const a = new FakeFiles({ '/tmp/dst': 'old' })
    const b = new FakeFiles({ '/tmp/src': 'new' })
    const ws = two(a, b)
    a.answer('cat > /tmp/dst', ENC.encode('old'))
    expect((await run(ws, 'cp /tmp/src /tmp/dst'))[0]).toBe(0)
    expect(['/tmp/dst' in texts(a), texts(b)['/tmp/dst']]).toEqual([false, 'new'])
    expect(await run(ws, 'cat /tmp/dst')).toEqual([0, 'new', ''])
    await ws.close()
  })

  it("refuses a cp through a machine's link to a hidden name", async () => {
    const a = new FakeFiles({ '/tmp/src': 'new', '/tmp/secret': 's' })
    a.links.set('/tmp/public', '/tmp/secret')
    const b = new FakeFiles()
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
        profiles: { agent: { paths: { hide: ['/tmp/secret'] } } },
      },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    const done = await agent.shell('cp /tmp/src /tmp/public')
    expect(done.exitCode).toBe(1)
    expect(Object.keys(texts(a)).sort()).toEqual(['/tmp/secret', '/tmp/src'])
    await ws.close()
  })

  it('makes a folder only another machine holds for a cp into it', async () => {
    const a = new FakeFiles({ '/tmp/d/kept': 'k' })
    const b = new FakeFiles({ '/tmp/src': 's' })
    const ws = two(a, b)
    expect((await run(ws, 'cp /tmp/src /tmp/d/copy'))[0]).toBe(0)
    expect(texts(b)['/tmp/d/copy']).toBe('s')
    expect(await run(ws, 'ls /tmp/d')).toEqual([0, 'copy\nkept\n', ''])
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

  it("shows one machine's files at the same path for @<machine>", async () => {
    const a = new FakeFiles({ '/tmp/a.txt': 'a' })
    const b = new FakeFiles({ '/tmp/b.txt': 'b' })
    const ws = two(a, b, { '/tmp': '@b' })
    expect(await run(ws, 'ls /tmp')).toEqual([0, 'b.txt\n', ''])
    await run(ws, 'echo new > /tmp/new.txt')
    expect(['/tmp/new.txt' in texts(a), texts(b)['/tmp/new.txt']]).toEqual([false, 'new\n'])
    await ws.close()
  })

  it("mounts a machine's tree at another prefix", async () => {
    const vfs = new MachineVFS({ machines: ['a'], root: '/srv' })
    const ws = two(new FakeFiles({ '/srv/app/main.py': 'x' }), new FakeFiles(), { '/box': vfs })
    expect(await run(ws, 'cat /box/app/main.py')).toEqual([0, 'x', ''])
    await ws.close()
  })

  it("names one of the workspace's machines with @<machine>", () => {
    expect(() => new Workspace({ '/tmp': '@gpu' })).toThrow("no machine 'gpu' (machines: none)")
    expect(() => new Workspace({ '/tmp': 'local' })).toThrow('a string names a machine')
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

  it('refuses a machine file past the memory room', async () => {
    const a = new FakeFiles({ '/tmp/big.bin': 'x'.repeat(3_000_000) })
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        maxMemory: '2MB',
        machines: {
          a: new ScriptedMachine('a', a.answer),
          b: new ScriptedMachine('b', new FakeFiles().answer),
        },
      },
    )
    const [, , err] = await run(ws, 'cat /tmp/big.bin | wc -c')
    await ws.close()
    expect(err).toContain('memory exhausted')
  })

  it('still lists and removes machine files at the memory cap', async () => {
    const a = new FakeFiles({ '/tmp/old.log': 'x' })
    const ws = new Workspace(
      { '/ram': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        maxMemory: '2MB',
        machines: {
          a: new ScriptedMachine('a', a.answer),
          b: new ScriptedMachine('b', new FakeFiles().answer),
        },
      },
    )
    expect((await run(ws, 'head -c 2097152 /dev/zero > /ram/fill'))[0]).toBe(0)
    expect(await run(ws, 'ls /tmp')).toEqual([0, 'old.log\n', ''])
    expect(await run(ws, 'rm /tmp/old.log')).toEqual([0, '', ''])
    expect(a.files.has('/tmp/old.log')).toBe(false)
    await ws.close()
  })

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

  it('moves a folder on both machines on each', async () => {
    const a = new FakeFiles({ '/tmp/d/x': '1' })
    const b = new FakeFiles({ '/tmp/d/y': '2' })
    const ws = two(a, b)
    expect((await run(ws, 'mv /tmp/d /tmp/e'))[0]).toBe(0)
    expect([texts(a), texts(b)]).toEqual([{ '/tmp/e/x': '1' }, { '/tmp/e/y': '2' }])
    expect(await run(ws, 'ls /tmp/e')).toEqual([0, 'x\ny\n', ''])
    expect(await run(ws, 'ls /tmp')).toEqual([0, 'e\n', ''])
    await ws.close()
  })

  it('copies each name in place for a cp -r of a folder on both machines', async () => {
    const a = new FakeFiles({ '/tmp/d/x': '1' })
    const b = new FakeFiles({ '/tmp/d/y': '2' })
    const ws = two(a, b)
    expect((await run(ws, 'cp -r /tmp/d /tmp/e'))[0]).toBe(0)
    expect([texts(a)['/tmp/e/x'], texts(b)['/tmp/e/y']]).toEqual(['1', '2'])
    expect(await run(ws, 'ls /tmp/e')).toEqual([0, 'x\ny\n', ''])
    await ws.close()
  })

  it('names the machine and its path in df', async () => {
    const said =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100 40 60 40% /\n'
    const withDf =
      (files: FakeFiles): Answer =>
      (line, data) =>
        line.startsWith('df ') ? ok(said) : files.answer(line, data)
    const ws = new Workspace(
      { '/srv': '@b' },
      {
        mode: MountMode.WRITE,
        machines: {
          a: new ScriptedMachine('a', withDf(new FakeFiles())),
          b: new ScriptedMachine('b', withDf(new FakeFiles({ '/srv/k': 'k' }))),
        },
      },
    )
    const [code, out] = await run(ws, 'df /srv /tmp')
    expect(code).toBe(0)
    expect(
      out
        .split('\n')
        .slice(1, 3)
        .map((line) => line.split(/\s+/)[0]),
    ).toEqual(['b:/srv', 'a:/tmp'])
    const named = await ws.shell('df /tmp', { machine: 'b' })
    expect(DEC.decode(named.stdout).split('\n')[1]?.split(/\s+/)[0]).toBe('b:/tmp')
    await ws.close()
  })

  it('tells a file policy the machine a call acts on', async () => {
    const told = new Map<string, string | null | undefined>()
    const a = new FakeFiles()
    const b = new FakeFiles({ '/srv/kept': 'k' })
    const ws = two(a, b, { '/srv': '@b', '/data': new RAMVFS() })
    ws.policies.add({
      preVfs(ctx: VfsContext): Action | null {
        told.set(ctx.path.virtual, ctx.machine)
        return null
      },
    })
    await ws.shell('cat /srv/kept; echo x > /data/f; touch /tmp/one')
    await ws.shell('touch /tmp/two', { machine: 'b' })
    expect(told.get('/srv/kept')).toBe('b')
    expect(told.get('/data/f')).toBeNull()
    expect(told.get('/tmp/one')).toBeNull()
    expect(told.get('/tmp/two')).toBe('b')
    await ws.close()
  })

  it('takes the newer of a name that is a file here and a folder there', async () => {
    const a = new FakeFiles({ '/tmp/k': 'file' })
    const b = new FakeFiles({ '/tmp/k/in': '1' })
    const ws = two(a, b)
    a.answer('cat > /tmp/k', ENC.encode('newer'))
    expect(await run(ws, 'cat /tmp/k')).toEqual([0, 'newer', ''])
    expect(await run(ws, 'rm /tmp/k')).toEqual([0, '', ''])
    expect([texts(a), texts(b)]).toEqual([{}, { '/tmp/k/in': '1' }])
    expect(await run(ws, 'ls /tmp/k')).toEqual([0, 'in\n', ''])
    const [code, , err] = await run(ws, 'rm /tmp/k')
    expect([code, err.includes('Is a directory')]).toEqual([1, true])
    expect(texts(b)).toEqual({ '/tmp/k/in': '1' })
    await ws.close()
  })

  it('writes where Mirage writes for a command a machine runs whole', async () => {
    const a = new FakeFiles({ '/srv/k': 'k' }, ['cat'])
    const b = new FakeFiles({ '/tmp/kept': 'old' }, ['cat'])
    const ws = two(a, b, { '/srv': '@a' })
    expect((await run(ws, "cd /srv && cat > /tmp/kept << 'EOF'\nnew\nEOF"))[0]).toBe(0)
    expect([texts(b)['/tmp/kept'], '/tmp/kept' in texts(a)]).toEqual(['new\n', false])
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

  it('reads three machines as one folder', async () => {
    const a = new FakeFiles({ '/tmp/x': 'a', '/tmp/d/1': '1' })
    const b = new FakeFiles({ '/tmp/x': 'b', '/tmp/d/2': '2' })
    const c = new FakeFiles({
      '/tmp/x': 'c',
      '/tmp/d/3': '3',
      '/tmp/only/kept': 'k',
      '/tmp/src': 'new',
    })
    const all = [a, b, c]
    const ws = new Workspace(
      {},
      {
        mode: MountMode.WRITE,
        machines: {
          a: new ScriptedMachine('a', a.answer),
          b: new ScriptedMachine('b', b.answer),
          c: new ScriptedMachine('c', c.answer),
        },
      },
    )
    c.answer('cat > /tmp/x', ENC.encode('last'))
    expect(await run(ws, 'cat /tmp/x')).toEqual([0, 'last', ''])
    b.answer('cat > /tmp/x', ENC.encode('later'))
    expect(await run(ws, 'cat /tmp/x')).toEqual([0, 'later', ''])
    expect(await run(ws, 'ls /tmp/d')).toEqual([0, '1\n2\n3\n', ''])
    expect((await run(ws, 'echo n > /tmp/only/new'))[0]).toBe(0)
    expect(all.map((m) => m.files.has('/tmp/only/new'))).toEqual([false, false, true])
    expect((await run(ws, 'mv /tmp/d /tmp/e'))[0]).toBe(0)
    expect(all.map((m) => [...m.files.keys()].filter((f) => f.includes('/e/')).sort())).toEqual([
      ['/tmp/e/1'],
      ['/tmp/e/2'],
      ['/tmp/e/3'],
    ])
    expect((await run(ws, 'cp /tmp/src /tmp/x'))[0]).toBe(0)
    expect(all.map((m) => m.files.has('/tmp/x'))).toEqual([false, false, true])
    expect(await run(ws, 'cat /tmp/x')).toEqual([0, 'new', ''])
    expect(await run(ws, 'rm /tmp/x')).toEqual([0, '', ''])
    expect(all.some((m) => m.files.has('/tmp/x'))).toBe(false)
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

  it('moves a folder on no machine when one cannot move it', async () => {
    const a = new FakeFiles({ '/tmp/src/x': '1' })
    const b = new FakeFiles({ '/tmp/src/y': '2', '/tmp/dst/kept': 'k' })
    await expect(shared(a, b).rename(spec('/src'), spec('/dst'))).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
    expect([texts(a), Object.keys(texts(b)).sort()]).toEqual([
      { '/tmp/src/x': '1' },
      ['/tmp/dst/kept', '/tmp/src/y'],
    ])
  })

  it('makes no folder where another machine shows a file on mv', async () => {
    const a = new FakeFiles({ '/tmp/src': 'x' })
    const b = new FakeFiles({ '/tmp/p': 'file' })
    await expect(shared(a, b).rename(spec('/src'), spec('/p/dst'))).rejects.toThrow()
    expect([a.dirs.has('/tmp/p'), Object.keys(texts(a)).sort()]).toEqual([false, ['/tmp/src']])
  })

  it('removes a folder on no machine when one still fills it', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/d/x': '1' })
    a.dirs.add('/tmp/d')
    await expect(shared(a, b).rmdir(spec('/d'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(a.dirs.has('/tmp/d')).toBe(true)
    b.files.delete('/tmp/d/x')
    await shared(a, b).rmdir(spec('/d'))
    expect(a.dirs.has('/tmp/d') || b.dirs.has('/tmp/d')).toBe(false)
  })

  it('refuses a new name below a file shown over a folder', async () => {
    const a = new FakeFiles({ '/tmp/k/in': '1' })
    const b = new FakeFiles({ '/tmp/k': 'f' })
    const ws = two(a, b)
    b.answer('cat > /tmp/k', ENC.encode('newer'))
    const [code, , err] = await run(ws, 'echo x > /tmp/k/new')
    expect([code, err.includes('Not a directory')]).toEqual([1, true])
    expect(Object.keys(texts(a)).sort()).toEqual(['/tmp/k/in'])
    await ws.close()
  })
})
