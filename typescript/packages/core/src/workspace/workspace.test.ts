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
import type { FileCache } from '../cache/file/mixin.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { MountMode, ResourceName, type PathSpec } from '../types.ts'
import type { Resource } from '../resource/base.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

class MockResource implements Resource {
  readonly kind = 'mock'
  opens = 0
  closes = 0
  open(): Promise<void> {
    this.opens++
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closes++
    return Promise.resolve()
  }
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
  class StubCache implements Resource, FileCache {
    readonly kind = ResourceName.RAM
    readonly store = new Map<string, Uint8Array>()
    getCalls = 0
    setCalls = 0
    maxDrainBytes: number | null = null
    open(): Promise<void> {
      return Promise.resolve()
    }
    close(): Promise<void> {
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
    exists(key: string | PathSpec): Promise<boolean> {
      const k = typeof key === 'string' ? key : key.stripPrefix
      return Promise.resolve(this.store.has(k))
    }
    isFresh(): Promise<boolean> {
      return Promise.resolve(false)
    }
    clear(): Promise<void> {
      this.store.clear()
      return Promise.resolve()
    }
    allCached(keys: readonly string[]): Promise<boolean> {
      return Promise.resolve(keys.every((k) => this.store.has(k)))
    }
    multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]> {
      return Promise.resolve(keys.map((k) => this.store.get(k) ?? null))
    }
  }

  it('accepts a user-supplied FileCache', () => {
    const cache = new StubCache()
    const ws = new Workspace({}, { cache })
    expect(ws).toBeDefined()
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
    expect(ws.registry.mountFor('/a/x')?.prefix).toBe('/')
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
