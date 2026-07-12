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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { command, type CommandFn } from '../../commands/config.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountCommandUnsupported, MountRegistry } from './registry.ts'

class StubResource implements Resource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

class RAMStubResource implements Resource {
  readonly kind = 'ram'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const NOOP_CMD: CommandFn = () => [null, new IOResult({ exitCode: 0 })]
const EMPTY_SPEC = new CommandSpec()

describe('MountRegistry.resolve', () => {
  it('resolves a nested path to the matching mount; PathSpec keeps original + sets prefix', () => {
    const ram = new StubResource()
    const reg = new MountRegistry({ '/data': ram }, MountMode.WRITE)
    const [r, p, mode] = reg.resolve('/data/foo.txt')
    expect(r).toBe(ram)
    expect(p.virtual).toBe('/data/foo.txt')
    expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('/data')
    expect(p.mountPath).toBe('/foo.txt')
    expect(mode).toBe(MountMode.WRITE)
  })

  it('resolves the mount root exactly', () => {
    const ram = new StubResource()
    const reg = new MountRegistry({ '/data': ram }, MountMode.READ)
    const [, p] = reg.resolve('/data')
    expect(p.virtual).toBe('/data')
    expect(p.mountPath).toBe('/')
  })

  it('picks the longest matching prefix', () => {
    const root = new StubResource()
    const logs = new StubResource()
    const reg = new MountRegistry({ '/data': root, '/data/logs': logs }, MountMode.READ)
    const [picked, p] = reg.resolve('/data/logs/2026.log')
    expect(picked).toBe(logs)
    expect(p.virtual).toBe('/data/logs/2026.log')
    expect(p.mountPath).toBe('/2026.log')
  })

  it('falls back to the shorter mount when longer does not match', () => {
    const root = new StubResource()
    const logs = new StubResource()
    const reg = new MountRegistry({ '/data': root, '/data/logs': logs }, MountMode.READ)
    const [picked] = reg.resolve('/data/other')
    expect(picked).toBe(root)
  })

  it('uses a root mount when nothing more specific matches', () => {
    const rootRes = new StubResource()
    const reg = new MountRegistry({ '/': rootRes }, MountMode.READ)
    const [r, p] = reg.resolve('/anywhere/deep/file')
    expect(r).toBe(rootRes)
    expect(p.virtual).toBe('/anywhere/deep/file')
  })

  it('preserves a trailing slash on the resolved path', () => {
    const ram = new StubResource()
    const reg = new MountRegistry({ '/data': ram }, MountMode.READ)
    const [, p] = reg.resolve('/data/logs/')
    expect(p.virtual).toBe('/data/logs/')
    expect(p.mountPath).toBe('/logs')
  })

  it('throws when no mount matches the path', () => {
    const reg = new MountRegistry({ '/data': new StubResource() }, MountMode.READ)
    expect(() => reg.resolve('/elsewhere')).toThrow(/no mount matches/)
  })

  it('normalizes mount prefixes so "/data", "data", and "/data/" collide', () => {
    const a = new StubResource()
    const b = new StubResource()
    expect(() => new MountRegistry({ '/data': a, 'data/': b }, MountMode.READ)).toThrow(
      /duplicate mount prefix/,
    )
  })
})

describe('MountRegistry.descendantMounts', () => {
  function multi(): MountRegistry {
    return new MountRegistry(
      { '/': new StubResource(), '/r2': new StubResource(), '/ram': new StubResource() },
      MountMode.WRITE,
    )
  }

  function nested(): MountRegistry {
    return new MountRegistry(
      {
        '/': new StubResource(),
        '/data': new StubResource(),
        '/data/inner': new StubResource(),
      },
      MountMode.WRITE,
    )
  }

  it('returns descendant mounts strictly under the given path', () => {
    const reg = multi()
    const prefixes = reg.descendantMounts('/').map((m) => m.prefix)
    expect(prefixes).toContain('/r2/')
    expect(prefixes).toContain('/ram/')
    expect(prefixes).not.toContain('/')
  })

  it('returns descendants in mount-prefix sorted order', () => {
    const reg = multi()
    const prefixes = reg.descendantMounts('/').map((m) => m.prefix)
    const sorted = [...prefixes].sort()
    expect(prefixes).toEqual(sorted)
  })

  it('returns empty when the path is exactly a mount root with no nested mount', () => {
    const reg = new MountRegistry({ '/data': new StubResource() }, MountMode.WRITE)
    expect(reg.descendantMounts('/data')).toEqual([])
    expect(reg.descendantMounts('/data/')).toEqual([])
  })

  it('returns empty for a path inside a mount with no nested mount', () => {
    const reg = new MountRegistry({ '/data': new StubResource() }, MountMode.WRITE)
    expect(reg.descendantMounts('/data/sub')).toEqual([])
  })

  it('lists nested mounts under the parent', () => {
    const reg = nested()
    const prefixes = reg.descendantMounts('/').map((m) => m.prefix)
    expect(prefixes).toContain('/data/')
    expect(prefixes).toContain('/data/inner/')
  })

  it('descendants of a nested-parent mount excludes self and includes child', () => {
    const reg = nested()
    const prefixes = reg.descendantMounts('/data').map((m) => m.prefix)
    expect(prefixes).toEqual(['/data/inner/'])
  })

  it('excludes self when path is exactly a mount root', () => {
    const reg = nested()
    const prefixes = reg.descendantMounts('/data').map((m) => m.prefix)
    expect(prefixes).not.toContain('/data/')
  })
})

describe('MountRegistry.resolveMount: cross-mount fallback', () => {
  it('falls back to a resource-specific mount when cwd mount lacks the cmd', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const b = reg.mountForPrefix('/b')
    if (b === null) throw new Error('missing /b mount')
    const [grepB] = command({ name: 'grep', resource: 'ram', spec: EMPTY_SPEC, fn: NOOP_CMD })
    if (grepB === undefined) throw new Error('missing grep cmd')
    b.register(grepB)
    const mount = await reg.resolveMount('grep', [], '/a/x')
    expect(mount).toBe(b)
  })

  it('still allows fallback when fallback cmd is general (e.g. seq)', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const b = reg.mountForPrefix('/b')
    if (b === null) throw new Error('missing /b mount')
    const [seqB] = command({ name: 'seq', resource: null, spec: EMPTY_SPEC, fn: NOOP_CMD })
    if (seqB === undefined) throw new Error('missing seq cmd')
    b.registerGeneral(seqB)
    const mount = await reg.resolveMount('seq', [], '/a/x')
    expect(mount).toBe(b)
  })

