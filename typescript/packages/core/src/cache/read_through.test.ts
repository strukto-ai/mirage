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
import type { Accessor } from '../accessor/base.ts'
import { stdinStream } from '../commands/builtin/utils/stream.ts'
import { PathSpec } from '../types.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { runWithCacheManager } from './context.ts'
import { withCacheMutation } from './file/io.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { CacheManager } from './manager.ts'
import { cacheAwareReadBytes, cacheAwareReadStream } from './read_through.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class CountingBackend {
  streamCalls = 0
  bytesCalls = 0
  constructor(private readonly data: Uint8Array) {}

  readBytes = (_a: Accessor, _p: PathSpec): Promise<Uint8Array> => {
    this.bytesCalls += 1
    return Promise.resolve(this.data)
  }

  readStream = async function* (
    this: CountingBackend,
    _a: Accessor,
    _p: PathSpec,
  ): AsyncIterable<Uint8Array> {
    this.streamCalls += 1
    await Promise.resolve()
    yield this.data
  }
}

function spec(): PathSpec {
  return new PathSpec({
    virtual: '/s3/a.txt',
    directory: '/s3/',
    vfsPath: mountKey('/s3/a.txt', '/s3/'),
  })
}

async function warmManager(data: Uint8Array): Promise<CacheManager> {
  const cache = new RAMFileCacheStore()
  await cache.set('/s3/a.txt', data)
  return new CacheManager(cache, null, '/s3/', true)
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of source) chunks.push(c)
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

describe('cacheAwareReadBytes', () => {
  it('warm hit serves cache without touching the backend', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = await warmManager(ENC.encode('payload'))
    const reader = cacheAwareReadBytes(backend.readBytes)
    const out = await runWithCacheManager(manager, () =>
      reader(null as unknown as Accessor, spec()),
    )
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.bytesCalls).toBe(0)
  })

  it('cold miss falls through to the backend', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
    const reader = cacheAwareReadBytes(backend.readBytes)
    const out = await runWithCacheManager(manager, () =>
      reader(null as unknown as Accessor, spec()),
    )
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.bytesCalls).toBe(1)
  })

  it('no active manager falls through to the backend', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const reader = cacheAwareReadBytes(backend.readBytes)
    const out = await reader(null as unknown as Accessor, spec())
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.bytesCalls).toBe(1)
  })
})

describe('cacheAwareReadStream', () => {
  it('warm hit serves cache without touching the backend', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = await warmManager(ENC.encode('payload'))
    const reader = cacheAwareReadStream(backend.readStream.bind(backend))
    const out = await runWithCacheManager(manager, () =>
      drain(reader(null as unknown as Accessor, spec())),
    )
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.streamCalls).toBe(0)
  })

  it('cold miss falls through to the backend', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
    const reader = cacheAwareReadStream(backend.readStream.bind(backend))
    const out = await runWithCacheManager(manager, () =>
      drain(reader(null as unknown as Accessor, spec())),
    )
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.streamCalls).toBe(1)
  })
})

describe('readStream binding', () => {
  it('captures the manager before lazy drain', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = await warmManager(ENC.encode('payload'))
    // Wrap inside the scope, drain outside it: the adapter must have
    // captured the manager at wrap time.
    const wrapped = await runWithCacheManager(manager, () =>
      Promise.resolve(cacheAwareReadStream(backend.readStream.bind(backend))),
    )
    const out = await drain(wrapped(null as unknown as Accessor, spec()))
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.streamCalls).toBe(0)
  })
})

it('stdin wrapper preserves file cache context', async () => {
  const backend = new CountingBackend(ENC.encode('changed'))
  const manager = await warmManager(ENC.encode('cached'))
  const cachedRead = cacheAwareReadStream(backend.readStream.bind(backend))
  const reader = stdinStream(
    (path) => cachedRead(null as unknown as Accessor, path),
    ENC.encode('pipe'),
  )
  const source = await runWithCacheManager(manager, () => Promise.resolve(reader(spec())))
  expect(DEC.decode(await drain(source))).toBe('cached')
  expect(DEC.decode(await drain(reader(PathSpec.fromStrPath('-'))))).toBe('pipe')
  expect(DEC.decode(await drain(reader(PathSpec.fromStrPath('-'))))).toBe('')
  expect(backend.streamCalls).toBe(0)
})

it('caches a complete render and its byte size before lazy consumers transform it', async () => {
  const backend = new CountingBackend(ENC.encode('雪\n'))
  const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
  const reader = await runWithCacheManager(manager, () =>
    Promise.resolve(cacheAwareReadBytes(backend.readBytes)),
  )
  expect(await reader(null as unknown as Accessor, spec())).toEqual(ENC.encode('雪\n'))
  expect(await reader(null as unknown as Accessor, spec())).toEqual(ENC.encode('雪\n'))
  expect(await manager.cachedSize(spec())).toBe(4)
  expect(backend.bytesCalls).toBe(1)
})

it('does not repopulate a cache invalidated during a read', async () => {
  const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
  expect(
    await manager.readThrough(spec(), async () => {
      await manager.invalidateAfterWrite(spec())
      return ENC.encode('old')
    }),
  ).toEqual(ENC.encode('old'))
  expect(await manager.cachedBytes(spec())).toBeNull()
})

it('does not repopulate a retired mount after a read', async () => {
  let live = true
  const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true, () => live)
  await manager.readThrough(spec(), () => {
    live = false
    return Promise.resolve(ENC.encode('old'))
  })
  live = true
  expect(await manager.cachedBytes(spec())).toBeNull()
})

it('does not keep a fill whose keep turns false mid-fetch', async () => {
  let keepable = true
  const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
  const read = await manager.fill(
    spec(),
    () => {
      keepable = false
      return Promise.resolve(ENC.encode('old'))
    },
    () => keepable,
  )
  expect(read).toEqual(ENC.encode('old'))
  expect(await manager.cachedBytes(spec())).toBeNull()
})

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`not settled within ${String(ms)}ms`))
    }, ms)
  })
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer)
  })
}

it('asks keep only once the fill holds the mutation lock', async () => {
  // A fill that fetched waits for the lock behind another holder; what keep
  // answers while it waits is not the answer it must act on.
  let keepable = true
  const store = new RAMFileCacheStore()
  const manager = new CacheManager(store, null, '/s3/', true)
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let fetched: () => void = () => undefined
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve
  })
  const holding = withCacheMutation(store, () => held)
  const filling = manager.fill(
    spec(),
    () => {
      fetched()
      return Promise.resolve(ENC.encode('old'))
    },
    () => keepable,
  )
  try {
    await within(fetching, 1000)
    keepable = false
    release()
    expect(await within(filling, 1000)).toEqual(ENC.encode('old'))
  } finally {
    release()
    await holding
  }
  expect(await manager.cachedBytes(spec())).toBeNull()
})

it('does not cache failed reads', async () => {
  const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
  await expect(
    manager.readThrough(spec(), () => Promise.reject(new Error('failed read'))),
  ).rejects.toThrow('failed read')
  expect(await manager.cachedBytes(spec())).toBeNull()
})
