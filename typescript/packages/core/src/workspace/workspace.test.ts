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

import { describe, expect, it, vi } from 'vitest'
import type { CacheConfig } from '../cache/file/config.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import {
  IndexEntry,
  IndexType,
  LookupStatus,
  type IndexConfig,
  type RedisIndexConfig,
} from '../cache/index/config.ts'
import { RedisIndexCacheStore } from '../cache/index/redis.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { globNameMatches, globPattern } from '../utils/glob_walk.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { op, OpsRegistry } from '../ops/registry.ts'
import { FileType, MountMode, ResourceName, PathSpec } from '../types.ts'
import { BaseResource, type Resource } from '../resource/base.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import type { MountResolver } from '../runtime/resolver.ts'
import type { BridgeDispatchFn, RunArgs, RunResult } from '../runtime/types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'
import { expandOperands } from './executor/builtins/shared.ts'

class MockResource extends BaseResource implements Resource {
  readonly kind = 'mock'
  opens = 0
  closes = 0
  open(): Promise<void> {
    this.opens++
    return Promise.resolve()
  }
  override close(): Promise<void> {
    this.closes++
    return Promise.resolve()
  }
}

describe('Workspace lifecycle', () => {
  it.each(['glob', 'midpath', 'provision', 'metadata', 'touch', 'chmod', 'chown', 'chgrp'])(
    'prepares the first %s access to a dynamic mount',
    async (action) => {
      class IndexedRAM extends RAMResource {
        constructor(index: IndexCacheStore) {
          super()
          this._index = index
        }
        override async glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
          const parent = paths[0]?.directory.replace(/\/$/, '') ?? ''
          const directory = parent === '' ? '/' : parent
          const listing = await this.index.listDir(directory)
          if (listing.entries != null)
            return listing.entries
              .filter((key) =>
                globNameMatches(key.split('/').at(-1) ?? '', globPattern(paths[0]?.pattern ?? '*')),
              )
              .map((key) => PathSpec.fromStrPath(key, mountKey(key, prefix)))
          return super.glob(paths, prefix)
        }
      }
      const ancestor = new RAMResource()
      const ws = new Workspace({ '/': ancestor }, { shellParser: await getTestParser() })
      const replacement = new IndexedRAM(ancestor.index)
      const bytes = new TextEncoder()
      replacement.loadState({
        type: 'ram',
        dirs: ['/', '/dir'],
        files: {
          '/fresh.txt': bytes.encode('new'),
          '/dir/fresh.txt': bytes.encode('new'),
          '/file': bytes.encode('new'),
        },
      })
      const directory = action === 'midpath' ? '/data/dir' : '/data'
      await ancestor.index.setDir(directory, [
        ['stale.txt', new IndexEntry({ id: 'old', name: 'stale.txt', resourceType: 'file' })],
      ])
      await ws.cache.set('/data/file', bytes.encode('old'))
      ws.addMount('/data', replacement, MountMode.WRITE)
      try {
        if (action === 'provision') {
          const result = await ws.provision('cat /data/file')
          expect(result.cacheHits).toBe(0)
          expect((await ws.execute('cat /data/file')).stdout).toEqual(bytes.encode('new'))
        } else if (action === 'metadata') {
          const expanded = await expandOperands(ws.namespace, [
            new PathSpec({
              virtual: '/data/*.txt',
              directory: '/data/',
              resourcePath: '*.txt',
              pattern: '*.txt',
              resolved: false,
            }),
          ])
          expect(expanded.map((p) => p.virtual)).toEqual(['/data/fresh.txt'])
        } else if (['touch', 'chmod', 'chown', 'chgrp'].includes(action)) {
          const command = {
            touch: 'touch',
            chmod: 'chmod 600',
            chown: 'chown 123',
            chgrp: 'chgrp 456',
          }[action as 'touch' | 'chmod' | 'chown' | 'chgrp']
          const result = await ws.execute(command + ' /data/*.txt')
          expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
          expect((await ws.execute('echo /data/*.txt')).stdout).toEqual(
            bytes.encode('/data/fresh.txt\n'),
          )
        } else {
          const pattern = action === 'midpath' ? '/data/*/*.txt' : '/data/*.txt'
          expect((await ws.execute('echo ' + pattern)).stdout).toEqual(
            bytes.encode(`${directory}/fresh.txt\n`),
          )
        }
      } finally {
        await ws.close()
      }
    },
  )

  it('waits for an inflight cache write before releasing a mount', async () => {
    class CachedRAM extends RAMResource {
      override readonly cachesReads = true
    }
    const old = new CachedRAM()
    old.loadState({ type: 'ram', files: { '/file': new TextEncoder().encode('old') } })
    const ws = new Workspace({ '/data': old }, { shellParser: await getTestParser() })
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const writeCache = ws.cache.set.bind(ws.cache)
    vi.spyOn(ws.cache, 'set').mockImplementationOnce(async (...args) => {
      enter()
      await release
      await writeCache(...args)
    })
    const reading = ws.execute('cat /data/file')
    let removing: Promise<void> | undefined
    try {
      await entered
      let removed = false
      removing = ws.unmount('/data').then(() => {
        removed = true
      })
      await Promise.resolve()
      expect(removed).toBe(false)
      expect(() => ws.addMount('/data', new CachedRAM())).toThrow('duplicate mount prefix')
      resume()
      await Promise.all([reading, removing])
      expect(await ws.cache.get('/data/file')).toBeNull()
      const replacement = new CachedRAM()
      replacement.loadState({ type: 'ram', files: { '/file': new TextEncoder().encode('new') } })
      ws.addMount('/data', replacement)
      expect(new TextDecoder().decode((await ws.execute('cat /data/file')).stdout)).toBe('new')
    } finally {
      resume()
      await Promise.allSettled([reading, removing])
      await ws.close()
    }
  })

  it('refuses resource reuse until asynchronous close finishes', async () => {
    const resource = new RAMResource()
    const ws = new Workspace({ '/data': resource })
    await ws.resolve('/data')
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const close = resource.close.bind(resource)
    vi.spyOn(resource, 'close').mockImplementationOnce(async () => {
      enter()
      await release
      await close()
    })
    const removing = ws.unmount('/data')
    try {
      await entered
      for (const prefix of ['/data', '/alias']) {
        expect(() => ws.addMount(prefix, resource)).toThrow('resource is being unmounted')
      }
      resume()
      await removing
      expect(() => ws.addMount('/data', resource)).toThrow('resource is closed')
      expect(() => new Workspace({ '/data': resource })).toThrow('resource is closed')
      ws.addMount('/data', new RAMResource())
    } finally {
      resume()
      await removing
      await ws.close()
    }
  })

  it.each(['replace', 'shadow', 'reveal'])(
    'does not cache a retired command result for a different owner (%s)',
    async (change) => {
      const shadow = change === 'shadow'
      class CachedRAM extends RAMResource {
        override readonly cachesReads = true
      }
      const old = new CachedRAM()
      old.loadState({
        type: 'ram',
        files: { [shadow ? '/data/file' : '/file']: new TextEncoder().encode('old') },
      })
      const replacement = new CachedRAM()
      replacement.loadState({
        type: 'ram',
        files: { [change === 'reveal' ? '/data/file' : '/file']: new TextEncoder().encode('new') },
      })
      let enter = (): void => undefined
      let resume = (): void => undefined
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const release = new Promise<void>((resolve) => {
        resume = resolve
      })
      const prefix = shadow ? '/' : '/data'
      const resources: Record<string, Resource> = { [prefix]: old }
      if (change === 'reveal') resources['/'] = replacement
      const ws = new Workspace(resources, { shellParser: await getTestParser() })
      ws.registerCli(
        'gate',
        new CLISpec({
          name: 'gate',
          fn: async () => {
            enter()
            await release
            return [null, new IOResult()]
          },
        }),
      )
      const retired = ws.mount(prefix).cacheManager
      const running = ws.execute('cat /data/file; gate')
      try {
        await entered
        if (!shadow) await ws.unmount('/data')
        if (change !== 'reveal') ws.addMount('/data', replacement)
        resume()
        expect(new TextDecoder().decode((await running).stdout)).toBe('old')
        expect(await ws.cache.get('/data/file')).toBeNull()
        expect(new TextDecoder().decode((await ws.execute('cat /data/file')).stdout)).toBe('new')
        expect(await ws.cache.get('/data/file')).toEqual(new TextEncoder().encode('new'))
        expect(retired).not.toBeNull()
        expect(
          await retired?.cachedBytes(
            new PathSpec({
              virtual: '/data/file',
              directory: '/data/',
              resourcePath: 'file',
            }),
          ),
        ).toBeNull()
      } finally {
        resume()
        await running
        await ws.close()
      }
    },
  )

  it('does not open resources at construction time', () => {
    const ram = new MockResource()
    new Workspace({ '/data': ram })
    expect(ram.opens).toBe(0)
  })

  it('opens a resource lazily on first resolve', async () => {
    const ram = new MockResource()
    const ws = new Workspace({ '/data': ram })
    expect(ram.opens).toBe(0)
    await ws.resolve('/data/x')
    expect(ram.opens).toBe(1)
    await ws.close()
  })

  it('opens each resource exactly once across multiple resolves', async () => {
    const ram = new MockResource()
    const ws = new Workspace({ '/data': ram })
    await ws.resolve('/data/a')
    await ws.resolve('/data/b')
    await ws.resolve('/data/c')
    expect(ram.opens).toBe(1)
    await ws.close()
  })

  it('close() calls close() on every opened resource', async () => {
    const a = new MockResource()
    const b = new MockResource()
    const ws = new Workspace({ '/a': a, '/b': b })
    await ws.resolve('/a/x')
    await ws.resolve('/b/y')
    await ws.close()
    expect(a.closes).toBe(1)
    expect(b.closes).toBe(1)
  })

  it('close() closes every mount resource, including those never resolved', async () => {
    const used = new MockResource()
    const unused = new MockResource()
    const ws = new Workspace({ '/used': used, '/unused': unused })
    await ws.resolve('/used/x')
    await ws.close()
    expect(used.closes).toBe(1)
    expect(unused.closes).toBe(1)
  })

  it('close() is idempotent', async () => {
    const ram = new MockResource()
    const ws = new Workspace({ '/data': ram })
    await ws.resolve('/data/x')
    await ws.close()
    await ws.close()
    expect(ram.closes).toBe(1)
  })

  it('resolve() after close() throws', async () => {
    const ws = new Workspace({ '/data': new MockResource() })
    await ws.close()
    await expect(ws.resolve('/data/x')).rejects.toThrow(/closed/)
  })
})