  it('finds nested resource mount even when a parent mount intercepts cwd', async () => {
    const reg = new MountRegistry(
      { '/home': new RAMStubResource(), '/home/zecheng/linear': new RAMStubResource() },
      MountMode.READ,
    )
    const linear = reg.mountForPrefix('/home/zecheng/linear')
    if (linear === null) throw new Error('missing /home/zecheng/linear mount')
    const [linearSearch] = command({
      name: 'linear-search',
      resource: 'ram',
      spec: EMPTY_SPEC,
      fn: NOOP_CMD,
    })
    if (linearSearch === undefined) throw new Error('missing linear-search cmd')
    linear.register(linearSearch)
    const mount = await reg.resolveMount('linear-search', [], '/home/zecheng')
    expect(mount).toBe(linear)
  })

  it('returns null when no mount has the command', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const mount = await reg.resolveMount('nonexistent-cmd', [], '/a/x')
    expect(mount).toBeNull()
  })

  it('returns null when cwd matches no mount and no mount has the command', async () => {
    const reg = new MountRegistry({ '/a': new RAMStubResource() }, MountMode.READ)
    const mount = await reg.resolveMount('linear-search', [], '/somewhere/else')
    expect(mount).toBeNull()
  })

  it('returns the cwd mount directly when it has the command', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const a = reg.mountForPrefix('/a')
    const b = reg.mountForPrefix('/b')
    if (a === null || b === null) throw new Error('missing mount')
    const [grepA] = command({ name: 'grep', resource: 'ram', spec: EMPTY_SPEC, fn: NOOP_CMD })
    const [grepB] = command({ name: 'grep', resource: 'ram', spec: EMPTY_SPEC, fn: NOOP_CMD })
    if (grepA === undefined || grepB === undefined) throw new Error('missing grep cmd')
    a.register(grepA)
    b.register(grepB)
    const mount = await reg.resolveMount('grep', [], '/a/x')
    expect(mount).toBe(a)
  })

  it('routes by first path arg when present, ignoring cwd', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const b = reg.mountForPrefix('/b')
    if (b === null) throw new Error('missing /b mount')
    const [grepB] = command({ name: 'grep', resource: 'ram', spec: EMPTY_SPEC, fn: NOOP_CMD })
    if (grepB === undefined) throw new Error('missing grep cmd')
    b.register(grepB)
    const path = new PathSpec({
      resourcePath: 'b/file.txt',
      virtual: '/b/file.txt',
      directory: '/b',
    })
    const mount = await reg.resolveMount('grep', [path], '/a/x')
    expect(mount).toBe(b)
  })

  it('resolves write command on READ fallback mount so execution reports read-only', async () => {
    const reg = new MountRegistry(
      { '/a': new RAMStubResource(), '/b': new RAMStubResource() },
      MountMode.READ,
    )
    const b = reg.mountForPrefix('/b')
    if (b === null) throw new Error('missing /b mount')
    const [writeCmd] = command({
      name: 'mutate',
      resource: 'ram',
      spec: EMPTY_SPEC,
      fn: NOOP_CMD,
      write: true,
    })
    if (writeCmd === undefined) throw new Error('missing write cmd')
    b.register(writeCmd)
    const mount = await reg.resolveMount('mutate', [], '/a/x')
    expect(mount).toBe(b)
    if (mount === null) throw new Error('missing mutate mount')
    const [, io] = await mount.executeCmd('mutate', [], [], {})
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toContain(
      'mutate: read-only mount at /b/',
    )
  })
})

