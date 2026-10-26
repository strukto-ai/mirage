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

import { expect, it } from 'vitest'
import { getTestParser } from '../../../../../tests/workspace/fixtures/workspace_fixture.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'
import { BaseVFS } from '../../../../vfs/base.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import type { Handed } from '../../../../vfs/types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

// A RAM mount held to two files, with no tree read, noting the limit each
// listing is handed. Twin of Python's AskedRAM.
class AskedRAM extends RAMVFS {
  readonly asked: (number | undefined)[] = []
  override walkLimit = 2

  constructor() {
    super()
    this.store.dirs.add('/d')
    for (const name of ['a', 'b', 'c']) this.store.files.set(`/d/${name}`, new Uint8Array())
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[]> {
    this.asked.push(handed?.limit)
    return super.readdir(path)
  }
}
Object.defineProperty(AskedRAM.prototype, 'readTree', {
  value: (BaseVFS.prototype as unknown as Record<string, unknown>).readTree,
})

// Twin of test_a_walk_hands_its_listing_the_limit.
it.each(['find /ram/d -maxdepth 1', 'tree /ram/d'])(
  '%s hands its listing the limit',
  async (line) => {
    const vfs = new AskedRAM()
    const ws = new Workspace({ '/ram': vfs }, { shellParser: await getTestParser() })
    try {
      await ws.shell(line)
      expect(vfs.asked).toEqual([3])
    } finally {
      await ws.close()
    }
  },
)
