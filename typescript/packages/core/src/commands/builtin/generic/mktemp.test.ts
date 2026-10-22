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
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { SeededIdSource } from '../../../utils/ids.ts'
import type { Context } from '../../config.ts'
import { mktempGeneric } from './mktemp.ts'

function refuse(): Promise<void> {
  throw new Error('-u creates nothing')
}

// Pinned by tests/commands/builtin/generic/test_mktemp.py too: one seed names
// the same file on both hosts.
describe('mktemp draws its name from the context id source', () => {
  it('replays a name', async () => {
    for (let i = 0; i < 2; i++) {
      const ctx = {
        stdin: null,
        flags: { dry_run: true },
        cwd: PathSpec.fromStrPath('/'),
        ids: new SeededIdSource(5),
      } as Context
      const result = await mktempGeneric(['x.XXXXXX'], ctx, refuse, refuse)
      if (result === null) throw new Error('mktemp declined its own line')
      const [out, io] = result
      expect(io.exitCode).toBe(0)
      expect(out === null ? '' : new TextDecoder().decode(await materialize(out))).toBe(
        'x.MNjKYk\n',
      )
    }
  })
})
