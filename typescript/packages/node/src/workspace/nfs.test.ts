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

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import type { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import { NFSConfig } from '../nfs/config.ts'
import type * as MountModule from '../nfs/mount.ts'
import type { NFSServerHandle } from '../nfs/mount.ts'
import { Workspace } from '../workspace.ts'
import { NFSManager } from './nfs.ts'

const { touched } = vi.hoisted(() => ({ touched: [] as (string | undefined)[] }))

vi.mock('../nfs/mount.ts', async (importOriginal) => {
  const original = await importOriginal<typeof MountModule>()
  return {
    ...original,
    prepareMountpoint: (mountpoint?: string) => {
      touched.push(mountpoint)
      return original.prepareMountpoint(mountpoint)
    },
  }
})

class FakeHandle implements NFSServerHandle {
  stopped = 0

  port(): number {
    return 12345
  }

  stop(): void {
    this.stopped += 1
  }
}

class FakeFS {
  flushed = 0

  flushAll(): Promise<void> {
    this.flushed += 1
    return Promise.resolve()
  }
}

/** Injected start/mount/unmount fns, recording every call. */
class Recorder {
  readonly handle = new FakeHandle()
  readonly fs = new FakeFS()
  readonly starts: NFSConfig[] = []
  readonly mounts: [string, number, string][] = []
  readonly unmounts: string[] = []
  readonly mountConfigs: NFSConfig[] = []
  readonly sessions: (Session | null)[] = []

  start = (
    _ws: CoreWorkspace,
    config: NFSConfig,
    session?: Session | null,
  ): Promise<[FakeFS, FakeHandle]> => {
    this.starts.push(config)
    this.sessions.push(session ?? null)
    return Promise.resolve([this.fs, this.handle])
  }

  mount = (
    mountpoint: string,
    port: number,
    exportPath: string,
    config: NFSConfig,
  ): Promise<void> => {
    this.mounts.push([mountpoint, port, exportPath])
    this.mountConfigs.push(config)
    return Promise.resolve()
  }

  unmount = (mountpoint: string): Promise<void> => {
    this.unmounts.push(mountpoint)
    return Promise.resolve()
  }
}

function make(): [NFSManager, Recorder] {
  const rec = new Recorder()
  const manager = new NFSManager({
    startFn: rec.start,
    mountFn: rec.mount,
    unmountFn: rec.unmount,
  })
  return [manager, rec]
}

function workspace(): Workspace {
  return new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
}

// Recorded rather than left behind: these are scratch mountpoints for a
// manager that never mounts anything, so nothing unmounts them and a
// full test run used to leave one temp directory per case in /tmp.
const bases: string[] = []

function tempBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'mirage-nfs-mgr-'))
  bases.push(base)
  return base
}