describe('Workspace dynamic mount index', () => {
  for (const type of [IndexType.RAM, IndexType.REDIS]) {
    for (const shadow of [false, true]) {
      it.skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined)(
        `invalidates the ${type} index before mount replacement (shadow=${String(shadow)})`,
        async () => {
          const url = process.env.REDIS_URL
          const config: IndexConfig | RedisIndexConfig =
            type === IndexType.REDIS
              ? {
                  type,
                  ...(url === undefined ? {} : { url }),
                  keyPrefix: `lifecycle:${crypto.randomUUID()}:`,
                }
              : { type }
          const resource = new RAMResource()
          const ws = new Workspace({ [shadow ? '/' : '/data']: resource }, { index: config })
          ws.addMount('/alias', resource)
          const index = resource.index
          const entry = new IndexEntry({ id: 'old', name: 'private.txt', resourceType: 'file' })
          try {
            await index.put('/data', entry)
            for (const path of ['/data', '/data/nested', '/database', '/alias']) {
              await index.setDir(path, [['private.txt', entry]])
            }
            if (!shadow) await ws.unmount('/data')
            const replacement = new RAMResource()
            ws.addMount('/data', replacement)
            if (shadow) expect(await ws.fs.readdir('/data')).toEqual([])
            for (const candidate of [index, replacement.index]) {
              for (const path of ['/data', '/data/private.txt', '/data/nested/private.txt']) {
                expect((await candidate.get(path)).status).toBe(LookupStatus.NOT_FOUND)
              }
              for (const path of ['/data', '/data/nested']) {
                expect((await candidate.listDir(path)).entries ?? []).toEqual([])
              }
            }
            for (const path of ['/database', '/alias']) {
              expect((await index.listDir(path)).entries).toEqual([`${path}/private.txt`])
            }
          } finally {
            await index.clear()
            await ws.close()
          }
        },
      )
    }
  }

  it('applies the workspace Redis index to added mounts', async () => {
    const ws = new Workspace({}, { index: { type: IndexType.REDIS } })
    const resource = new RAMResource()
    ws.addMount('/late', resource)
    try {
      expect(resource.index).toBeInstanceOf(RedisIndexCacheStore)
    } finally {
      await ws.close()
    }
  })

  it('applies the same index TTL to initial and added mounts', async () => {
    const initial = new RAMResource()
    const ws = new Workspace({ '/initial': initial }, { index: { ttl: -1 } })
    const added = new RAMResource()
    ws.addMount('/late', added)
    try {
      for (const resource of [initial, added]) {
        await resource.index.setDir('/listing', [])
        expect((await resource.index.listDir('/listing')).status).toBe(LookupStatus.EXPIRED)
      }
    } finally {
      await ws.close()
    }
  })

  it('keeps the index coherent across aliases and duplicate attempts', async () => {
    const ws = new Workspace({}, { index: { ttl: 3600 } })
    const resource = new RAMResource()
    ws.addMount('/late', resource, MountMode.WRITE)
    const index = resource.index
    const rejected = new RAMResource()
    const rejectedIndex = rejected.index
    try {
      await index.setDir('/late', [])
      ws.addMount('/alias', resource)
      expect(resource.index).toBe(index)
      expect((await index.listDir('/late')).entries).toEqual([])
      expect(() => ws.addMount('late/', rejected)).toThrow('duplicate mount prefix')
      expect(rejected.index).toBe(rejectedIndex)
      // Mutations must evict the configured store, including after aliasing.
      await ws.fs.writeFile('/late/new.txt', 'new')
      expect((await index.listDir('/late')).status).toBe(LookupStatus.NOT_FOUND)
    } finally {
      await ws.close()
      await rejected.close()
    }
  })
})

