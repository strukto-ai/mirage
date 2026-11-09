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
import { Workspace } from '../../../workspace/workspace/workspace.ts'

// Pinned on xz 5.8.1.
describe('xz and unxz', () => {
  it.each([
    ['echo hi > /d/a; xz /d/a; ls /d; unxz /d/a.xz; cat /d/a', 'a.xz\nhi\n', '', 0],
    ['echo hi > /d/a; xz -k /d/a; ls /d', 'a\na.xz\n', '', 0],
    ['echo hi | xz | xz -d', 'hi\n', '', 0],
    [
      'echo hi > /d/a.xz; xz /d/a.xz',
      '',
      "xz: /d/a.xz: File already has '.xz' suffix, skipping\n",
      2,
    ],
    ['echo hi > /d/a; touch /d/a.xz; xz /d/a', '', 'xz: /d/a.xz: File exists\n', 1],
    ['xz /d/nosuch', '', 'xz: /d/nosuch: No such file or directory\n', 1],
    ['mkdir /d/s; xz /d/s', '', 'xz: /d/s: Is a directory, skipping\n', 2],
    ['echo plain > /d/p; xz -d /d/p', '', 'xz: /d/p: File format not recognized\n', 1],
    [
      'echo hi | xz > /d/valid; xz -d /d/valid',
      '',
      'xz: /d/valid: Filename has an unknown suffix, skipping\n',
      2,
    ],
    ['printf junk | xz -d', '', 'xz: (stdin): File format not recognized\n', 1],
    ['xz -T x', '', 'xz: x: Value is not a non-negative decimal integer\n', 1],
    ['xz --check=bad', '', 'xz: bad: Unsupported integrity check type\n', 1],
    [
      'unxz -Z',
      '',
      "unxz: invalid option -- 'Z'\nunxz: Try 'unxz --help' for more information.\n",
      1,
    ],
    ['xz -q /d/nosuch 2>/dev/null; echo $?', '1\n', '', 0],
  ])('%s', async (line, stdout, stderr, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([stdout, stderr, code])
  })
})
