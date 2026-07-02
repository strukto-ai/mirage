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

// Every read-content command funnels its file read through one of these
// shared consumers, which wrap the injected reader with cacheAware* at the
// choke point. A backend can therefore pass a RAW reader and warm reads
// still serve from cache. These tests pin that guarantee: with a warm
// manager active, the consumer must NOT call the backend reader.

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { runWithCacheManager } from '../../cache/context.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { CacheManager } from '../../cache/manager.ts'
import { materialize } from '../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { CommandFnResult, CommandOpts } from '../config.ts'
import type { Resource } from '../../resource/base.ts'
import { grepGeneric } from './generic/grep.ts'
import { headGeneric } from './generic/head.ts'
import { rgGeneric } from './generic/rg.ts'
import { tailGeneric } from './generic/tail.ts'
import { wcGeneric } from './generic/wc.ts'

const PAYLOAD = new TextEncoder().encode('alpha\nbeta\n')

class CountingStream {
  calls = 0
  stream = (_p: PathSpec): AsyncIterable<Uint8Array> => {
    this.calls += 1
    const data = PAYLOAD
    return (async function* () {
      await Promise.resolve()
      yield data
    })()
  }
}

function spec(): PathSpec {
  return new PathSpec({
    virtual: '/s3/a.txt',
    directory: '/s3/',
    resourcePath: mountKey('/s3/a.txt', '/s3/'),
  })
}

async function warmManager(): Promise<CacheManager> {
  const cache = new RAMFileCacheStore()
  await cache.set('/s3/a.txt', PAYLOAD)
  return new CacheManager(cache, null, '/s3/', true)
}

function statOf(_p: PathSpec): Promise<FileStat> {
  return Promise.resolve(new FileStat({ name: 'a.txt', size: PAYLOAD.length, type: FileType.TEXT }))
}

function readdirOf(_p: PathSpec): Promise<string[]> {
  return Promise.resolve([])
}

function opts(flags: Record<string, string | boolean | string[]> = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
  }
}

async function out(result: CommandFnResult): Promise<string> {
  if (result === null) return ''
  const [source] = result
  if (source === null) return ''
  return new TextDecoder().decode(await materialize(source))
}

describe('warm reads serve cache uniformly across shared consumers', () => {
  it('headGeneric serves cache without the backend (built in-scope, drained after)', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    // Build in scope, drain outside: also pins eager capture in the multi path.
    const result = await runWithCacheManager(manager, () =>
      headGeneric([spec()], [], opts({ n: '1' }), statOf, reader.stream),
    )
    expect(await out(result)).toBe('alpha\n')
    expect(reader.calls).toBe(0)
  })

  it('tailGeneric serves cache without the backend', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      tailGeneric([spec()], [], opts({ n: '1' }), reader.stream),
    )
    expect(await out(result)).toBe('beta\n')
    expect(reader.calls).toBe(0)
  })

  it('wcGeneric serves cache without the backend', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      wcGeneric([spec()], [], opts({ args_l: true }), reader.stream),
    )
    expect(await out(result)).toContain('2')
    expect(reader.calls).toBe(0)
  })

  it('grepGeneric serves cache without the backend', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      grepGeneric('grep', [spec()], ['alpha'], opts(), statOf, readdirOf, reader.stream),
    )
    expect(await out(result)).toContain('alpha')
    expect(reader.calls).toBe(0)
  })

  it('rgGeneric serves cache without the backend', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      rgGeneric([spec()], ['alpha'], opts(), statOf, readdirOf, reader.stream),
    )
    expect(await out(result)).toContain('alpha')
    expect(reader.calls).toBe(0)
  })
})
