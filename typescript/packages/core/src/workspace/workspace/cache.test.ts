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
import { type CacheConfig, CacheType, type RedisCacheConfig } from '../../cache/file/config.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { IndexType, LookupStatus } from '../../cache/index/config.ts'
import { MountMode } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import type { WorkspaceOptions } from './types.ts'
import { Workspace } from './workspace.ts'
import { Mount } from '../mount/spec.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { buildFileCache, registerFileCacheStore } from './cache.ts'
import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { GWS } from '../../commands/cli/builtin/gws/index.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'

describe('buildFileCache', () => {
  it('defaults to RAM sized by cacheLimit', () => {
    const cache = buildFileCache(undefined, 1024)
    expect(cache).toBeInstanceOf(RAMFileCacheStore)
    expect(cache.cacheLimit).toBe(1024)
  })

  it('a config limit wins over the legacy cacheLimit knob', () => {
    const cache = buildFileCache({ type: CacheType.RAM, limit: 2048 }, 1024)
    expect(cache.cacheLimit).toBe(2048)
  })

  it('names the package to import rather than degrading to RAM', () => {
    // Silently handing back a RAM cache would look like it worked while
    // nothing was shared between processes.
    expect(() => buildFileCache({ type: 'memcached' as CacheType })).toThrow(
      /no 'memcached' file cache is registered/,
    )
  })

  it('builds a registered type through its factory', () => {
    const store = new RAMFileCacheStore({ limit: 7 })
    registerFileCacheStore('probe' as CacheType, () => store)
    expect(buildFileCache({ type: 'probe' as CacheType })).toBe(store)
  })

  it('hands a registered factory the camelCase config', () => {
    const seen: RedisCacheConfig[] = []
    registerFileCacheStore('probe-seen' as CacheType, (config) => {
      seen.push(config)
      return new RAMFileCacheStore({ limit: 7 })
    })
    buildFileCache({ type: 'probe-seen', key_prefix: 'p:' } as unknown as CacheConfig)
    expect(seen).toEqual([{ type: 'probe-seen', keyPrefix: 'p:' }])
  })
})

describe('the workspace cache', () => {
  it('types a Redis cache and index the way the runtime takes them', () => {
    const options: WorkspaceOptions = {
      cache: { type: CacheType.REDIS, url: 'redis://localhost:6379/0', keyPrefix: 'c:' },
      index: { type: IndexType.REDIS, url: 'redis://localhost:6379/0', keyPrefix: 'i:' },
    }
    expect([options.cache, options.index]).toMatchObject([{ keyPrefix: 'c:' }, { keyPrefix: 'i:' }])
    const mount = new Mount(new RAMVFS(), {
      index: { type: IndexType.REDIS, url: 'redis://localhost:6379/0', keyPrefix: 'm:' },
    })
    expect(mount.options.index).toMatchObject({ keyPrefix: 'm:' })
    const added: Parameters<Workspace['addMount']>[5] = {
      type: IndexType.REDIS,
      url: 'redis://localhost:6379/0',
      keyPrefix: 'a:',
    }
    expect(added).toMatchObject({ keyPrefix: 'a:' })
  })

  it('takes the cache as config, the way index already does', () => {
    const ws = new Workspace({}, { cache: { type: CacheType.RAM, limit: 4096 } })
    expect(ws.cache).toBeInstanceOf(RAMFileCacheStore)
    expect(ws.cache.cacheLimit).toBe(4096)
  })

  it('closes the store it built', async () => {
    // A `cache: {type: redis}` config leaves the workspace holding a
    // client that nothing else would close. Config is the only form the
    // option takes — as in Python — so every cache is workspace-built
    // and every cache is workspace-closed.
    const built = new RAMFileCacheStore({ limit: 4096 })
    let builtClosed = 0
    built.close = () => {
      builtClosed++
      return Promise.resolve()
    }
    registerFileCacheStore('probe-close' as CacheType, () => built)
    const ws = new Workspace({}, { cache: { type: 'probe-close' as CacheType } })
    await ws.close()
    expect(builtClosed).toBe(1)
  })

  it('takes max_drain_bytes as maxDrainBytes', () => {
    const ws = new Workspace({}, { cache: { limit: '1MB', max_drain_bytes: 7 } as CacheConfig })
    expect(ws.maxDrainBytes).toBe(7)
  })
})

