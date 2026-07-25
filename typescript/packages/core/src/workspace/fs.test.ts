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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { enotdir } from '../utils/errors.ts'
import { Workspace } from './workspace.ts'

function mkWorkspace(): Workspace {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  return new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
}

// The Workspace constructor re-registers each mount's ops, so the failing
// stat has to land on the registry after the workspace is built.
function mkFailingStat(err: unknown): Workspace {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
  ops.register({
    name: 'stat',
    resource: resource.kind,
    filetype: null,
    fn: () => {
      throw err
    },
    write: false,
  })
  return ws
}

describe('WorkspaceFS', () => {
  it('writeFile + readFile round-trips bytes', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const text = await ws.fs.readFileText('/data/a.txt')
    expect(text).toBe('hello')
  })

  it('writeFile accepts Uint8Array', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/b.bin', new Uint8Array([1, 2, 3]))
    const bytes = await ws.fs.readFile('/data/b.bin')
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('mkdir + readdir lists entries', async () => {
    const ws = mkWorkspace()
    await ws.fs.mkdir('/data/sub')
    await ws.fs.writeFile('/data/sub/x.txt', 'x')
    await ws.fs.writeFile('/data/sub/y.txt', 'y')
    const entries = await ws.fs.readdir('/data/sub')
    expect(entries.sort()).toEqual(['/data/sub/x.txt', '/data/sub/y.txt'])
  })

  it('exists returns true for existing files and dirs', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/hi.txt', 'hi')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.exists('/data/hi.txt')).toBe(true)
    expect(await ws.fs.exists('/data/dir')).toBe(true)
    expect(await ws.fs.exists('/data/nope')).toBe(false)
  })

  it('isDir distinguishes files from directories', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/file.txt', 'x')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.isDir('/data/dir')).toBe(true)
    expect(await ws.fs.isDir('/data/file.txt')).toBe(false)
    expect(await ws.fs.isFile('/data/file.txt')).toBe(true)
    expect(await ws.fs.isFile('/data/dir')).toBe(false)
  })

  it('stat returns size', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const s = await ws.fs.stat('/data/a.txt')
    expect(s.size).toBe(5)
  })

  it('unlink removes file', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/gone.txt', 'x')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(true)
    await ws.fs.unlink('/data/gone.txt')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(false)
  })

  it('cat reads file as string', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/t.txt', 'content')
    expect(await ws.fs.cat('/data/t.txt')).toBe('content')
  })
})

describe('WorkspaceFS existence probes', () => {
  it('report false for a missing path', async () => {
    const ws = mkWorkspace()
    expect(await ws.fs.exists('/data/nope')).toBe(false)
    expect(await ws.fs.isDir('/data/nope')).toBe(false)
    expect(await ws.fs.isFile('/data/nope')).toBe(false)
  })

  it('report false for a path outside every mount', async () => {
    const ws = mkWorkspace()
    expect(await ws.fs.exists('/nowhere/x')).toBe(false)
    expect(await ws.fs.isDir('/nowhere/x')).toBe(false)
    expect(await ws.fs.isFile('/nowhere/x')).toBe(false)
  })

  it('propagate a backend failure instead of reporting it as missing', async () => {
    const ws = mkFailingStat(new Error('401 Unauthorized'))
    await expect(ws.fs.exists('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.fs.isDir('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.fs.isFile('/data/a.txt')).rejects.toThrow('401 Unauthorized')
  })

  it('propagate a non-ENOENT fs error, matching Python which swallows only two', async () => {
    const ws = mkFailingStat(enotdir('/data/a.txt'))
    await expect(ws.fs.exists('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.fs.isDir('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.fs.isFile('/data/a.txt')).rejects.toThrow('/data/a.txt')
  })
})
