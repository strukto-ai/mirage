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
import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { makeFakeAccessor } from './_test_utils.ts'
import { mkdir } from './mkdir.ts'
import { stat } from './stat.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

class RecordingInvalidator implements CacheInvalidator {
  listingTrusted(_folder: string): boolean {
    return false
  }

  probedStat(): null {
    return null
  }

  readonly writes: string[] = []
  readonly ancestors: string[] = []

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(): Promise<void> {
    return Promise.resolve()
  }

  invalidateAncestors(path: PathSpec): Promise<void> {
    this.ancestors.push(path.virtual)
    return Promise.resolve()
  }

  invalidateSubtree(): Promise<void> {
    return Promise.resolve()
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  cachedBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(): Promise<number | null> {
    return Promise.resolve(null)
  }
}

async function record(path: string, recursive: boolean): Promise<RecordingInvalidator> {
  const recorder = new RecordingInvalidator()
  const accessor = makeFakeAccessor({ files: new Map(), dirs: new Map([['/', {}]]) })
  await runWithCacheManager(recorder, async () => {
    await mkdir(accessor, spec(path), recursive)
  })
  return recorder
}

describe('core/ssh/mkdir', () => {
  // A cross-mount mkdir calls this directly, past the dispatcher's own
  // eviction, so the parent's cached listing must be dropped here. Mirrors
  // the python mkdir: the path always, its ancestors only with parents.
  it('invalidates the new directory without parents', async () => {
    const recorder = await record('/d', false)
    expect(recorder.writes).toEqual(['/d'])
    expect(recorder.ancestors).toEqual([])
  })

  it('invalidates the new directory and its ancestors with parents', async () => {
    const recorder = await record('/a/b/c', true)
    expect(recorder.writes).toEqual(['/a/b/c'])
    expect(recorder.ancestors).toEqual(['/a/b/c'])
  })

  it('creates a single directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/d'), false)
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('creates parents when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/a/b/c'), true)
    expect((await stat(accessor, spec('/a'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b/c'))).type).toBe(FileType.DIRECTORY)
  })

  it('is idempotent on existing directory when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    await expect(mkdir(accessor, spec('/d'), true)).resolves.toBeUndefined()
  })

  it('fails when parent missing and not recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(mkdir(accessor, spec('/a/b'), false)).rejects.toThrow()
  })
})
