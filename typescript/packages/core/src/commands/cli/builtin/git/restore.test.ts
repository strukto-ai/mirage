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

import { PathSpec } from '../../../../types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { refuseRuled } from './restore.ts'
import type { RepoLocation } from './types.ts'

/** Files that fail on any call, for code that must make none. */
function noCalls(): Files {
  return new Proxy(
    {},
    {
      get(_, name) {
        throw new Error(`made a file call: ${String(name)}`)
      },
    },
  ) as Files
}

describe('refuseRuled', () => {
  it('makes no file call without a rule', async () => {
    const repo = PathSpec.fromStrPath('/repo')
    const location: RepoLocation = {
      gitdir: PathSpec.fromStrPath('/repo/.git'),
      commondir: PathSpec.fromStrPath('/repo/.git'),
      worktree: repo,
      mountRoot: repo,
      vfs: noCalls(),
    }
    await expect(refuseRuled(noCalls(), location, ['a.txt', 'box'], ['b.txt'])).resolves.toBe(
      undefined,
    )
  })
})
