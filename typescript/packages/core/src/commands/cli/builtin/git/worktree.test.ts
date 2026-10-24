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
import { getTestParser } from '../../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const DEC = new TextDecoder()

// Twin of test_a_work_tree_past_the_walk_limit_fails_unless_named.
describe('a work tree past the walk_limit', () => {
  it.each([
    ['status', 2, true],
    ['add -A', 2, true],
    ['diff', 1, true],
    ['reset', 1, true],
    ['add sub', 2, true],
    ['add sub/x.txt', 2, false],
    ["add 'sub/[id].tsx'", 2, false],
    ['diff -- a.txt', 1, false],
    ['rm -q --cached b.txt', 1, false],
  ] as [string, number, boolean][])('git %s at %i refused: %s', async (line, limit, refused) => {
    const ws = new Workspace(
      { '/repo': new RAMVFS({ walkLimit: limit }) },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    ws.registerCli('git', GIT)
    try {
      await ws.shell(
        'git init -q /repo && touch /repo/a.txt /repo/b.txt && git -C /repo add a.txt b.txt && ' +
          "mkdir /repo/sub && touch /repo/sub/x.txt /repo/sub/y.txt '/repo/sub/[id].tsx'",
      )
      const result = await ws.shell(`git -C /repo ${line} >/dev/null; echo $?`)
      const outcome = [DEC.decode(result.stdout), DEC.decode(result.stderr)]
      if (refused) {
        expect(outcome).toEqual([
          '128\n',
          `fatal: more than ${String(limit)} files in the work tree (walk_limit)\n`,
        ])
        expect((await ws.shell('git -C /repo ls-files')).stdoutText).toBe('a.txt\nb.txt\n')
      } else {
        expect(outcome).toEqual(['0\n', ''])
      }
    } finally {
      await ws.close()
    }
  })
})
