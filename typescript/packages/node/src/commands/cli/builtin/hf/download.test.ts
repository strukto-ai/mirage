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

import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { ensureDir } from './download.ts'

function exists(code: string, path: string): Error {
  return Object.assign(new Error(path), { code })
}

describe('ensureDir', () => {
  it('tolerates a parent another worker just made', async () => {
    // A parallel download fans out over files that share parents, so two
    // workers can read the same parent as missing and then both create it.
    // The loser's EEXIST must not reject the whole Promise.all.
    const dirs = new Set<string>()
    const dispatch = async (op: string, spec: PathSpec) => {
      const path = spec.virtual
      if (op === 'stat') {
        // Yield here, so the second walk probes before the first has
        // created anything. Without it the two run to completion in turn
        // and the race the fix exists for never happens.
        await Promise.resolve()
        if (dirs.has(path)) return [{ name: path, type: FileType.DIRECTORY }, null]
        throw exists('ENOENT', path)
      }
      if (op === 'mkdir') {
        if (dirs.has(path)) throw exists('EEXIST', path)
        dirs.add(path)
        return [null, null]
      }
      throw new Error(`unexpected op ${op}`)
    }
    await Promise.all([
      ensureDir(dispatch as never, PathSpec.fromStrPath('/work/out')),
      ensureDir(dispatch as never, PathSpec.fromStrPath('/work/out')),
    ])
    expect([...dirs].sort()).toEqual(['/work', '/work/out'])
  })

  it('still reports a mkdir that failed for any other reason', async () => {
    const dispatch = (op: string, spec: PathSpec) => {
      if (op === 'stat') return Promise.reject(exists('ENOENT', spec.virtual))
      return Promise.reject(exists('EACCES', spec.virtual))
    }
    await expect(ensureDir(dispatch as never, PathSpec.fromStrPath('/work/out'))).rejects.toThrow(
      /work/,
    )
  })
})
