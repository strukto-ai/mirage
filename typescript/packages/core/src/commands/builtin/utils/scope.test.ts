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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { scopeWarning } from './scope.ts'

function scope(): PathSpec {
  return new PathSpec({
    virtual: '/dir',
    directory: '/dir',
    resolved: false,
    resourcePath: mountKey('/dir', ''),
  })
}

function readdirOf(count: number): (p: string) => Promise<string[]> {
  return (p: string) =>
    Promise.resolve(
      p === '/dir' ? Array.from({ length: count }, (_v, i) => `/dir/f${String(i)}`) : [],
    )
}

const statFile = (): Promise<FileStat> =>
  Promise.resolve(new FileStat({ name: 'f', type: FileType.TEXT }))

describe('scopeWarning', () => {
  it('returns null at or below the suggest threshold', async () => {
    expect(await scopeWarning(readdirOf(500), statFile, scope(), false)).toBeNull()
  })

  it('returns a scanning warning above the suggest threshold', async () => {
    expect(await scopeWarning(readdirOf(1500), statFile, scope(), false)).toBe(
      'scanning 1500 files under /dir',
    )
  })

  it('throws scope-too-large above the error threshold', async () => {
    await expect(scopeWarning(readdirOf(10001), statFile, scope(), false)).rejects.toThrow(
      /^scope too large: \d+ files under \/dir$/,
    )
  })
})
