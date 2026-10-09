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
import { mkdir as coreMkdir } from '../../core/ram/mkdir.ts'
import { ops } from '../../test-utils.ts'
import { FileType, MountMode, PathSpec, VFSName } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from './ram.ts'

function setup(): { ram: RAMVFS; ws: Workspace } {
  const ram = new RAMVFS()
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
  return { ram, ws }
}

function call(name: string, ram: RAMVFS, path: string, ...args: unknown[]): Promise<unknown> {
  return ops(ram).call(name, PathSpec.fromStrPath(path), args)
}

describe('RAMVFS.kind', () => {
  it('is VFSName.RAM', () => {
    expect(new RAMVFS().name).toBe(VFSName.RAM)
  })
})

describe('RAMVFS write + read', () => {
  it('round-trips bytes under a nested path after mkdir of the parent', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/data')
    const payload = new TextEncoder().encode('hello')
    await call('write', ram, '/data/hello.txt', payload)
    const read = await call('read', ram, '/data/hello.txt')
    expect(read).toEqual(payload)
  })

  it('write under /root works without mkdir', async () => {
    const { ram } = setup()
    const payload = new TextEncoder().encode('x')
    await call('write', ram, '/x', payload)
    expect(await call('read', ram, '/x')).toEqual(payload)
  })

  it('write under nested missing parent throws', async () => {
    // The operand is what a GNU stderr line names, so the error carries the
    // virtual path and an errno, not the internal parent phrasing.
    const { ram } = setup()
    const payload = new TextEncoder().encode('x')
    await expect(call('write', ram, '/missing/x', payload)).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/missing/x',
    })
  })

  it('read missing file throws', async () => {
    const { ram } = setup()
    await expect(call('read', ram, '/nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMVFS readdir', () => {
  it('lists immediate children of a directory', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/data')
    await call('write', ram, '/data/a', new Uint8Array())
    await call('write', ram, '/data/b', new Uint8Array())
    await call('mkdir', ram, '/data/sub')
    expect(await call('readdir', ram, '/data')).toEqual(['/data/a', '/data/b', '/data/sub'])
  })

  it('returns [] for empty directory', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/empty')
    expect(await call('readdir', ram, '/empty')).toEqual([])
  })

  it('lists root entries from the auto-created / directory', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/a')
    await call('write', ram, '/b', new Uint8Array())
    expect(await call('readdir', ram, '/')).toEqual(['/a', '/b'])
  })

  it('throws ENOENT when the path does not exist', async () => {
    const { ram } = setup()
    await expect(call('readdir', ram, '/missing')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(call('readdir', ram, '/missing/deeper')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOTDIR when a path component is a file', async () => {
    const { ram } = setup()
    await call('write', ram, '/a.txt', new Uint8Array())
    await expect(call('readdir', ram, '/a.txt')).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(call('readdir', ram, '/a.txt/x')).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('throws ENOENT for an orphan whose parent directory is missing', async () => {
    // The store can hold a file under a key whose ancestors are not in the
    // dir set: a restored snapshot or another client writing to the same
    // Redis can seed one, so readdir stays defensive about it. Seeded
    // directly rather than through rename, which now refuses to create one.
    // The walk must stop at /missing, the way the kernel would.
    const { ram } = setup()
    ram.store.files.set('/missing/a.txt', new Uint8Array())
    for (const p of ['/missing', '/missing/a.txt/x', '/missing/a.txt/x/y']) {
      await expect(call('readdir', ram, p)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  })
})

describe('RAMVFS stat', () => {
  it('reports type=DIRECTORY for known directories', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/data')
    const s = (await call('stat', ram, '/data')) as { type: string; name: string }
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('data')
  })

  it('reports size for files', async () => {
    const { ram } = setup()
    await call('write', ram, '/x', new TextEncoder().encode('hello'))
    const s = (await call('stat', ram, '/x')) as { size: number; name: string }
    expect(s.size).toBe(5)
    expect(s.name).toBe('x')
  })

  it('throws for missing files', async () => {
    const { ram } = setup()
    await expect(call('stat', ram, '/gone')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMVFS unlink + rmdir', () => {
  it('removes files', async () => {
    const { ram } = setup()
    await call('write', ram, '/x', new Uint8Array([1]))
    await call('unlink', ram, '/x')
    await expect(call('read', ram, '/x')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes directories', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/d')
    await call('rmdir', ram, '/d')
    await expect(call('readdir', ram, '/d')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RAMVFS append + create + truncate', () => {
  it('append extends existing files', async () => {
    const { ram } = setup()
    await call('write', ram, '/x', new TextEncoder().encode('hello'))
    await call('append', ram, '/x', new TextEncoder().encode(' world'))
    const read = (await call('read', ram, '/x')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('hello world')
  })

  it('append creates a new file when missing', async () => {
    const { ram } = setup()
    await call('append', ram, '/y', new TextEncoder().encode('new'))
    const read = (await call('read', ram, '/y')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('new')
  })

  it('create makes an empty file', async () => {
    const { ram } = setup()
    await call('create', ram, '/z')
    expect(await call('read', ram, '/z')).toEqual(new Uint8Array())
  })

  it('truncate pads with zeros when extending', async () => {
    const { ram } = setup()
    await call('write', ram, '/f', new TextEncoder().encode('hi'))
    await call('truncate', ram, '/f', 5)
    const read = (await call('read', ram, '/f')) as Uint8Array
    expect(read).toEqual(new Uint8Array([104, 105, 0, 0, 0]))
  })

  it('truncate shortens existing files', async () => {
    const { ram } = setup()
    await call('write', ram, '/f', new TextEncoder().encode('hello'))
    await call('truncate', ram, '/f', 2)
    const read = (await call('read', ram, '/f')) as Uint8Array
    expect(new TextDecoder().decode(read)).toBe('he')
  })
})

describe('RAMVFS rename', () => {
  it('renames a file', async () => {
    const { ram } = setup()
    await call('write', ram, '/src', new TextEncoder().encode('x'))
    await call('rename', ram, '/src', PathSpec.fromStrPath('/dst'))
    await expect(call('read', ram, '/src')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await call('read', ram, '/dst')).toEqual(new TextEncoder().encode('x'))
  })

  it('renames a directory with its children', async () => {
    const { ram } = setup()
    await call('mkdir', ram, '/old')
    await call('write', ram, '/old/a', new Uint8Array([1]))
    await call('write', ram, '/old/b', new Uint8Array([2]))
    await call('rename', ram, '/old', PathSpec.fromStrPath('/new'))
    expect(await call('read', ram, '/new/a')).toEqual(new Uint8Array([1]))
    expect(await call('read', ram, '/new/b')).toEqual(new Uint8Array([2]))
  })

  it('throws when source does not exist', async () => {
    const { ram } = setup()
    await expect(call('rename', ram, '/nope', PathSpec.fromStrPath('/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('RAMVFS mkdir -p parents', () => {
  it('creates intermediate directories when parents=true (core mkdir)', async () => {
    const { ram } = setup()
    await coreMkdir(ram.accessor, PathSpec.fromStrPath('/a/b/c'), true)
    expect(ram.store.dirs.has('/a')).toBe(true)
    expect(ram.store.dirs.has('/a/b')).toBe(true)
    expect(ram.store.dirs.has('/a/b/c')).toBe(true)
  })

  it('the mkdir op throws if an intermediate directory is missing', async () => {
    // A bare Error here would not be classified as a filesystem failure, so
    // the command layer could not report it with a GNU strerror.
    const { ram } = setup()
    await expect(call('mkdir', ram, '/x/y')).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/x/y',
    })
  })

  it('mkdir -p across a plain file names the component and keeps the file', async () => {
    const { ram } = setup()
    await ops(ram).write(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('hi'))
    await expect(ops(ram).mkdir(PathSpec.fromStrPath('/f.txt/y'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/f.txt',
    })
    expect(ram.accessor.store.dirs.has('/f.txt')).toBe(false)
    expect(ram.accessor.store.files.has('/f.txt')).toBe(true)
  })

  it('mkdir -p onto a plain file target is EEXIST', async () => {
    const { ram } = setup()
    await ops(ram).write(PathSpec.fromStrPath('/f.txt'), new Uint8Array())
    await expect(ops(ram).mkdir(PathSpec.fromStrPath('/f.txt'), true)).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  it('mkdir refuses an existing target, and -p is the idempotent form (GNU)', async () => {
    const { ram } = setup()
    await ops(ram).mkdir(PathSpec.fromStrPath('/d'))
    await expect(ops(ram).mkdir(PathSpec.fromStrPath('/d'))).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await ops(ram).mkdir(PathSpec.fromStrPath('/d'), true)
    expect(ram.accessor.store.dirs.has('/d')).toBe(true)
  })
})

describe('RAMVFS through Workspace', () => {
  it('the workspace dispatcher serves the VFS functions', async () => {
    const { ram, ws } = setup()
    const [resolvedRes] = await ws.resolve('/ram/hello.txt')
    expect(resolvedRes).toBe(ram)

    const payload = new TextEncoder().encode('mirage')
    await ws.dispatch('write', '/ram/hello.txt', [payload])
    const read = await ws.dispatch('read', '/ram/hello.txt')
    expect(read).toEqual(payload)
    await ws.close()
  })
})