describe('Workspace custom cache option', () => {
  class StubCache extends BaseResource implements Resource, FileCache {
    readonly kind = ResourceName.RAM
    readonly store = new Map<string, Uint8Array>()
    getCalls = 0
    setCalls = 0
    maxDrainBytes: number | null = null
    open(): Promise<void> {
      return Promise.resolve()
    }
    override close(): Promise<void> {
      return Promise.resolve()
    }
    readonly cacheSize = 0
    readonly cacheLimit = 1 << 20
    get(key: string): Promise<Uint8Array | null> {
      this.getCalls++
      return Promise.resolve(this.store.get(key) ?? null)
    }
    set(key: string, data: Uint8Array): Promise<void> {
      this.setCalls++
      this.store.set(key, data)
      return Promise.resolve()
    }
    add(key: string, data: Uint8Array): Promise<boolean> {
      if (this.store.has(key)) return Promise.resolve(false)
      return this.set(key, data).then(() => true)
    }
    remove(key: string): Promise<void> {
      this.store.delete(key)
      return Promise.resolve()
    }
    evictPrefix(prefix: string): Promise<void> {
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(prefix)) this.store.delete(key)
      }
      return Promise.resolve()
    }
    evictPaths(paths: Iterable<string>): void {
      for (const key of paths) this.store.delete(key)
    }
    exists(key: string | PathSpec): Promise<boolean> {
      const k = typeof key === 'string' ? key : key.mountPath
      return Promise.resolve(this.store.has(k))
    }
    isFresh(): Promise<boolean> {
      return Promise.resolve(false)
    }
    clear(): Promise<void> {
      this.store.clear()
      return Promise.resolve()
    }
    multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]> {
      return Promise.resolve(keys.map((k) => this.store.get(k) ?? null))
    }
  }

  it('refuses a built store where the cache config goes', () => {
    // Every CacheConfig field is optional, so this typechecks; before
    // the guard it built a RAM cache instead and the supplied store
    // never saw a read, a write, or a close.
    const cache = new StubCache()
    expect(() => new Workspace({}, { cache: cache as unknown as CacheConfig })).toThrow(
      /not a built store/,
    )
  })
})

