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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { lineFacts } from '../../../workspace/lookup/constants.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

// A hard link is a byte copy. Pinned on coreutils 9.7.
describe('link', () => {
  it.each([
    ['echo hi > /d/a; link /d/a /d/b; cat /d/b', 'hi\n', '', 0],
    [
      'echo hi > /d/a; ln -s /d/none /d/b; link /d/a /d/b; ls /d/none 2>/dev/null',
      '',
      "link: cannot create link '/d/b' to '/d/a': File exists\n",
      2,
    ],
    ['echo hi > /d/a; ln -s /d/a /d/s; link /d/s /d/b; cat /d/b', 'hi\n', '', 0],
    [
      'echo hi > /d/a; link /d/a /d/a',
      '',
      "link: cannot create link '/d/a' to '/d/a': File exists\n",
      1,
    ],
    [
      'link /d/nosuch /d/z',
      '',
      "link: cannot create link '/d/z' to '/d/nosuch': No such file or directory\n",
      1,
    ],
    [
      'mkdir /d/s; link /d/s /d/t',
      '',
      "link: cannot create link '/d/t' to '/d/s': Operation not permitted\n",
      1,
    ],
    ['link', '', "link: missing operand\nTry 'link --help' for more information.\n", 1],
  ])('%s', async (line, stdout, stderr, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([stdout, stderr, code])
  })
})

it('link counts as a write', () => {
  expect(lineFacts('link', ['link', '/d/a', '/d/b'], '/').writes).toBe(true)
})
