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
import { PathSpec, type FileStat } from '../../types.ts'
import { ManualClock, runWithSystemClock } from '../../utils/clock.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { tokenOf } from './fingerprint.ts'

const ENC = new TextEncoder()

async function rewritten(vfs: RAMVFS): Promise<[FileStat, FileStat, FileStat | undefined]> {
  const at = PathSpec.fromStrPath('/f')
  await vfs.write(at, ENC.encode('one'))
  const first = await vfs.stat(at)
  await vfs.write(at, ENC.encode('two'))
  const second = await vfs.stat(at)
  const tree = await vfs.readTree(PathSpec.fromStrPath('/'))
  return [first, second, tree?.get('f')]
}

describe('tokenOf', () => {
  it('gives a file no write dated none', () => {
    expect(tokenOf(new RAMStore(), '/f')).toBeNull()
  })

  it('moves on a same-size rewrite on a clock that stands still', async () => {
    const [first, second, listed] = await runWithSystemClock(new ManualClock(1_800_000_000), () =>
      rewritten(new RAMVFS()),
    )
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(listed?.fingerprint).toBe(second.fingerprint)
  })
})
