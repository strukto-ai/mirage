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
import { ALL_COMMANDS } from '../../../../policy/builtin/output_cap.ts'
import { Limit, MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const STOPPED = 'fatal: stopped after 2 files (walk_limit); narrow the pathspec\n'

// Twin of test_grep.py.
describe('git grep past the walk limit', () => {
  it.each([
    ['grep -e e', 128, 'a.txt:one changed\n', STOPPED],
    ['grep --cached -e e', 128, 'a.txt:one changed\n', STOPPED],
    ['grep -e e -- c.txt', 0, 'c.txt:three\n', ''],
    ['grep -q -e one', 0, '', ''],
  ])('git %s', async (line, code, out, err) => {
    const ws = new Workspace(
      { '/repo': [new RAMVFS(), MountMode.WRITE, { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }] },
      { mode: MountMode.WRITE },
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

// Twin of test_a_work_tree_counts_against_the_mount_serving_it.
describe('git grep over a work tree on another mount', () => {
  it.each([
    ['', 'a.txt:one\n128\n', STOPPED],
    ['--cached ', 'a.txt:one\nc.txt:three\n0\n', ''],
  ])('git grep %s-e e', async (flag, out, err) => {
    const ws = new Workspace(
      {
        '/meta': [new RAMVFS(), MountMode.WRITE, { [ALL_COMMANDS]: new Limit({ walkLimit: -1 }) }],
        '/data': [new RAMVFS(), MountMode.WRITE, { [ALL_COMMANDS]: new Limit({ walkLimit: 2 }) }],
      },
      { mode: MountMode.WRITE },
    )
    ws.registerCli('git', GIT)
    const git = 'git --git-dir=/meta/.git --work-tree=/data'
    try {
      await ws.shell(
        'git init -q /meta && echo one > /data/a.txt && echo two > /data/b.txt && ' +
          `echo three > /data/c.txt && ${git} add a.txt b.txt c.txt`,
      )
      const result = await ws.shell(`${git} grep ${flag}-e e; echo $?`)
      expect([result.stdoutText, new TextDecoder().decode(result.stderr)]).toEqual([out, err])
    } finally {
      await ws.close()
    }
  })
})
