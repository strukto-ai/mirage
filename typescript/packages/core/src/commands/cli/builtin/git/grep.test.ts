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

const STOPPED = 'fatal: stopped after 2 files (full_scan_limit); narrow the pathspec\n'

// Twin of test_grep.py.
describe('git grep past the full scan limit', () => {
  it.each([
    ['grep -e e', 128, 'a.txt:one changed\n', STOPPED],
    ['grep --cached -e e', 128, 'a.txt:one changed\n', STOPPED],
    ['grep -e e -- c.txt', 0, 'c.txt:three\n', ''],
    ['grep -q -e one', 0, '', ''],
  ])('git %s', async (line, code, out, err) => {
    const ws = new Workspace(
      { '/repo': new RAMVFS({ fullScanLimit: 2 }) },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    ws.registerCli('git', GIT)
    try {
      await ws.shell(
        'cd /repo && git init -q && echo "one changed" > a.txt && echo two > b.txt && ' +
          'echo three > c.txt && git add a.txt b.txt c.txt',
      )
      const result = await ws.shell(`git -C /repo ${line}`)
      expect([result.exitCode, result.stdoutText, new TextDecoder().decode(result.stderr)]).toEqual(
        [code, out, err],
      )
    } finally {
      await ws.close()
    }
  })
})
