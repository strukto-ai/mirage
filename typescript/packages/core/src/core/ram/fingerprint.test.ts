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

  it('moves when a time set back by hand is the one it had', async () => {
    // touch -r can put back the very time the first write gave the file; the
    // fingerprint carries the stamp of that set, so it is not the first
    // write's. Mirrors Python's test_a_time_set_back_by_hand_still_moves_it.
    const at = PathSpec.fromStrPath('/f')
    const vfs = new RAMVFS()
    const [first, after] = await runWithSystemClock(new ManualClock(1_800_000_000), async () => {
      await vfs.write(at, ENC.encode('one'))
      const was = await vfs.stat(at)
      await vfs.write(at, ENC.encode('two'))
      await vfs.setattr(at, { mtime: was.modified ?? '' })
      return [was, await vfs.stat(at)] as const
    })
    expect(after.modified).toBe(first.modified)
    expect(after.fingerprint).not.toBe(first.fingerprint)
  })

  it('moves on the first rewrite of a store loaded from a saved one', async () => {
    // The saved store's last stamp comes back with it: a store that started
    // again from zero would give its first rewrite, under the same frozen
    // clock, the time the saved store gave the file. Mirrors Python's
    // test_a_loaded_store_stamps_past_the_one_it_was_saved_from.
    const at = PathSpec.fromStrPath('/f')
    const vfs = new RAMVFS()
    const [saved, rewritten] = await runWithSystemClock(
      new ManualClock(1_800_000_000),
      async () => {
        await vfs.write(at, ENC.encode('one'))
        const was = await vfs.stat(at)
        const loaded = new RAMVFS()
        loaded.loadState(vfs.getState())
        await loaded.write(at, ENC.encode('two'))
        return [was, await loaded.stat(at)] as const
      },
    )
    expect(rewritten.fingerprint).not.toBe(saved.fingerprint)
  })
})
