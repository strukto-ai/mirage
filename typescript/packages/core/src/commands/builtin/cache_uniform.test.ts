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
import { runWithCacheManager } from '../../cache/context.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { CacheManager } from '../../cache/manager.ts'
import { eacces } from '../../errors/fs.ts'
import { materialize } from '../../io/types.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../config.ts'
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
    vfsPath: mountKey('/s3/a.txt', '/s3/'),
  })
}

async function warmManager(): Promise<CacheManager> {
  const cache = new RAMFileCacheStore()
  await cache.set('/s3/a.txt', PAYLOAD)
  return new CacheManager(cache, null, '/s3/', true)
}

function statOf(_p: PathSpec): Promise<FileStat> {
  return Promise.resolve(
    new FileStat({
      name: 'a.txt',
      size: PAYLOAD.length,
      type: FileType.FILE,
      content: ContentType.TEXT,
    }),
  )
}

function readdirOf(_p: PathSpec): Promise<string[]> {
  return Promise.resolve([])
}

async function* refusedStream(path: PathSpec): AsyncIterable<Uint8Array> {
  yield await Promise.reject(eacces(path.virtual))
}

function opts(flags: Record<string, string | boolean | number | string[]> = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  }
}

async function out(result: CommandFnResult): Promise<string> {
  if (result === null) return ''
  const [source] = result
  if (source === null) return ''
  return new TextDecoder().decode(await materialize(source))
}

describe('readers under a warm cache', () => {
  it.each(['grep', 'rg'])('%s cannot skip a refused reader with a warm cache', async (name) => {
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      name === 'grep'
        ? grepGeneric('grep', [spec()], ['alpha'], opts(), statOf, readdirOf, refusedStream)
        : rgGeneric([spec()], ['alpha'], opts(), statOf, readdirOf, refusedStream),
    )
    if (name === 'grep') {
      await expect(out(result)).rejects.toMatchObject({ code: 'EACCES' })
      return
    }
    expect(await out(result)).toBe('')
    expect(result?.[1].exitCode).toBe(2)
    expect(new TextDecoder().decode(await materialize(result?.[1].stderr ?? null))).toContain(
      'Permission denied',
    )
  })

  it('headGeneric uses its injected reader with a warm cache (built in-scope, drained after)', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    // Build in scope, drain outside: also pins eager capture in the multi path.
    const result = await runWithCacheManager(manager, () =>
      headGeneric([spec()], [], opts({ lines: '1' }), statOf, reader.stream),
    )
    expect(await out(result)).toBe('alpha\n')
    expect(reader.calls).toBe(1)
  })

  it('tailGeneric uses its injected reader with a warm cache', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      tailGeneric([spec()], [], opts({ n: '1' }), reader.stream, statOf),
    )
    expect(await out(result)).toBe('beta\n')
    expect(reader.calls).toBe(1)
  })

  it('wcGeneric uses its injected reader with a warm cache', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      wcGeneric([spec()], [], opts({ args_l: true }), reader.stream),
    )
    expect(await out(result)).toContain('2')
    expect(reader.calls).toBe(1)
  })

  it('grepGeneric uses its injected reader with a warm cache', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      grepGeneric('grep', [spec()], ['alpha'], opts(), statOf, readdirOf, reader.stream),
    )
    expect(await out(result)).toContain('alpha')
    expect(reader.calls).toBe(1)
  })

  it('rgGeneric uses its injected reader with a warm cache', async () => {
    const reader = new CountingStream()
    const manager = await warmManager()
    const result = await runWithCacheManager(manager, () =>
      rgGeneric([spec()], ['alpha'], opts(), statOf, readdirOf, reader.stream),
    )
    expect(await out(result)).toContain('alpha')
    expect(reader.calls).toBe(1)
  })
})