class LimitedResource implements Resource {
  readonly kind = 'limited'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

describe('MountRegistry.resolveMount: path-bound dispatch', () => {
  function pathBoundRegistryWithFallback(): MountRegistry {
    const reg = new MountRegistry({ '/limited/': new LimitedResource() }, MountMode.WRITE)
    reg.mount('/', new RAMStubResource(), MountMode.WRITE)
    const root = reg.mountForPrefix('/')
    if (root === null) throw new Error('missing / mount')
    const [fallbackOnly] = command({
      name: 'fallback-only',
      resource: 'ram',
      spec: EMPTY_SPEC,
      fn: NOOP_CMD,
    })
    if (fallbackOnly === undefined) throw new Error('missing fallback-only cmd')
    root.register(fallbackOnly)
    return reg
  }

  it('rejects a path-bound command unsupported by its backend', async () => {
    const reg = pathBoundRegistryWithFallback()
    const path = new PathSpec({
      resourcePath: 'limited/file.txt',
      virtual: '/limited/file.txt',
      directory: '/limited',
    })
    await expect(reg.resolveMount('fallback-only', [path], '/limited')).rejects.toThrow(
      MountCommandUnsupported,
    )
    await expect(reg.resolveMount('fallback-only', [path], '/limited')).rejects.toThrow(
      'fallback-only: /limited/file.txt: Operation not supported',
    )
  })

  it('allows the fallback mount when the command is not path-bound', async () => {
    const reg = pathBoundRegistryWithFallback()
    const mount = await reg.resolveMount('fallback-only', [], '/limited')
    expect(mount).not.toBeNull()
    expect(mount?.prefix).toBe('/')
  })
})