describe('Workspace.execute AbortSignal', () => {
  it('execute with pre-aborted signal throws AbortError', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const controller = new AbortController()
    controller.abort()
    await expect(ws.execute('echo hi', { signal: controller.signal })).rejects.toThrow(/abort/i)
  })
})

describe('Workspace.unmount', () => {
  it('keeps decorated operations bound to each surviving resource', async () => {
    class LabeledRAM extends RAMResource {
      closes = 0
      override async close(): Promise<void> {
        this.closes++
        await super.close()
      }
      constructor(readonly label: string) {
        super()
      }
      @op('identity', { resource: 'ram' })
      identity(): Uint8Array {
        if (this.closes > 0) throw new Error('resource closed')
        return new TextEncoder().encode(this.label)
      }
    }
    class SpecializedRAM extends LabeledRAM {
      @op('unique', { resource: 'ram' })
      unique(): Uint8Array {
        return this.identity()
      }
    }
    const ws = new Workspace({})
    const first = new LabeledRAM('first')
    const second = new SpecializedRAM('second')
    const third = new LabeledRAM('third')
    const identity = async (path: string, name = 'identity'): Promise<string> => {
      const result = await ws.dispatch(name, path)
      return new TextDecoder().decode(result as Uint8Array)
    }
    try {
      ws.addMount('/first', first)
      ws.addMount('/second', second)
      ws.addMount('/third', third)
      expect(await identity('/first/file')).toBe('first')
      expect(await identity('/second/file')).toBe('second')
      expect(await identity('/third/file')).toBe('third')
      await ws.unmount('/second')
      expect(second.closes).toBe(1)
      expect(await identity('/first/file')).toBe('first')
      expect(await identity('/third/file')).toBe('third')
      await expect(identity('/first/file', 'unique')).rejects.toMatchObject({ code: 'ENOTSUP' })
      await ws.unmount('/third')
      expect(await identity('/first/file')).toBe('first')
      expect((await ws.fs.readdir('/')).length).toBeGreaterThan(0)
    } finally {
      await ws.close()
    }
  })

  it.each([
    [false, 'file'],
    [true, 'file'],
    [false, 'index'],
    [true, 'index'],
  ] as const)(
    'retains a prefix until cache cleanup succeeds (failure=%s, store=%s)',
    async (fails, store) => {
      const resource = new RAMResource()
      resource.loadState({ type: 'ram', files: { '/file': new TextEncoder().encode('old') } })
      const ws = new Workspace(
        { '/data': resource },
        { mode: MountMode.WRITE, shellParser: await getTestParser() },
      )
      const cache = ws.cache
      ws.addMount('/alias', resource)
      const aliasEntries = await ws.fs.readdir('/alias')
      let enter = (): void => undefined
      let resume = (): void => undefined
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const release = new Promise<void>((resolve) => {
        resume = resolve
      })
      const evict =
        store === 'file'
          ? cache.evictPrefix.bind(cache)
          : resource.index.invalidatePrefix.bind(resource.index)
      const spy =
        store === 'file'
          ? vi.spyOn(cache, 'evictPrefix')
          : vi.spyOn(resource.index, 'invalidatePrefix')
      spy.mockImplementationOnce(async (prefix) => {
        enter()
        await release
        if (fails) throw new Error('cache unavailable')
        await evict(prefix)
      })
      const bytes = new TextEncoder()
      await cache.set('/data', bytes.encode('root'))
      await cache.set('/data/file', bytes.encode('old'))
      await cache.set('/database/file', bytes.encode('peer'))
      const removing = ws.unmount('data/').then(
        () => null,
        (error: unknown) => error,
      )
      try {
        await entered
        expect((await ws.resolve('/alias'))[0]).toBe(resource)
        expect(() => ws.addMount('/data', new RAMResource())).toThrow('duplicate mount prefix')
        await expect(ws.fs.readdir('/data')).rejects.toMatchObject({ code: 'EBUSY' })
        await expect(ws.fs.writeFile('/data/file', bytes.encode('changed'))).rejects.toMatchObject({
          code: 'EBUSY',
        })
        for (const line of ['cat /data/file', 'echo changed > /data/file']) {
          expect((await ws.execute(line)).exitCode).not.toBe(0)
        }
        expect(resource.getState().files?.['/file']).toEqual(bytes.encode('old'))
        resume()
        const result = await removing
        if (fails) {
          expect(result).toEqual(new Error('cache unavailable'))
          expect(ws.mount('/data').resource).toBe(resource)
          await ws.unmount('/data')
        } else {
          expect(result).toBeNull()
        }
        expect(await cache.get('/data')).toBeNull()
        expect(await cache.get('/data/file')).toBeNull()
        expect(await cache.get('/database/file')).toEqual(bytes.encode('peer'))
        expect(await ws.fs.readdir('/alias')).toEqual(aliasEntries)
        ws.addMount('/data', new RAMResource())
      } finally {
        resume()
        await removing
        await ws.close()
      }
    },
  )

  it.each([false, true])(
    'preserves root operations after removing every user RAM mount (explicit root: %s)',
    async (explicitRoot) => {
      const resources: Record<string, RAMResource> = { '/data': new RAMResource() }
      if (explicitRoot) resources['/'] = new RAMResource()
      const ws = new Workspace(resources, { shellParser: await getTestParser() })
      try {
        await ws.unmount('/data')
        await expect(ws.fs.readdir('/')).resolves.toContain('/dev')
        await expect(ws.fs.stat('/')).resolves.toMatchObject({ type: FileType.DIRECTORY })
        const result = await ws.execute('ls /')
        expect(result.exitCode).toBe(0)
        expect(result.stdoutText).toBe('dev\n')
        expect(result.stderrText).toBe('')
      } finally {
        await ws.close()
      }
    },
  )

  it('keeps a different RAM instance readable after unmounting its peer', async () => {
    const a = new RAMResource()
    const b = new RAMResource()
    const content = new TextEncoder().encode('surviving mount\n')
    b.store.files.set('/file.txt', content)
    const ws = new Workspace({ '/a': a, '/b': b })
    try {
      await ws.unmount('/a')
      await expect(ws.fs.readFile('/b/file.txt')).resolves.toEqual(content)
      await ws.unmount('/b')
      await expect(ws.fs.readdir('/')).resolves.toContain('/dev')
    } finally {
      await ws.close()
    }
  })

  it('closes each resource separately and unregisters operations after the last of its kind', async () => {
    const a = new MockResource()
    const b = new MockResource()
    const content = new TextEncoder().encode('mock data\n')
    const ops = new OpsRegistry()
    ops.register({
      name: 'read',
      resource: 'mock',
      filetype: null,
      write: false,
      fn: () => content,
    })
    const ws = new Workspace({ '/a': a, '/b': b }, { ops })
    try {
      await ws.fs.readFile('/a/file.txt')
      await ws.fs.readFile('/b/file.txt')
      await ws.unmount('/a')
      expect(a.closes).toBe(1)
      expect(b.closes).toBe(0)
      await expect(ws.fs.readFile('/b/file.txt')).resolves.toEqual(content)
      await ws.unmount('/b')
      expect(b.closes).toBe(1)
      expect(ops.find('read', 'mock')).toBeNull()
    } finally {
      await ws.close()
    }
    expect(a.closes).toBe(1)
    expect(b.closes).toBe(1)
  })

  it('removes a mount from mounts(); the path falls through to the root anchor', async () => {
    const a = new RAMResource()
    const b = new RAMResource()
    const ws = new Workspace({ '/a': a, '/b': b }, { mode: MountMode.WRITE })
    expect(ws.mounts().some((m) => m.prefix === '/a/')).toBe(true)
    await ws.unmount('/a')
    expect(ws.mounts().some((m) => m.prefix === '/a/')).toBe(false)
    // With /a gone the path no longer routes to a's resource; it falls through
    // to the empty root anchor (prefix '/'), not back to /a.
    expect(ws.registry.mountFor('/a/x').prefix).toBe('/')
    await ws.close()
  })

  it('closes the resource exactly once when it was opened by the workspace', async () => {
    const r = new MockResource()
    const ws = new Workspace({ '/x': r })
    await ws.resolve('/x/y')
    expect(r.opens).toBe(1)
    await ws.unmount('/x')
    expect(r.closes).toBe(1)
    await ws.close()
    expect(r.closes).toBe(1)
  })

  it('closes an owned resource even when it was never explicitly opened', async () => {
    const r = new MockResource()
    const ws = new Workspace({ '/x': r })
    await ws.unmount('/x')
    expect(r.closes).toBe(1)
    await ws.close()
    expect(r.closes).toBe(1)
  })

  it('throws on root, history view, /dev/, and unknown prefix', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    await expect(ws.unmount('/')).rejects.toThrow(/root/i)
    await expect(ws.unmount('/.bash_history')).rejects.toThrow(/history view/i)
    await expect(ws.unmount('/dev')).rejects.toThrow(/reserved/i)
    await expect(ws.unmount('/missing')).rejects.toThrow(/no mount/i)
    await ws.close()
  })

  it('addMount + unmount round-trip preserves other mounts', async () => {
    const ws = new Workspace({ '/a': new RAMResource() }, { mode: MountMode.WRITE })
    ws.addMount('/scratch', new RAMResource(), MountMode.WRITE)
    expect(ws.mounts().some((m) => m.prefix === '/scratch/')).toBe(true)
    await ws.unmount('/scratch')
    expect(ws.mounts().some((m) => m.prefix === '/scratch/')).toBe(false)
    expect(ws.mounts().some((m) => m.prefix === '/a/')).toBe(true)
    await ws.close()
  })
})

