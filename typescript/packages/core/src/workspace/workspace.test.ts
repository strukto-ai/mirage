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
import type { CacheConfig } from '../cache/file/config.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { MountMode, ResourceName, type PathSpec } from '../types.ts'
import { BaseResource, type Resource } from '../resource/base.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import type { MountResolver } from '../runtime/resolver.ts'
import type { BridgeDispatchFn, RunArgs, RunResult } from '../runtime/types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

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

class CachingRAMResource extends RAMResource {
  override readonly cachesReads = true
}

describe('Workspace lifecycle', () => {
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

  it('does not close a resource that was never opened', async () => {
    const r = new MockResource()
    const ws = new Workspace({ '/x': r })
    await ws.unmount('/x')
    expect(r.closes).toBe(0)
    await ws.close()
  })

  it('evicts the removed cache scope without touching a slash-adjacent sibling', async () => {
    const enc = new TextEncoder()
    const parser = await getTestParser()
    const ops = new OpsRegistry()
    const root = new CachingRAMResource()
    const removed = new CachingRAMResource()
    const nested = new CachingRAMResource()
    for (const resource of [root, removed, nested]) ops.registerResource(resource)
    root.store.files.set('/m/x', enc.encode('root\n'))
    root.store.files.set('/more/x', enc.encode('sibling\n'))
    removed.store.files.set('/x', enc.encode('child-secret\n'))
    nested.store.files.set('/y', enc.encode('nested\n'))
    const ws = new Workspace(
      { '/': root, '/m': removed, '/m/n': nested },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )

    expect((await ws.execute('cat /m/x')).stdoutText).toBe('child-secret\n')
    expect((await ws.execute('cat /more/x')).stdoutText).toBe('sibling\n')
    expect((await ws.execute('cat /m/n/y')).stdoutText).toBe('nested\n')
    await ws.cache.set('/m', enc.encode('exact-stale'))

    await ws.unmount('/m')

    expect(await ws.cache.get('/m')).toBeNull()
    expect(await ws.cache.get('/m/x')).toBeNull()
    expect(await ws.cache.get('/m/n/y')).toBeNull()
    expect(await ws.cache.get('/more/x')).toEqual(enc.encode('sibling\n'))
    expect((await ws.execute('cat /m/x')).stdoutText).toBe('root\n')
    expect((await ws.execute('cat /m/n/y')).stdoutText).toBe('nested\n')
    await ws.close()
  })

  it('keeps a shared resource open while another mount owns it', async () => {
    class SharedRAM extends CachingRAMResource {
      closes = 0
      override close(): Promise<void> {
        this.closes++
        return Promise.resolve()
      }
    }
    const shared = new SharedRAM()
    const ws = new Workspace({ '/m': shared, '/other': shared })
    await ws.resolve('/m/x')

    await ws.unmount('/m')

    expect(shared.closes).toBe(0)
    expect(ws.registry.mountFor('/other/x').resource).toBe(shared)
    await ws.close()
  })

  it('keeps the mount attached when cache eviction fails', async () => {
    const ws = new Workspace({ '/m': new CachingRAMResource() })
    const mount = ws.registry.mountForPrefix('/m')
    if (mount.cacheManager === null) throw new Error('missing cache manager')
    mount.cacheManager.dropPrefix = () => Promise.reject(new Error('cache unavailable'))

    await expect(ws.unmount('/m')).rejects.toThrow('cache unavailable')

    expect(ws.registry.mountFor('/m/x')).toBe(mount)
    await ws.close()
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
