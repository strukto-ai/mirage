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

import { mountKey } from '../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import type { Accessor } from '../accessor/base.ts'
import { PathSpec } from '../types.ts'
import { runWithCacheManager } from './context.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { CacheManager } from './manager.ts'
import {
  cacheAwareReadBytes,
  cacheAwareReadStream,
  cacheAwareStreamEager,
  cachedPrefixBytes,
} from './read_through.ts'

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
    resourcePath: mountKey('/s3/a.txt', '/s3/'),
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

describe('cacheAwareStreamEager', () => {
  it('captures the manager before lazy drain', async () => {
    const backend = new CountingBackend(ENC.encode('payload'))
    const manager = await warmManager(ENC.encode('payload'))
    // Wrap inside the scope, drain outside it: the eager variant must have
    // captured the manager at wrap time.
    const wrapped = await runWithCacheManager(manager, () =>
      Promise.resolve(
        cacheAwareStreamEager((p) => backend.readStream(null as unknown as Accessor, p)),
      ),
    )
    const out = await drain(wrapped(spec()))
    expect(DEC.decode(out)).toBe('payload')
    expect(backend.streamCalls).toBe(0)
  })
})

describe('cachedPrefixBytes', () => {
  it('slices the cached blob when warm', async () => {
    const manager = await warmManager(ENC.encode('payload'))
    const [prefix, whole] = await runWithCacheManager(manager, async () => [
      await cachedPrefixBytes(spec(), 4),
      await cachedPrefixBytes(spec(), null),
    ])
    expect(prefix === null ? '' : DEC.decode(prefix)).toBe('payl')
    expect(whole === null ? '' : DEC.decode(whole)).toBe('payload')
  })

  it('returns null on miss and with no manager', async () => {
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
    const miss = await runWithCacheManager(manager, () => cachedPrefixBytes(spec(), 4))
    expect(miss).toBeNull()
    expect(await cachedPrefixBytes(spec(), 4)).toBeNull()
  })
})