describe('Workspace mount fallback', () => {
  it('falls back to the root mount, not the observer', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const m = ws.registry.mountForCommand('mkdir')
    expect(m).not.toBeNull()
    expect(m?.prefix).toBe('/')
    await ws.close()
  })

  it('skips the history view mount even when no user root provides the command', async () => {
    const ws = new Workspace({ '/r': new RAMResource() }, { mode: MountMode.READ })
    // No `/` was mounted, so the workspace adds a plain empty RAM root anchor
    // at `/`, which satisfies `mkdir`. The point: even with the read-only
    // history view in the registry, fallback is the root, never /.bash_history/.
    const m = ws.registry.mountForCommand('mkdir')
    expect(m?.prefix).toBe('/')
    expect(m?.prefix).not.toBe('/.bash_history/')
    await ws.close()
  })
})

describe('cd does not change cwd for nonexistent paths', () => {
  async function makeWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ops = new OpsRegistry()
    const root = new RAMResource()
    ops.registerResource(root)
    return new Workspace({ '/': root }, { mode: MountMode.WRITE, ops, shellParser: parser })
  }

  it('cd to nonexistent dir under a mount errors and keeps cwd', async () => {
    const ws = await makeWs()
    const before = ws.getSession(ws.sessionManager.defaultId).cwd
    const result = await ws.execute('cd /missing')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderrText).toMatch(/No such file or directory/)
    expect(ws.getSession(ws.sessionManager.defaultId).cwd).toBe(before)
  })

  it('cd into a mount root succeeds', async () => {
    const parser = await getTestParser()
    const ops = new OpsRegistry()
    const root = new RAMResource()
    const data = new RAMResource()
    ops.registerResource(root)
    ops.registerResource(data)
    const ws = new Workspace(
      { '/': root, '/data': data },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )
    const result = await ws.execute('cd /data')
    expect(result.exitCode).toBe(0)
    expect(ws.getSession(ws.sessionManager.defaultId).cwd).toBe('/data')
    await ws.close()
  })
})

