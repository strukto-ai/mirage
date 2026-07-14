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
import type { Accessor } from '../../accessor/base.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { FileType, MountMode, PathSpec, ResourceName } from '../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { RAMResource } from './ram.ts'

function setup(): { ram: RAMResource; registry: OpsRegistry; ws: Workspace } {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, ops: registry })
  return { ram, registry, ws }
}

function call(
  registry: OpsRegistry,
  name: string,
  ram: RAMResource,
  path: string,
  ...args: unknown[]
): Promise<unknown> {
  return registry.call(name, ResourceName.RAM, ram.accessor, PathSpec.fromStrPath(path), args)
}

describe('RAMResource.kind / ops()', () => {
  it('is ResourceName.RAM', () => {
    expect(new RAMResource().kind).toBe(ResourceName.RAM)
  })

  it('exposes RAM ops covering the full RAM op surface', () => {
    const ram = new RAMResource()
    const names = ram
      .ops()
      .map((o) => o.name)
      .sort()
    expect(names).toEqual([
      'append',
      'create',
      'mkdir',
      'read',
      'read', // filetype variant (.feather)
      'read', // filetype variant (.h5)
      'read', // filetype variant (.parquet)
      'readdir',
      'rename',
      'rmdir',
      'setattr',
      'stat',
      'truncate',
      'unlink',
      'write',
    ])
  })
})

