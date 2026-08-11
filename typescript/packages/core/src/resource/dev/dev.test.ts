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
import { MountMode, PathSpec, ResourceName } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { RAMResource } from '../ram/ram.ts'
import { DevResource } from './dev.ts'

function setupOps(): { dev: DevResource; registry: OpsRegistry } {
  const dev = new DevResource()
  const registry = new OpsRegistry()
  for (const op of dev.ops()) registry.register(op)
  return { dev, registry }
}

function call(
  registry: OpsRegistry,
  name: string,
  dev: DevResource,
  path: string,
  ...args: unknown[]
): Promise<unknown> {
  return registry.call(name, ResourceName.RAM, dev.accessor, PathSpec.fromStrPath(path), args)
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const data = new RAMResource()
  ops.registerResource(data)
  return new Workspace({ '/data': data }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('DevResource', () => {
  it('reports kind = ram (matching Python parity)', () => {
    expect(new DevResource().kind).toBe(ResourceName.RAM)
  })

  it('exposes the same op surface as RAMResource', () => {
    const dev = new DevResource()
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

  it('reads /zero as 1 MiB of zeros', async () => {
    const { dev, registry } = setupOps()
    const data = (await call(registry, 'read', dev, '/zero')) as Uint8Array
    expect(data.byteLength).toBe(1 << 20)
    expect(data.every((b) => b === 0)).toBe(true)
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

describe('dev file removal (GNU rm /dev/null semantics)', () => {
  it('rm /dev/null exits 0 and the path is gone', async () => {
    const ws = await makeWs()
    const rm = await ws.execute('rm /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe('')
    expect(new TextDecoder().decode(rm.stderr)).toBe('')
    const ls = await ws.execute('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('zero')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    const cat = await ws.execute('cat /dev/null')
    expect(cat.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(cat.stderr)).toMatch(/No such file or directory/)
    await ws.close()
  })

  it('rm -v /dev/null prints a true removed claim', async () => {
    const ws = await makeWs()
    const rm = await ws.execute('rm -v /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe("removed '/dev/null'\n")
    const ls = await ws.execute('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('rm -rf /dev/null removes the file too', async () => {
    const ws = await makeWs()
    const rm = await ws.execute('rm -rf /dev/null')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.execute('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('a redirect recreates a removed /dev/null as a regular file', async () => {
    const ws = await makeWs()
    await ws.execute('rm /dev/null')
    const write = await ws.execute('echo recreated > /dev/null')
    expect(write.exitCode).toBe(0)
    const cat = await ws.execute('cat /dev/null')
    expect(cat.stdoutText).toBe('recreated\n')
    const test = await ws.execute('if [ -f /dev/null ]; then echo regular; fi')
    expect(test.stdoutText).toBe('regular\n')
    await ws.close()
  })

  it('rm /dev/zero is symmetric', async () => {
    const ws = await makeWs()
    const rm = await ws.execute('rm /dev/zero')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.execute('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('null')
    expect(ls.stdoutText.split('\n')).not.toContain('zero')
    const write = await ws.execute('echo z > /dev/zero')
    expect(write.exitCode).toBe(0)
    const cat = await ws.execute('cat /dev/zero')
    expect(cat.stdoutText).toBe('z\n')
    await ws.close()
  })
})

describe('DevResource auto-mount in Workspace', () => {
  it('Workspace auto-mounts /dev/ without the user having to declare it', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const [resolved] = await ws.resolve('/dev/null')
    expect(resolved.kind).toBe(ResourceName.RAM)
    await ws.close()
  })

  it('declaring /dev/ explicitly raises duplicate-mount (matches Python)', () => {
    expect(() => new Workspace({ '/dev': new DevResource() }, { mode: MountMode.WRITE })).toThrow(
      /duplicate mount prefix/,
    )
  })
})
