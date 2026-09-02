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

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountBackend, MountMode } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { NFSConfig } from './nfs/config.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from './workspace.ts'

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(),
  runMount: vi.fn(),
  runUmount: vi.fn(),
  prepareMountpoint: vi.fn(),
  stop: vi.fn(),
  flushAll: vi.fn(),
}))

vi.mock('./nfs/mount.ts', () => ({
  startServer: mocks.startServer,
  runMount: mocks.runMount,
  runUmount: mocks.runUmount,
  prepareMountpoint: mocks.prepareMountpoint,
}))

const PORT = 20490

function nfsWorkspace(mountpoint?: string): Workspace {
  return new Workspace(
    {
      '/data': new Mount(new RAMResource(), {
        backend: MountBackend.NFS,
        ...(mountpoint !== undefined ? { mountpoint } : {}),
      }),
    },
    { mode: MountMode.WRITE },
  )
}

describe('Workspace nfs backend (without a real kernel mount)', () => {
  beforeEach(() => {
    let unnamed = 0
    mocks.startServer.mockReset()
    mocks.runMount.mockReset()
    mocks.runUmount.mockReset()
    mocks.prepareMountpoint.mockReset()
    mocks.stop.mockReset()
    mocks.flushAll.mockReset()

    mocks.prepareMountpoint.mockImplementation((mountpoint?: string) => {
      if (mountpoint !== undefined) return [mountpoint, false]
      unnamed += 1
      return [`/tmp/fake-nfs-${String(unnamed)}`, true]
    })
    mocks.flushAll.mockImplementation(() => Promise.resolve())
    mocks.startServer.mockImplementation(() =>
      Promise.resolve([{ flushAll: mocks.flushAll }, { port: () => PORT, stop: mocks.stop }]),
    )
    mocks.runMount.mockImplementation(() => Promise.resolve())
    mocks.runUmount.mockImplementation(() => Promise.resolve())
  })

  it('mounts a declared nfs Mount and reports it as an nfs mountpoint', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()

    expect(ws.nfsMountpoints).toEqual({ '/data': '/tmp/pinned-data' })
    // The mount options ride on the config, so the mount is asserted
    // with it: a mountpoint mounted without it is a hard mount, which is
    // the one that wedges the host when the server stops.
    expect(mocks.runMount).toHaveBeenCalledWith(
      '/tmp/pinned-data',
      PORT,
      '/data',
      expect.objectContaining({ soft: true }),
    )

    await ws.close()
  })

  it('keeps nfs mounts out of the fuse view', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()

    expect(ws.fuseMountpoints).toEqual({})
    expect(ws.fuseMountpoint).toBeNull()

    await ws.close()
  })

  it('mounts the declaration on the first execute', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.execute('echo hi > /data/x.txt')

    expect(ws.nfsMountpoints).toEqual({ '/data': '/tmp/pinned-data' })

    await ws.close()
  })

  it('backs every prefix with one server', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    const second = await ws.addNfsMount('/data/sub', '/tmp/pinned-sub')

    expect(second).toBe('/tmp/pinned-sub')
    expect(mocks.startServer).toHaveBeenCalledTimes(1)
    expect(Object.keys(ws.nfsMountpoints).sort()).toEqual(['/data', '/data/sub'])

    await ws.close()
  })

  it('unmounts one prefix without stopping the server', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    await ws.removeNfsMount('/data')

    expect(ws.nfsMountpoints).toEqual({})
    expect(mocks.runUmount).toHaveBeenCalledWith('/tmp/pinned-data')
    expect(mocks.stop).not.toHaveBeenCalled()

    await ws.close()
  })

  it('flushes and stops the server on close', async () => {
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    await ws.close()

    expect(mocks.runUmount).toHaveBeenCalledWith('/tmp/pinned-data')
    expect(mocks.flushAll).toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalled()
    expect(ws.nfsMountpoints).toEqual({})
  })

  it('gives a session-scoped mount its own server', async () => {
    // One server serves one delegate, so narrowing to a session cannot
    // reuse the unscoped one: the two views need two servers.
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    ws.createSession('agent')

    await ws.addNfsMount('/data', '/tmp/agent-data', undefined, 'agent')

    expect(mocks.startServer).toHaveBeenCalledTimes(2)
    expect(mocks.startServer.mock.calls[0]?.[2] ?? null).toBeNull()
    expect(mocks.startServer.mock.calls[1]?.[2]).toBeDefined()
    expect(Object.keys(ws.nfsMountpoints).sort()).toEqual(['/data', '/data@agent'])

    await ws.close()
  })

  it('routes a session-scoped mount through addFuseMount too', async () => {
    // The constructor's own route carries a backend, so it has to reach
    // the same place the explicit call does.
    const ws = nfsWorkspace('/tmp/pinned-data')
    await ws.nfsReady()
    ws.createSession('agent')

    await ws.addFuseMount('/data', '/tmp/agent-data', 'agent', MountBackend.NFS)

    expect(mocks.startServer).toHaveBeenCalledTimes(2)
    expect(ws.nfsMountpoints['/data@agent']).toBe('/tmp/agent-data')

    await ws.close()
  })

  it('refuses a mountpoint another prefix already serves', async () => {
    const ws = nfsWorkspace('/tmp/shared')
    await ws.nfsReady()

    await expect(ws.addNfsMount('/data/sub', '/tmp/shared')).rejects.toThrow(/already used/)

    await ws.close()
  })

  it('honors an NFSConfig declared on the mount', async () => {
    // A declared mount is the only place a user can express these, so
    // without this `backend: nfs` in a spec could not choose a port, an
    // idle window or a soft mount -- only addNfsMount could be tuned.
    const ws = new Workspace(
      {
        '/data': new Mount(new RAMResource(), {
          backend: MountBackend.NFS,
          mountpoint: '/tmp/pinned-data',
          nfsConfig: new NFSConfig({ port: 12345, soft: false }),
        }),
      },
      { mode: MountMode.WRITE },
    )
    await ws.nfsReady()

    // Read the argument rather than deep-matching the call: the first
    // two are the workspace and its prefix, and a deep compare walks
    // that whole object graph.
    const passed = mocks.startServer.mock.calls[0]?.[1] as NFSConfig | undefined
    expect(passed?.port).toBe(12345)
    expect(passed?.soft).toBe(false)

    await ws.close()
  })
})
