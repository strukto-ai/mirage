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

import { existsSync, mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountBackend, MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NFSModule from '../mount/nfs.ts'
import { Workspace } from '../workspace.ts'

const calls = vi.hoisted(() => ({
  mounted: [] as [number, string][],
  unmounted: [] as string[],
  refuse: false,
}))

vi.mock('../mount/nfs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof NFSModule>()
  return {
    ...original,
    mountNfs: (port: number, mountpoint: string): Promise<void> => {
      calls.mounted.push([port, mountpoint])
      return calls.refuse ? Promise.reject(new Error('nfs mount refused')) : Promise.resolve()
    },
    unmountNfs: (mountpoint: string): Promise<void> => {
      calls.unmounted.push(mountpoint)
      return Promise.resolve()
    },
  }
})

function nullCall(port: number): Promise<number> {
  const body = new Uint8Array(40)
  const view = new DataView(body.buffer)
  ;[7, 0, 2, 100003, 3, 0, 0, 0, 0, 0].forEach((value, index) => {
    view.setUint32(index * 4, value)
  })
  const record = new Uint8Array(44)
  new DataView(record.buffer).setUint32(0, (body.length | 0x80000000) >>> 0)
  record.set(body, 4)
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(record))
    socket.once('data', (data: Buffer) => {
      socket.destroy()
      resolve(data.readUInt32BE(4))
    })
    socket.once('error', reject)
  })
}

describe('NFSManager', () => {
  beforeEach(() => {
    calls.mounted.length = 0
    calls.unmounted.length = 0
    calls.refuse = false
  })

  it('serves the tree until the mount is removed', async () => {
    const ws = new Workspace({ '/a/': new RAMVFS() }, { mode: MountMode.WRITE })
    const pinned = join(mkdtempSync(join(tmpdir(), 'nfs-test-')), 'mp')
    const mountpoint = await ws.addFuseMount('/a/', pinned, undefined, MountBackend.NFS)
    expect(ws.fuseMountpoints).toEqual({ '/a/': mountpoint })
    const [port, at] = calls.mounted[0] ?? [0, '']
    expect(at).toBe(mountpoint)
    expect(await nullCall(port)).toBe(7)
    await ws.removeFuseMount('/a/')
    expect(calls.unmounted).toEqual([mountpoint])
    expect(ws.fuseMountpoints).toEqual({})
    await expect(nullCall(port)).rejects.toThrow()
    await ws.close()
  })

  it('stops the server and leaves no temp dir when the mount is refused', async () => {
    calls.refuse = true
    const ws = new Workspace({ '/a/': new RAMVFS() }, { mode: MountMode.WRITE })
    await expect(ws.addFuseMount('/a/', undefined, undefined, MountBackend.NFS)).rejects.toThrow(
      'refused',
    )
    expect(ws.fuseMountpoints).toEqual({})
    const [port, mountpoint] = calls.mounted[0] ?? [0, '']
    expect(existsSync(mountpoint)).toBe(false)
    await expect(nullCall(port)).rejects.toThrow()
    await ws.close()
  })

  it('brings a declared nfs mount up with the workspace', async () => {
    const mountpoint = join(mkdtempSync(join(tmpdir(), 'nfs-test-')), 'mp')
    const ws = new Workspace({
      '/a/': new Mount(new RAMVFS(), {
        mode: MountMode.READ,
        backend: MountBackend.NFS,
        mountpoint,
      }),
    })
    await ws.fuseReady()
    expect(ws.fuseMountpoints).toEqual({ '/a/': mountpoint })
    expect(calls.mounted[0]?.[1]).toBe(mountpoint)
    await ws.close()
    expect(calls.unmounted).toEqual([mountpoint])
  })
})