describe('ls injects child mounts as virtual subdirectories', () => {
  async function makeWs(mounts: Record<string, RAMResource>): Promise<Workspace> {
    const parser = await getTestParser()
    const ops = new OpsRegistry()
    for (const r of Object.values(mounts)) ops.registerResource(r)
    return new Workspace(mounts, { mode: MountMode.WRITE, ops, shellParser: parser })
  }

  it('ls / shows child mount /data as a subfolder', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/data': new RAMResource() })
    const result = await ws.execute('ls /')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutText.split('\n')).toContain('data')
    await ws.close()
  })

  it('ls / classifies child mount with trailing slash under -F', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/data': new RAMResource() })
    const result = await ws.execute('ls -F /')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutText.split('\n')).toContain('data/')
    await ws.close()
  })

  it('ls / hides .bash_history by default and shows it under -a', async () => {
    const ws = await makeWs({ '/': new RAMResource() })
    const plain = await ws.execute('ls /')
    expect(plain.stdoutText.split('\n')).not.toContain('.bash_history')
    const all = await ws.execute('ls -a /')
    expect(all.stdoutText.split('\n')).toContain('.bash_history')
    await ws.close()
  })

  it('ls /data does not duplicate when no child mounts exist below', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/data': new RAMResource() })
    await ws.execute('mkdir -p /data/sub')
    const result = await ws.execute('ls /data')
    const lines = result.stdoutText.split('\n').filter((l) => l !== '')
    expect(lines.filter((l) => l === 'sub' || l === 'sub/').length).toBe(1)
    await ws.close()
  })

  it('ls /data shows nested mount /data/inner', async () => {
    const ws = await makeWs({
      '/': new RAMResource(),
      '/data': new RAMResource(),
      '/data/inner': new RAMResource(),
    })
    const result = await ws.execute('ls /data')
    expect(result.stdoutText.split('\n')).toContain('inner')
    await ws.close()
  })

  it('ls -d does not inject child mounts', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/data': new RAMResource() })
    const result = await ws.execute('ls -d /')
    expect(result.stdoutText.split('\n')).not.toContain('data')
    await ws.close()
  })

  // GNU coreutils 9.7 on debian:stable-slim, tmpfs mounted at /empty/hole:
  // `du --apparent-size -B1 /empty` prints both rows and exits 0. The absence
  // line is reserved for a path that is really not there. No backend holds an
  // entry for /empty, so only the dispatcher-backed probe knows it is there.
  it('du on the implied parent of a nested mount does not report absence', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/empty/hole': new RAMResource() })
    const result = await ws.execute('du /empty')
    expect(result.stdoutText).toBe('0\t/empty/hole\n0\t/empty\n')
    expect(result.stderrText).toBe('')
    expect(result.exitCode).toBe(0)
    await ws.close()
  })

  it('du -s on the implied parent of a nested mount does not report absence', async () => {
    const ws = await makeWs({ '/': new RAMResource(), '/empty/hole': new RAMResource() })
    const result = await ws.execute('du -s /empty')
    expect(result.stdoutText).toBe('0\t/empty\n')
    expect(result.stderrText).toBe('')
    expect(result.exitCode).toBe(0)
    await ws.close()
  })

  // The mount table alone is not enough evidence: namespaceNames synthesizes a
  // directory for a link's ancestors too, and there is no descendant mount
  // here at all.
  it('du on a directory implied only by a link below it does not report absence', async () => {
    const ws = await makeWs({ '/': new RAMResource() })
    await ws.execute('mkdir -p /real')
    await ws.execute('echo hi > /real/f.txt')
    await ws.execute('ln -s /real/f.txt /ghost/deep/lnk')
    const result = await ws.execute('du /ghost')
    expect(result.stderrText).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutText).toContain('/ghost')
    await ws.close()
  })

  // registry.descendantMounts is not session-filtered, so proving presence
  // from the mount table alone would answer `0 /empty` here and confirm a
  // walled-off mount's parent. The dispatcher-backed probe is filtered.
  it('du still reports absence when the descendant mount is hidden', async () => {
    // `registry.descendantMounts` is not session-filtered, so proving
    // presence from the mount table alone would answer `0 /empty` here
    // and confirm a walled-off mount's parent. The dispatcher-backed
    // probe is filtered, so absence stays the answer.
    const ws = await makeWs({ '/': new RAMResource(), '/empty/hole': new RAMResource() })
    ws.createSession('scoped', { profile: { paths: { hide: ['/empty/hole'] } } })
    const result = await ws.execute('du /empty', { sessionId: 'scoped' })
    expect(result.stdoutText).toBe('')
    expect(result.stderrText).toBe("du: cannot access '/empty': No such file or directory\n")
    expect(result.exitCode).toBe(1)
    await ws.close()
  })
})

