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
import { OpsRegistry } from '../../ops/registry.ts'
import { MountMode, PathSpec, VFSName } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { DevVFS } from './dev.ts'

function setupOps(): { dev: DevVFS; registry: OpsRegistry } {
  const dev = new DevVFS()
  const registry = new OpsRegistry()
  for (const op of dev.ops()) registry.register(op)
  return { dev, registry }
}

function call(
  registry: OpsRegistry,
  name: string,
  dev: DevVFS,
  path: string,
  ...args: unknown[]
): Promise<unknown> {
  return registry.call(name, VFSName.RAM, dev.accessor, PathSpec.fromStrPath(path), args)
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const data = new RAMVFS()
  ops.registerVfs(data)
  return new Workspace({ '/data': data }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('DevVFS', () => {
  it('reports kind = ram (matching Python parity)', () => {
    expect(new DevVFS().kind).toBe(VFSName.RAM)
  })

  it('exposes the same op surface as RAMVFS', () => {
    const dev = new DevVFS()
    const names = dev
      .ops()
      .map((o) => o.name)
      .sort()
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('readdir')
    expect(names).toContain('stat')
  })

  it('reads /null as empty bytes', async () => {
    const { dev, registry } = setupOps()
    const data = (await call(registry, 'read', dev, '/null')) as Uint8Array
    expect(data.byteLength).toBe(0)
  })

  it('refuses to materialize all of /zero', async () => {
    const { dev, registry } = setupOps()
    await expect(call(registry, 'read', dev, '/zero')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('writes are silently discarded', async () => {
    const { dev, registry } = setupOps()
    await call(registry, 'write', dev, '/null', new TextEncoder().encode('ignored'))
    const after = (await call(registry, 'read', dev, '/null')) as Uint8Array
    expect(after.byteLength).toBe(0)
  })

  it('reads of unknown paths throw file-not-found', async () => {
    const { dev, registry } = setupOps()
    await expect(call(registry, 'read', dev, '/nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('readdir of root lists /null and /zero', async () => {
    const { dev, registry } = setupOps()
    const entries = (await call(registry, 'readdir', dev, '/')) as string[]
    expect(entries.sort()).toEqual(['/null', '/zero'])
  })
})

describe('character device commands', () => {
  it('serves ranged zero reads beyond the old finite buffer', async () => {
    const ws = await makeWs()
    const result = await ws.shell('head -c 2M /dev/zero | wc -c')
    expect(result.stdoutText).toBe('2097152\n')
    await ws.close()
  })

  it('bounds an unqualified cat without changing its successful status', async () => {
    const ws = await makeWs()
    const result = await ws.shell('cat /dev/zero')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(8 << 20)
    expect(result.stdout.every((byte) => byte === 0)).toBe(true)
    expect(result.stderrText).toContain('output truncated')
    await ws.close()
  })

  it('bounds default head without buffering an endless unterminated line', async () => {
    const ws = await makeWs()
    const result = await ws.shell('head /dev/zero')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(8 << 20)
    expect(result.stdout.every((byte) => byte === 0)).toBe(true)
    expect(result.stderrText).toContain('output truncated')
    await ws.close()
  })

  it('does not apply the device safeguard to adjacent regular files', async () => {
    const ws = await makeWs()
    const size = (8 << 20) + 1
    await ws.vfs.writeFile('/data/large.bin', new Uint8Array(size))
    const result = await ws.shell('cat /dev/null /data/large.bin | wc -c')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutText).toBe(`${String(size)}\n`)
    expect(result.stderrText).not.toContain('output truncated')
    await ws.close()
  })

  it('classifies and renders active synthetic devices', async () => {
    const ws = await makeWs()
    expect((await ws.shell('find /dev -type f')).stdoutText).toBe('')
    expect((await ws.shell('find /dev -type c')).stdoutText).toBe('/dev/null\n/dev/zero\n')
    expect((await ws.shell('find /dev -empty')).stdoutText).toBe('')
    expect((await ws.shell("stat -c '%F %t %T' /dev/null")).stdoutText).toBe(
      'character special file 1 3\n',
    )
    const longZero = (await ws.shell('ls -l /dev/zero')).stdoutText
    expect(longZero).toMatch(/^crw-rw-rw-/)
    expect(longZero).toContain('1, 5')
    expect((await ws.shell('file /dev/zero')).stdoutText).toBe(
      '/dev/zero: character special (1/5)\n',
    )
    expect((await ws.shell('du /dev/zero')).stdoutText).toBe('0\t/dev/zero\n')
    expect((await ws.shell("find /dev/null -printf '%m %M\\n'")).stdoutText).toBe(
      '666 crw-rw-rw-\n',
    )
    expect((await ws.shell("stat -c '%a %f' /dev/null")).stdoutText).toBe('666 21b6\n')
    await ws.close()
  })

  it('answers regular-file and size predicates by kind', async () => {
    const ws = await makeWs()
    expect((await ws.shell('test -f /dev/null; echo $?')).stdoutText).toBe('1\n')
    expect((await ws.shell('test -c /dev/null; echo $?')).stdoutText).toBe('0\n')
    expect((await ws.shell('test -s /dev/zero; echo $?')).stdoutText).toBe('1\n')
    await ws.close()
  })

  it('refuses commands that require a whole read of an endless device', async () => {
    const ws = await makeWs()
    const commands = [
      'cp /dev/zero /data/out',
      'source /dev/zero',
      'md5 /dev/zero',
      'grep needle /dev/zero',
      'rg needle /dev/zero',
    ]
    for (const command of commands) {
      const result = await ws.shell(command)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderrText).toContain('cannot read an endless device without a size')
    }
    await ws.close()
  })
})

describe('dev file removal (GNU rm /dev/null semantics)', () => {
  it('rm /dev/null exits 0 and the path is gone', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe('')
    expect(new TextDecoder().decode(rm.stderr)).toBe('')
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('zero')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    const cat = await ws.shell('cat /dev/null')
    expect(cat.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(cat.stderr)).toMatch(/No such file or directory/)
    await ws.close()
  })

  it('rm -v /dev/null prints a true removed claim', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm -v /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe("removed '/dev/null'\n")
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('rm -rf /dev/null removes the file too', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm -rf /dev/null')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('a redirect recreates a removed /dev/null as a regular file', async () => {
    const ws = await makeWs()
    await ws.shell('rm /dev/null')
    const write = await ws.shell('echo recreated > /dev/null')
    expect(write.exitCode).toBe(0)
    const cat = await ws.shell('cat /dev/null')
    expect(cat.stdoutText).toBe('recreated\n')
    const test = await ws.shell('if [ -f /dev/null ]; then echo regular; fi')
    expect(test.stdoutText).toBe('regular\n')
    await ws.close()
  })

  it('rm /dev/zero is symmetric', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm /dev/zero')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('null')
    expect(ls.stdoutText.split('\n')).not.toContain('zero')
    const write = await ws.shell('echo z > /dev/zero')
    expect(write.exitCode).toBe(0)
    const cat = await ws.shell('cat /dev/zero')
    expect(cat.stdoutText).toBe('z\n')
    await ws.close()
  })
})

describe('DevVFS auto-mount in Workspace', () => {
  it('Workspace auto-mounts /dev/ without the user having to declare it', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const [resolved] = await ws.resolve('/dev/null')
    expect(resolved.kind).toBe(VFSName.RAM)
    await ws.close()
  })

  it('declaring /dev/ explicitly raises duplicate-mount (matches Python)', () => {
    expect(() => new Workspace({ '/dev': new DevVFS() }, { mode: MountMode.WRITE })).toThrow(
      /duplicate mount prefix/,
    )
  })
})
