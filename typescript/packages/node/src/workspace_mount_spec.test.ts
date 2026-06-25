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

import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Mount } from './workspace/mount_spec.ts'
import { Workspace } from './workspace.ts'

const mocks = vi.hoisted(() => ({
  forceUnmount: vi.fn(),
  mount: vi.fn(),
}))

vi.mock('./fuse/mount.ts', () => ({
  forceUnmount: mocks.forceUnmount,
  mount: mocks.mount,
}))

describe('Workspace Mount spec (per-mount fuse, without a real mount)', () => {
  beforeEach(() => {
    mocks.mount.mockReset()
    // Resolve each mount to a fake mountpoint: pinned target wins, else a
    // unique temp-style path keyed by rootPrefix.
    mocks.mount.mockImplementation((_ws, options: { rootPrefix?: string; mountpoint?: string }) =>
      Promise.resolve({
        mountpoint:
          options.mountpoint ?? `/tmp/fake-${(options.rootPrefix ?? '/').replace(/\//g, '_')}`,
        ownsMountpoint: options.mountpoint === undefined,
        unmount: () => Promise.resolve(),
      }),
    )
  })

  it('exposes a lone fuse Mount as fuseMountpoint after fuseReady', async () => {
    const ws = new Workspace({ '/a': new Mount(new RAMResource(), { fuse: true }) })
    await ws.fuseReady()

    expect(ws.fuseMountpoint).toBe('/tmp/fake-_a')
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/fake-_a' })

    await ws.close()
  })

  it('pins the mountpoint when fuse is a string', async () => {
    const ws = new Workspace({ '/a': new Mount(new RAMResource(), { fuse: '/tmp/pinned' }) })
    await ws.fuseReady()

    expect(mocks.mount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rootPrefix: '/a', mountpoint: '/tmp/pinned' }),
    )
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/pinned' })

    await ws.close()
  })

  it('exposes multiple fuse Mounts via fuseMountpoints; fuseMountpoint throws', async () => {
    const ws = new Workspace({
      '/a': new Mount(new RAMResource(), { fuse: true }),
      '/b': new Mount(new RAMResource(), { fuse: true }),
    })
    await ws.fuseReady()

    expect(ws.fuseMountpoints).toEqual({
      '/a': '/tmp/fake-_a',
      '/b': '/tmp/fake-_b',
    })
    expect(() => ws.fuseMountpoint).toThrow()

    await ws.close()
  })

  it('does not fuse a bare Resource value', async () => {
    const ws = new Workspace({ '/a': new RAMResource() })
    await ws.fuseReady()

    expect(ws.fuseMountpoints).toEqual({})
    expect(ws.fuseMountpoint).toBeNull()
    expect(mocks.mount).not.toHaveBeenCalled()

    await ws.close()
  })

  it('does not fuse a Mount without fuse, and applies the mode override', async () => {
    const ws = new Workspace({ '/a': new Mount(new RAMResource(), { mode: MountMode.READ }) })
    await ws.fuseReady()

    expect(ws.fuseMountpoints).toEqual({})
    expect(mocks.mount).not.toHaveBeenCalled()

    const [, , mode] = await ws.resolve('/a')
    expect(mode).toBe(MountMode.READ)

    await ws.close()
  })

  it('unmounts on close so fuseMountpoints empties', async () => {
    const ws = new Workspace({ '/a': new Mount(new RAMResource(), { fuse: true }) })
    await ws.fuseReady()
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/fake-_a' })

    await ws.close()

    expect(ws.fuseMountpoints).toEqual({})
  })

  it('addFuseMount registers each mount; rejects a colliding pinned path before mounting', async () => {
    const ws = new Workspace({ '/a': new RAMResource(), '/b': new RAMResource() })
    await ws.addFuseMount('/a', '/tmp/shared')
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/shared' })

    await expect(ws.addFuseMount('/b', '/tmp/shared')).rejects.toThrow(/already used by prefix/)
    // The collision is rejected before mount() runs for /b.
    expect(mocks.mount).toHaveBeenCalledTimes(1)
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/shared' })

    await ws.close()
  })

  it('removeFuseMount unmounts and deregisters a single prefix', async () => {
    const ws = new Workspace({ '/a': new RAMResource(), '/b': new RAMResource() })
    await ws.addFuseMount('/a', '/tmp/mp-a')
    await ws.addFuseMount('/b', '/tmp/mp-b')
    expect(ws.fuseMountpoints).toEqual({ '/a': '/tmp/mp-a', '/b': '/tmp/mp-b' })

    await ws.removeFuseMount('/a')
    expect(ws.fuseMountpoints).toEqual({ '/b': '/tmp/mp-b' })

    await ws.close()
  })
})
