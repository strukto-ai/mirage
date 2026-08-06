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

import { CacheKey, JobKey, MountKey, StateKey } from './keys.ts'
import { splitManifestAndBlobs } from './manifest.ts'
import { readSnapshotTar, writeSnapshotTar } from './tar_io.ts'
import { BLOB_REF_KEY } from './utils.ts'

// Mirrors python/tests/workspace/snapshot/test_manifest.py.

type AnyDict = Record<string, unknown>

function makeState(): AnyDict {
  return {
    [StateKey.VERSION]: 2,
    [StateKey.MIRAGE_VERSION]: '0.0.0',
    [StateKey.DEFAULT_SESSION_ID]: 's1',
    [StateKey.DEFAULT_AGENT_ID]: null,
    [StateKey.CURRENT_AGENT_ID]: null,
    [StateKey.SESSIONS]: [],
    [StateKey.MOUNTS]: [],
    [StateKey.CACHE]: {
      [CacheKey.LIMIT]: 10,
      [CacheKey.MAX_DRAIN_BYTES]: null,
      [CacheKey.ENTRIES]: [],
    },
    [StateKey.JOBS]: [],
  }
}

describe('splitManifestAndBlobs', () => {
  it('carries a key it never heard of through the tar', async () => {
    // The regression guard for the whole bug class: state grows a key,
    // nobody touches manifest.ts, and a tar snapshot still carries it.
    // An allowlist dropped such a key silently, with every in-memory
    // snapshot test still green (they never pass through here).
    const state = makeState()
    state.future_thing = { a: 1, b: ['c'] }

    const [manifest, blobs] = splitManifestAndBlobs(state)
    expect(manifest.future_thing).toEqual({ a: 1, b: ['c'] })

    const tar = await writeSnapshotTar(manifest, blobs)
    const restored = (await readSnapshotTar(tar)) as AnyDict
    expect(restored.future_thing).toEqual({ a: 1, b: ['c'] })
  })

  it('keeps every known key at its captured value', () => {
    const state = makeState()
    state[StateKey.CLIS] = [{ name: 'pager', spec: 'pager', config: null }]
    state[StateKey.NODES] = { '/a': { target: '/b' } }
    state[StateKey.FINGERPRINTS] = [{ path: '/a', mount_prefix: '/' }]
    state[StateKey.LIVE_ONLY_MOUNTS] = ['/gmail']

    const [manifest] = splitManifestAndBlobs(state)

    expect(manifest[StateKey.CLIS]).toEqual(state[StateKey.CLIS])
    expect(manifest[StateKey.NODES]).toEqual(state[StateKey.NODES])
    expect(manifest[StateKey.FINGERPRINTS]).toEqual(state[StateKey.FINGERPRINTS])
    expect(manifest[StateKey.LIVE_ONLY_MOUNTS]).toEqual(['/gmail'])
    expect(manifest[StateKey.VERSION]).toBe(2)
    expect(manifest[StateKey.SESSIONS]).toEqual([])
  })

  it('stashes cache entry bytes as a blob reference', () => {
    const state = makeState()
    ;(state[StateKey.CACHE] as AnyDict)[CacheKey.ENTRIES] = [
      { key: '/a', [CacheKey.DATA]: new TextEncoder().encode('hello') },
    ]

    const [manifest, blobs] = splitManifestAndBlobs(state)

    const cache = manifest[StateKey.CACHE] as AnyDict
    const entries = cache[CacheKey.ENTRIES] as AnyDict[]
    const ref = (entries[0]?.[CacheKey.DATA] as AnyDict | undefined)?.[BLOB_REF_KEY]
    expect(typeof ref).toBe('string')
    expect(blobs[String(ref)]).toEqual(new TextEncoder().encode('hello'))
    // Sibling cache knobs survive the rewrite of the entries list.
    expect(cache[CacheKey.LIMIT]).toBe(10)
  })

  it('stashes job streams and writes empty ones as text', () => {
    const state = makeState()
    state[StateKey.JOBS] = [
      {
        [JobKey.ID]: 1,
        [JobKey.STDOUT]: new TextEncoder().encode('out'),
        [JobKey.STDERR]: new Uint8Array(0),
      },
    ]

    const [manifest, blobs] = splitManifestAndBlobs(state)

    const job = (manifest[StateKey.JOBS] as AnyDict[])[0]
    const ref = (job?.[JobKey.STDOUT] as AnyDict | undefined)?.[BLOB_REF_KEY]
    expect(blobs[String(ref)]).toEqual(new TextEncoder().encode('out'))
    expect(job?.[JobKey.STDERR]).toBe('')
  })

  it('rewrites mount resource state instead of passing it through', () => {
    const state = makeState()
    state[StateKey.MOUNTS] = [
      {
        [MountKey.INDEX]: 0,
        [MountKey.PREFIX]: '/m',
        [MountKey.RESOURCE_STATE]: {
          type: 'ram',
          files: { '/a.txt': new TextEncoder().encode('hi') },
        },
      },
    ]

    const [manifest, blobs] = splitManifestAndBlobs(state)

    const mount = (manifest[StateKey.MOUNTS] as AnyDict[])[0]
    const resourceState = mount?.[MountKey.RESOURCE_STATE] as AnyDict | undefined
    const files = resourceState?.files as AnyDict | undefined
    const ref = (files?.['/a.txt'] as AnyDict | undefined)?.[BLOB_REF_KEY]
    expect(blobs[String(ref)]).toEqual(new TextEncoder().encode('hi'))
  })
})