describe('rm/rmdir on a mount prefix is refused (Unix-like)', () => {
  // Previously `rm -r /mount` and `rmdir /mount` silently unmounted the
  // mount via tryUnmountIntercept. That made it dangerously easy to drop
  // a real S3/R2 bucket from the shell. The mount-root guard now refuses
  // these commands with EBUSY, matching Linux's behavior on mount points.
  // Use the Workspace.unmount() API explicitly to remove a mount.
  async function makeWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ops = new OpsRegistry()
    const root = new RAMResource()
    const data = new RAMResource()
    ops.registerResource(root)
    ops.registerResource(data)
    return new Workspace(
      { '/': root, '/data': data },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )
  }

  it('rm -r /data refuses with Device or resource busy and keeps the mount', async () => {
    const ws = await makeWs()
    const result = await ws.execute('rm -r /data')
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toMatch(/Device or resource busy/)
    expect(ws.mounts().some((m) => m.prefix === '/data/')).toBe(true)
    await ws.close()
  })

  it('rmdir /data refuses with Device or resource busy and keeps the mount', async () => {
    const ws = await makeWs()
    const result = await ws.execute('rmdir /data')
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toMatch(/Device or resource busy/)
    expect(ws.mounts().some((m) => m.prefix === '/data/')).toBe(true)
    await ws.close()
  })

  it('rm -r without a mount-prefix path falls through to normal rm', async () => {
    const ws = await makeWs()
    await ws.execute('mkdir -p /data/sub')
    const result = await ws.execute('rm -r /data/sub')
    expect(result.exitCode).toBe(0)
    expect(ws.mounts().some((m) => m.prefix === '/data/')).toBe(true)
    await ws.close()
  })

  it('rm -r / refuses (cache root is a mount)', async () => {
    const ws = await makeWs()
    const result = await ws.execute('rm -r /')
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toMatch(/Device or resource busy/)
    await ws.close()
  })

  it('rm -r /dev refuses and keeps /dev mounted', async () => {
    const ws = await makeWs()
    expect(ws.mounts().some((m) => m.prefix === '/dev/')).toBe(true)
    const result = await ws.execute('rm -r /dev')
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toMatch(/Device or resource busy/)
    expect(ws.mounts().some((m) => m.prefix === '/dev/')).toBe(true)
    await ws.close()
  })

  it('rmdir /dev refuses and keeps /dev mounted', async () => {
    const ws = await makeWs()
    const result = await ws.execute('rmdir /dev')
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toMatch(/Device or resource busy/)
    expect(ws.mounts().some((m) => m.prefix === '/dev/')).toBe(true)
    await ws.close()
  })

  it('rm without -r on a mount prefix does NOT unmount', async () => {
    const ws = await makeWs()
    await ws.execute('rm /data')
    // The intercept only triggers for recursive forms; mount stays either way
    expect(ws.mounts().some((m) => m.prefix === '/data/')).toBe(true)
    await ws.close()
  })
})

