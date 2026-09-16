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
import { FileChangeKind, PathSpec } from '@struktoai/mirage-core/types'
import { makeFakeAccessor } from './_test_utils.ts'
import { buildDeltaHook } from './watch.ts'

describe('SSH watch checkpoints', () => {
  it.each(['2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.123Z'])(
    'preserves persisted fingerprints for %s',
    async (stamp) => {
      const file = {
        data: new TextEncoder().encode('hello'),
        attrs: { mtime: Date.parse(stamp) / 1000 },
      }
      const accessor = makeFakeAccessor({
        files: new Map([['/a.txt', file]]),
        dirs: new Map([['/', {}]]),
      })
      const hook = buildDeltaHook(accessor)
      const root = PathSpec.fromStrPath('/ssh', '')
      const checkpoint = JSON.stringify({ '/ssh/a.txt': `${stamp}|5` })
      const unchanged = await hook.pull(root, checkpoint)
      expect(unchanged.changes).toEqual([])
      expect(unchanged.checkpoint).toBe(checkpoint)
      file.attrs.mtime += 1
      const changed = await hook.pull(root, checkpoint)
      expect(changed.changes.map((c) => c.kind)).toEqual([FileChangeKind.UPDATE])
    },
  )
})