describe('the workspace clock', () => {
  it('ages the file cache and every mount index on the one clock', async () => {
    const clock = new ManualClock(1000)
    const ws = new Workspace(
      { '/a': new RAMVFS() },
      { mode: MountMode.WRITE, index: { type: IndexType.RAM, ttl: 60 }, clock },
    )
    try {
      const late = ws.addMount('/b', new RAMVFS(), MountMode.WRITE)
      const stores = [ws.mount('/a').indexStore, late.indexStore]
      await ws.cache.set('/a/f.txt', new TextEncoder().encode('x'), { ttl: 60 })
      for (const store of stores) await store.setDir('/d', [])
      clock.advance(59)
      expect(await ws.cache.exists('/a/f.txt')).toBe(true)
      for (const store of stores) expect((await store.listDir('/d')).status).toBeUndefined()
      clock.advance(1)
      expect(await ws.cache.exists('/a/f.txt')).toBe(false)
      for (const store of stores)
        expect((await store.listDir('/d')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      await ws.close()
    }
  })

  it('reaches every mount and CLI install token manager', async () => {
    const clock = new ManualClock(1000)
    const config = { clientId: 'c', refreshToken: 'r' }
    const ws = new Workspace({ '/a': new GoogleDriveVFS(config) }, { mode: MountMode.WRITE, clock })
    try {
      const late = ws.addMount('/b', new GoogleDriveVFS(config), MountMode.WRITE)
      const install = ws.registerCli('gws', GWS, { client_id: 'c', refresh_token: 'r' })
      const managers = [
        (ws.mount('/a').vfs as GoogleDriveVFS).accessor.tokenManager,
        (late.vfs as GoogleDriveVFS).accessor.tokenManager,
        (install.accessor as GoogleApiAccessor).tokenManager,
      ]
      expect(managers.map((m) => m.clock)).toEqual([clock, clock, clock])
    } finally {
      await ws.close()
    }
  })

  it('refuses a VFS another workspace holds on another clock', async () => {
    const vfs = drive()
    const first = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() })
    try {
      expect(
        () => new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() }),
      ).toThrow(/another clock/)
      expect(() => new Workspace({ '/g': vfs }, { mode: MountMode.WRITE })).toThrow(/another clock/)
    } finally {
      await first.close()
    }
  })

  it('lets two workspaces share a VFS on one clock', async () => {
    const vfs = drive()
    const clock = new ManualClock()
    const first = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock })
    const second = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock })
    try {
      expect(vfs.accessor.tokenManager.clock).toBe(clock)
    } finally {
      await second.close()
      await first.close()
    }
  })

  it('lets go of the clock when the workspace closes', async () => {
    const vfs = drive()
    const ws = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() })
    await ws.close()
    const later = new ManualClock()
    vfs.accessor.bindClock(later, 'later')
    expect(vfs.accessor.tokenManager.clock).toBe(later)
  })

  it('lets go of the clock on unmount', async () => {
    const vfs = drive()
    const ws = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() })
    try {
      await ws.unmount('/g')
      const later = new ManualClock()
      vfs.accessor.bindClock(later, 'later')
      expect(vfs.accessor.tokenManager.clock).toBe(later)
    } finally {
      await ws.close()
    }
  })

  it('a refused workspace lets go of what it placed', async () => {
    const free = drive()
    const held = drive()
    const holder = new Workspace(
      { '/h': held },
      { mode: MountMode.WRITE, clock: new ManualClock() },
    )
    try {
      expect(
        () =>
          new Workspace(
            { '/a': free, '/b': held },
            { mode: MountMode.WRITE, clock: new ManualClock() },
          ),
      ).toThrow(/another clock/)
      const later = new ManualClock()
      free.accessor.bindClock(later, 'later')
      expect(free.accessor.tokenManager.clock).toBe(later)
    } finally {
      await holder.close()
    }
  })

  it('a workspace failing after its mounts holds no clock', () => {
    const vfs = drive()
    expect(
      () =>
        new Workspace(
          { '/g': vfs },
          {
            mode: MountMode.WRITE,
            clock: new ManualClock(),
            clis: { x: ['no-such-cli', null] },
          },
        ),
    ).toThrow()
    const later = new ManualClock()
    vfs.accessor.bindClock(later, 'later')
    expect(vfs.accessor.tokenManager.clock).toBe(later)
  })

  it("closing one workspace keeps another's hold", async () => {
    const vfs = drive()
    const clock = new ManualClock()
    const first = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock })
    const second = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock })
    try {
      await first.close()
      expect(() => {
        vfs.accessor.bindClock(new ManualClock(), 'later')
      }).toThrow(/another clock/)
    } finally {
      await second.close()
    }
  })

  it('unmounting one of two mounts of a VFS keeps the clock', async () => {
    const vfs = drive()
    const ws = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() })
    try {
      ws.addMount('/h', vfs, MountMode.WRITE)
      await ws.unmount('/h')
      expect(() => {
        vfs.accessor.bindClock(new ManualClock(), 'later')
      }).toThrow(/another clock/)
    } finally {
      await ws.close()
    }
  })

  it('a mount added later takes the workspace clock', async () => {
    const clock = new ManualClock()
    const vfs = drive()
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, clock })
    try {
      ws.addMount('/g', vfs, MountMode.WRITE)
      expect(vfs.accessor.tokenManager.clock).toBe(clock)
    } finally {
      await ws.close()
    }
  })

  it('adding a VFS held on another clock holds nothing', async () => {
    const vfs = drive()
    const holder = new Workspace({ '/g': vfs }, { mode: MountMode.WRITE, clock: new ManualClock() })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, clock: new ManualClock() },
    )
    try {
      expect(() => ws.addMount('/g', vfs, MountMode.WRITE)).toThrow(/another clock/)
      await holder.close()
      const later = new ManualClock()
      vfs.accessor.bindClock(later, 'later')
      expect(vfs.accessor.tokenManager.clock).toBe(later)
    } finally {
      await ws.close()
    }
  })
})

function drive(): GoogleDriveVFS {
  return new GoogleDriveVFS({ clientId: 'c', refreshToken: 'r' })
}