class ResolverProbe extends LanguageRuntime {
  readonly language = 'python'
  readonly name = 'resolver-probe'
  resolver: MountResolver | null = null
  constructor() {
    super({ captures: ['probe-run'] })
  }
  override attach(_dispatch: BridgeDispatchFn, resolver: MountResolver): void {
    this.resolver = resolver
  }
  run(_args: RunArgs): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })
  }
}

describe('runtime-visible mounts', () => {
  it('attach withholds the history view from runtimes', async () => {
    // The history view is a shell surface, not a place to put files;
    // announcing it would make a WASI guest preopen /.bash_history.
    const probe = new ResolverProbe()
    const ws = new Workspace({ '/data': new RAMResource() }, { runtimes: [probe] })
    expect(probe.resolver).not.toBeNull()
    const prefixes = probe.resolver?.prefixes() ?? []
    expect(prefixes).toContain('/data/')
    expect(prefixes.some((p) => p.includes('bash_history'))).toBe(false)
    await ws.close()
  })

  it('attach withholds the synthetic root anchor', async () => {
    // Nobody mounted the anchor; forwarding it would make every
    // runtime claim a resource the embedder never asked for.
    const probe = new ResolverProbe()
    const ws = new Workspace({ '/data': new RAMResource() }, { runtimes: [probe] })
    expect(probe.resolver?.prefixes() ?? []).not.toContain('/')
    await ws.close()
  })

  it('attach forwards an explicit root mount', async () => {
    // Withheld for being synthetic, never for being `/`: a runtime
    // that cannot serve the root refuses on its own (pyodide does).
    const probe = new ResolverProbe()
    const ws = new Workspace({ '/': new RAMResource() }, { runtimes: [probe] })
    expect(probe.resolver?.prefixes() ?? []).toContain('/')
    await ws.close()
  })
})

it('changes mount modes without remounting and refuses invalid modes atomically', async () => {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
  try {
    const fs = ws.fs
    const mount = ws.mount('/data')
    await fs.writeFile('/data/file', new TextEncoder().encode('kept'))
    for (const mode of [MountMode.READ, MountMode.EXEC, MountMode.WRITE]) {
      ws.setMountMode('data/', mode)
      expect(ws.fs).toBe(fs)
      expect(ws.mount('/data')).toBe(mount)
      expect(mount.mode).toBe(mode)
      expect(new TextDecoder().decode(await fs.readFile('/data/file'))).toBe('kept')
    }
    expect(() => {
      ws.setMountMode('/data', 'invalid' as MountMode)
    }).toThrow()
    expect(mount.mode).toBe(MountMode.WRITE)
  } finally {
    await ws.close()
  }
})

it('updates default-profile policy for unbound ops without replacing the session', async () => {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
  try {
    const session = ws.getSession(ws.defaultSessionId)
    await ws.fs.writeFile('/data/file', new TextEncoder().encode('kept'))
    const profile = { commands: { deny: [{ paths: ['/data/file'], reason: 'sealed' }] } }
    expect(await ws.setSessionProfile(ws.defaultSessionId, profile)).toBe(session)
    await expect(ws.fs.readFile('/data/file')).rejects.toThrow()
    await ws.setSessionProfile(ws.defaultSessionId, {})
    expect(ws.getSession(ws.defaultSessionId)).toBe(session)
    expect(new TextDecoder().decode(await ws.fs.readFile('/data/file'))).toBe('kept')
  } finally {
    await ws.close()
  }
})

it('unmount drains metadata globs and their index writes', async () => {
  const resource = new RAMResource()
  const ws = new Workspace({ '/data': resource })
  await ws.resolve('/data')
  let enter = (): void => undefined
  let resume = (): void => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  let closed = false
  const index = resource.index
  const closeResource = resource.close.bind(resource)
  vi.spyOn(resource, 'close').mockImplementation(async () => {
    closed = true
    await closeResource()
  })
  vi.spyOn(resource, 'glob').mockImplementation(async () => {
    enter()
    await release
    expect(closed).toBe(false)
    await index.setDir('/data', [
      ['late', new IndexEntry({ id: 'late', name: 'late', resourceType: 'file' })],
    ])
    return []
  })
  const expanding = expandOperands(ws.namespace, [
    new PathSpec({
      virtual: '/data/*',
      directory: '/data/',
      resourcePath: '*',
      pattern: '*',
      resolved: false,
    }),
  ])
  let removing: Promise<void> | undefined
  try {
    await entered
    let removed = false
    removing = ws.unmount('/data').then(() => {
      removed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(removed).toBe(false)
    expect(closed).toBe(false)
    resume()
    await expanding
    await removing
    expect(closed).toBe(true)
    expect((await index.listDir('/data')).entries).toBeUndefined()
  } finally {
    resume()
    await Promise.allSettled([expanding, ...(removing === undefined ? [] : [removing])])
    await ws.close()
  }
})