describe('NFSManager', () => {
  beforeEach(() => {
    touched.length = 0
  })

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
  })

  it('serves many kernel mounts from one server', async () => {
    const [manager, rec] = make()
    const ws = workspace()
    const base = tempBase()
    const a = await manager.setup(ws, '/', join(base, 'a'))
    const b = await manager.setup(ws, '/docs', join(base, 'b'))
    expect(rec.starts).toHaveLength(1)
    expect(rec.mounts).toEqual([
      [a, 12345, '/'],
      [b, 12345, '/docs'],
    ])
    expect(manager.mountpoints).toEqual({ '/': a, '/docs': b })
  })

  it('honors the config only on the first call, which starts the server', async () => {
    const [manager, rec] = make()
    const ws = workspace()
    const base = tempBase()
    const first = new NFSConfig({ port: 0 })
    await manager.setup(ws, '/', join(base, 'a'), first)
    await manager.setup(ws, '/docs', join(base, 'b'), new NFSConfig({ port: 20491 }))
    expect(rec.starts).toEqual([first])
  })

  it('exports the prefix it was handed', async () => {
    const [manager, rec] = make()
    await manager.setup(workspace(), '/deep/tree', join(tempBase(), 'm'))
    expect(rec.mounts[0]?.[2]).toBe('/deep/tree')
  })

  it('refuses a mountpoint that already serves another prefix', async () => {
    const [manager, rec] = make()
    const ws = workspace()
    const target = join(tempBase(), 'same')
    await manager.setup(ws, '/', target)
    await expect(manager.setup(ws, '/docs', target)).rejects.toThrow(/already serves/)
    expect(rec.mounts).toHaveLength(1)
  })

  it('answers a collision from the registry before touching the path', async () => {
    // A colliding mountpoint may be a LIVE mount served by this very
    // loop, and prepareMountpoint stats it (mkdir -> isdir), which is the
    // self-touch deadlock in miniature. The registry check comes first.
    const [manager] = make()
    const ws = workspace()
    const target = join(tempBase(), 'same')
    await manager.setup(ws, '/', target)
    touched.length = 0
    await expect(manager.setup(ws, '/docs', target)).rejects.toThrow(/already serves/)
    expect(touched).toEqual([])
  })

  it('leaves no registration behind when the mount fails', async () => {
    const rec = new Recorder()
    const manager = new NFSManager({
      startFn: rec.start,
      mountFn: () => Promise.reject(new Error('mount refused')),
      unmountFn: rec.unmount,
    })
    await expect(manager.setup(workspace(), '/', join(tempBase(), 'm'))).rejects.toThrow(
      'mount refused',
    )
    expect(manager.mountpoints).toEqual({})
  })

  it('removes the temporary directory it created for a failed mount', async () => {
    const rec = new Recorder()
    const manager = new NFSManager({
      startFn: rec.start,
      mountFn: () => Promise.reject(new Error('mount refused')),
      unmountFn: rec.unmount,
    })
    await expect(manager.setup(workspace(), '/')).rejects.toThrow('mount refused')
    const created = touched.length
    expect(created).toBe(1)
    expect(manager.mountpoints).toEqual({})
  })

  it('unmounts one prefix and leaves the rest', async () => {
    const [manager, rec] = make()
    const ws = workspace()
    const base = tempBase()
    const a = await manager.setup(ws, '/', join(base, 'a'))
    await manager.setup(ws, '/docs', join(base, 'b'))
    await manager.unmount('/')
    expect(rec.unmounts).toEqual([a])
    expect(Object.keys(manager.mountpoints)).toEqual(['/docs'])
  })

  it('ignores an unmount for a prefix it does not serve', async () => {
    const [manager, rec] = make()
    await manager.unmount('/nope')
    expect(rec.unmounts).toEqual([])
  })

  it('unmounts, flushes, then stops on close', async () => {
    const [manager, rec] = make()
    const a = await manager.setup(workspace(), '/', join(tempBase(), 'a'))
    await manager.close()
    // The order is load-bearing: unmounting makes the client flush its
    // dirty pages as final WRITEs, which need a live server.
    expect(rec.unmounts).toEqual([a])
    expect(rec.fs.flushed).toBe(1)
    expect(rec.handle.stopped).toBe(1)
    expect(manager.mountpoints).toEqual({})
  })

  it('is idempotent and safe to close before any setup', async () => {
    const [manager, rec] = make()
    await manager.close()
    await manager.close()
    expect(rec.unmounts).toEqual([])
    expect(rec.handle.stopped).toBe(0)
  })

  it('removes a mountpoint it owns and keeps one the caller named', async () => {
    const [manager] = make()
    const ws = workspace()
    const named = join(tempBase(), 'named')
    const owned = await manager.setup(ws, '/tmp-owned')
    await manager.setup(ws, '/named', named)
    await manager.close()
    expect(existsSync(owned)).toBe(false)
    expect(existsSync(named)).toBe(true)
  })

  it('mounts with the config that started the server', async () => {
    // The mount command carries the resilience knobs, so the seam has to
    // hand the same config to the mount that started the server: a
    // second mountpoint answering to different timeouts than the first
    // is a mount the teardown cannot reason about.
    const [manager, rec] = make()
    const config = new NFSConfig({ timeo: 11, retrans: 2 })
    const target = workspace()
    await manager.setup(target, '/', '/tmp/mirage-nfs-a', config)
    await manager.setup(target, '/docs', '/tmp/mirage-nfs-b')
    expect(rec.mountConfigs).toEqual([config, config])
  })

  it('hands the session to the server, not to each mount', async () => {
    // One server serves one delegate, so the scoping happens where the
    // server is started.
    const [manager, rec] = make()
    const session = { sessionId: 'agent' } as unknown as Session
    await manager.setup(workspace(), '/', '/tmp/mirage-nfs-s1', undefined, session)
    expect(rec.sessions).toEqual([session])
  })

  it('refuses a second session on one server', async () => {
    // Silently serving the first session's view under the second's name
    // is the failure this prevents.
    const [manager] = make()
    const target = workspace()
    await manager.setup(target, '/', '/tmp/mirage-nfs-s2', undefined, {
      sessionId: 'a',
    } as unknown as Session)
    await expect(
      manager.setup(target, '/docs', '/tmp/mirage-nfs-s3', undefined, {
        sessionId: 'b',
      } as unknown as Session),
    ).rejects.toThrow(/different session/)
  })

  it('reuses the server for the same session', async () => {
    const [manager, rec] = make()
    const session = { sessionId: 'agent' } as unknown as Session
    const target = workspace()
    await manager.setup(target, '/', '/tmp/mirage-nfs-s4', undefined, session)
    await manager.setup(target, '/docs', '/tmp/mirage-nfs-s5', undefined, session)
    expect(rec.starts).toHaveLength(1)
    expect(Object.keys(manager.mountpoints)).toHaveLength(2)
  })
})