describe('RAMResource write + read', () => {
  it('round-trips bytes under a nested path after mkdir of the parent', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/data')
    const payload = new TextEncoder().encode('hello')
    await call(registry, 'write', ram, '/data/hello.txt', payload)
    const read = await call(registry, 'read', ram, '/data/hello.txt')
    expect(read).toEqual(payload)
  })

  it('write under /root works without mkdir', async () => {
    const { ram, registry } = setup()
    const payload = new TextEncoder().encode('x')
    await call(registry, 'write', ram, '/x', payload)
    expect(await call(registry, 'read', ram, '/x')).toEqual(payload)
  })

  it('write under nested missing parent throws', async () => {
    const { ram, registry } = setup()
    const payload = new TextEncoder().encode('x')
    await expect(call(registry, 'write', ram, '/missing/x', payload)).rejects.toThrow(
      /parent directory does not exist/,
    )
  })

  it('read missing file throws', async () => {
    const { ram, registry } = setup()
    await expect(call(registry, 'read', ram, '/nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMResource readdir', () => {
  it('lists immediate children of a directory', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/data')
    await call(registry, 'write', ram, '/data/a', new Uint8Array())
    await call(registry, 'write', ram, '/data/b', new Uint8Array())
    await call(registry, 'mkdir', ram, '/data/sub')
    expect(await call(registry, 'readdir', ram, '/data')).toEqual([
      '/data/a',
      '/data/b',
      '/data/sub',
    ])
  })

  it('returns [] for empty directory', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/empty')
    expect(await call(registry, 'readdir', ram, '/empty')).toEqual([])
  })

  it('lists root entries from the auto-created / directory', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/a')
    await call(registry, 'write', ram, '/b', new Uint8Array())
    expect(await call(registry, 'readdir', ram, '/')).toEqual(['/a', '/b'])
  })

  it('throws when path is not a directory', async () => {
    const { ram, registry } = setup()
    await expect(call(registry, 'readdir', ram, '/missing')).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

describe('RAMResource stat', () => {
  it('reports type=DIRECTORY for known directories', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/data')
    const s = (await call(registry, 'stat', ram, '/data')) as { type: string; name: string }
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('data')
  })

  it('reports size for files', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/x', new TextEncoder().encode('hello'))
    const s = (await call(registry, 'stat', ram, '/x')) as { size: number; name: string }
    expect(s.size).toBe(5)
    expect(s.name).toBe('x')
  })

  it('throws for missing files', async () => {
    const { ram, registry } = setup()
    await expect(call(registry, 'stat', ram, '/gone')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMResource unlink + rmdir', () => {
  it('removes files', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/x', new Uint8Array([1]))
    await call(registry, 'unlink', ram, '/x')
    await expect(call(registry, 'read', ram, '/x')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes directories', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/d')
    await call(registry, 'rmdir', ram, '/d')
    await expect(call(registry, 'readdir', ram, '/d')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('RAMResource append + create + truncate', () => {
  it('append extends existing files', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/x', new TextEncoder().encode('hello'))
    await call(registry, 'append', ram, '/x', new TextEncoder().encode(' world'))
    const read = (await call(registry, 'read', ram, '/x')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('hello world')
  })

  it('append creates a new file when missing', async () => {
    const { ram, registry } = setup()
    await call(registry, 'append', ram, '/y', new TextEncoder().encode('new'))
    const read = (await call(registry, 'read', ram, '/y')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('new')
  })

  it('create makes an empty file', async () => {
    const { ram, registry } = setup()
    await call(registry, 'create', ram, '/z')
    expect(await call(registry, 'read', ram, '/z')).toEqual(new Uint8Array())
  })

  it('truncate pads with zeros when extending', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/f', new TextEncoder().encode('hi'))
    await call(registry, 'truncate', ram, '/f', 5)
    const read = (await call(registry, 'read', ram, '/f')) as Uint8Array
    expect(read).toEqual(new Uint8Array([104, 105, 0, 0, 0]))
  })

  it('truncate shortens existing files', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/f', new TextEncoder().encode('hello'))
    await call(registry, 'truncate', ram, '/f', 2)
    const read = (await call(registry, 'read', ram, '/f')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('he')
  })
})

describe('RAMResource rename', () => {
  it('renames a file', async () => {
    const { ram, registry } = setup()
    await call(registry, 'write', ram, '/src', new TextEncoder().encode('x'))
    await call(registry, 'rename', ram, '/src', PathSpec.fromStrPath('/dst'))
    await expect(call(registry, 'read', ram, '/src')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await call(registry, 'read', ram, '/dst')).toEqual(new TextEncoder().encode('x'))
  })

  it('renames a directory with its children', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/old')
    await call(registry, 'write', ram, '/old/a', new Uint8Array([1]))
    await call(registry, 'write', ram, '/old/b', new Uint8Array([2]))
    await call(registry, 'rename', ram, '/old', PathSpec.fromStrPath('/new'))
    expect(await call(registry, 'read', ram, '/new/a')).toEqual(new Uint8Array([1]))
    expect(await call(registry, 'read', ram, '/new/b')).toEqual(new Uint8Array([2]))
  })

  it('throws when source does not exist', async () => {
    const { ram, registry } = setup()
    await expect(
      call(registry, 'rename', ram, '/nope', PathSpec.fromStrPath('/dst')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMResource mkdir -p parents', () => {
  it('creates intermediate directories when parents=true', async () => {
    const { ram, registry } = setup()
    await call(registry, 'mkdir', ram, '/a/b/c', true)
    expect(ram.store.dirs.has('/a')).toBe(true)
    expect(ram.store.dirs.has('/a/b')).toBe(true)
    expect(ram.store.dirs.has('/a/b/c')).toBe(true)
  })

  it('throws without parents=true if intermediate missing', async () => {
    const { ram, registry } = setup()
    await expect(call(registry, 'mkdir', ram, '/x/y')).rejects.toThrow(/parent directory/)
  })
})

describe('RAMResource through Workspace', () => {
  it('Workspace auto-registers resource.ops() when ops registry is provided', async () => {
    const { ram, registry, ws } = setup()
    const [resolvedRes, resolvedPath, mode] = await ws.resolve('/ram/hello.txt')
    expect(resolvedRes).toBe(ram)

    const payload = new TextEncoder().encode('mirage')
    const acc = resolvedRes as unknown as Accessor
    await registry.call('write', resolvedRes.kind, acc, resolvedPath, [payload])
    const read = await registry.call('read', resolvedRes.kind, acc, resolvedPath)
    void mode
    expect(read).toEqual(payload)
    await ws.close()
  })
})
