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
import {
  blobToMeta,
  metaToBlob,
  toState,
  treeInputsFromState,
  type WorkspaceStateDict,
} from './stateTree.ts'

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function makeState(): WorkspaceStateDict {
  return {
    version: 1,
    mounts: [
      {
        index: 0,
        prefix: '/m',
        mode: 'write',
        resourceClass: 'ram',
        resourceState: {
          type: 'ram',
          files: { '/a.txt': enc('hi'), '/sub/b.txt': enc('bee') },
          dirs: ['/'],
          modified: {},
        },
      },
    ],
    cache: {
      limit: 100,
      entries: [
        { key: 'k', data: enc('CACHE'), fingerprint: null, ttl: null, cachedAt: 0, size: 5 },
      ],
    },
    history: [],
  } as unknown as WorkspaceStateDict
}

describe('stateTree', () => {
  it('pulls mount files and cache out into tree entries', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    expect(Object.keys(entries).sort()).toEqual(['.mirage-cache/0', 'm/a.txt', 'm/sub/b.txt'])
    expect(entries['m/a.txt']).toEqual(enc('hi'))
    expect(meta.mounts[0]?.resourceState).not.toHaveProperty('files')
    expect(meta.cache.entries[0]?.ref).toBe('.mirage-cache/0')
  })

  it('round-trips state through tree inputs and a JSON meta blob', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    const mounts = back.mounts as unknown as {
      resourceState: { files: Record<string, Uint8Array> }
    }[]
    const rs = mounts[0]?.resourceState
    expect(rs?.files['/a.txt']).toEqual(enc('hi'))
    expect(rs?.files['/sub/b.txt']).toEqual(enc('bee'))
    expect(back.cache.entries[0]?.data).toEqual(enc('CACHE'))
    expect(back.history).toEqual([])
  })
})
