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

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { readStream } from './stream.ts'
import { parseEntry } from './tree.ts'

function loaded(): HfHubAccessor {
  const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
  accessor.tree = new Map([
    ['m', parseEntry({ type: 'directory', oid: 'tree-m', size: 0, path: 'm' })],
    ['m/k.txt', parseEntry({ type: 'file', oid: 'oid-k', size: 5, path: 'm/k.txt' })],
  ])
  accessor.treeLoaded = true
  accessor.rowsCache = null
  return accessor
}

const PATH = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

afterEach(() => {
  vi.restoreAllMocks()
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('hf_hub stream record path', () => {
  it('records the virtual path', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(async function* () {
      await Promise.resolve()
      yield new TextEncoder().encode('hello')
    })
    const [text, records] = await runWithRecording(async () => {
      let out = ''
      for await (const chunk of readStream(loaded(), PATH)) out += new TextDecoder().decode(chunk)
      return out
    })
    expect(text).toBe('hello')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

function answering(etag: string, ...payload: string[]) {
  // Reports its headers the way the real hubStream does: once, before the
  // first chunk.
  return async function* (
    _token: string | undefined,
    _url: string,
    onResponse?: (headers: Record<string, string>) => void,
  ): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    onResponse?.({ etag })
    for (const item of payload) yield new TextEncoder().encode(item)
  }
}

describe('hf_hub stream stamp', () => {
  it('stamps the oid when the etag names the row', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(answering('"oid-k"', 'ab', 'cd'))
    // Only the first chunk is pulled: stamped as soon as the response
    // arrived, so a reader that stops after one chunk (head -c 1) still
    // leaves a token behind.
    const [, records] = await runWithRecording(async () => {
      await readStream(loaded(), PATH)[Symbol.asyncIterator]().next()
    })
    expect(records.map((r) => r.fingerprint)).toEqual(['oid-k'])
  })

  it('stamps nothing when the bytes are another version', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(answering('"another-version"', 'newr'))
    const [, records] = await runWithRecording(async () => {
      for await (const chunk of readStream(loaded(), PATH)) void chunk
    })
    expect(records.map((r) => r.fingerprint)).toEqual([null])
  })

  it('reads with no recorder bound', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(answering('"oid-k"', 'ab'))
    const parts: string[] = []
    for await (const chunk of readStream(loaded(), PATH))
      parts.push(new TextDecoder().decode(chunk))
    expect(parts).toEqual(['ab'])
  })
})

describe('a stream the Hub refuses', () => {
  it('is permission denied', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(async function* () {
      await Promise.resolve()
      throw new client.HfHubError('gated', 403)
      yield new Uint8Array()
    })
    const err = await (async () => {
      for await (const chunk of readStream(loaded(), PATH)) void chunk
    })().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('EACCES')
  })
})
