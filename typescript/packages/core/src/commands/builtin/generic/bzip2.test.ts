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

// Pinned on bzip2 1.0.8.
describe('bzip2 and bunzip2', () => {
  it.each([
    ['echo hi > /d/a; bzip2 /d/a; ls /d; bunzip2 /d/a.bz2; cat /d/a', 'a.bz2\nhi\n', '', 0],
    ['echo hi > /d/a; bzip2 -k /d/a; ls /d', 'a\na.bz2\n', '', 0],
    ['echo hi | bzip2 | bzip2 -d', 'hi\n', '', 0],
    [
      'echo hi > /d/a.bz2; bzip2 /d/a.bz2',
      '',
      'bzip2: Input file /d/a.bz2 already has .bz2 suffix.\n',
      1,
    ],
    [
      'echo hi > /d/a; touch /d/a.bz2; bzip2 /d/a',
      '',
      'bzip2: Output file /d/a.bz2 already exists.\n',
      1,
    ],
    [
      'bzip2 /d/nosuch',
      '',
      "bzip2: Can't open input file /d/nosuch: No such file or directory.\n",
      1,
    ],
    ['mkdir /d/s; bzip2 /d/s', '', 'bzip2: Input file /d/s is a directory.\n', 1],
    ['echo hi > /d/g.bz2; bzip2 -d /d/g.bz2', '', 'bzip2: /d/g.bz2 is not a bzip2 file.\n', 2],
    [
      'echo hi | bzip2 > /d/n; bunzip2 /d/n; ls /d',
      'n.out\n',
      "bunzip2: Can't guess original name for /d/n -- using /d/n.out\n",
      0,
    ],
    [
      'printf x > /d/a; bzip2 -kv /d/a',
      '',
      '  /d/a:     0.027:1, 296.000 bits/byte, -3600.00% saved, 1 in, 37 out.\n',
      0,
    ],
    ['echo hi | bzip2 > /d/a.bz2; bzip2 -tv /d/a.bz2', '', '  /d/a.bz2: ok\n', 0],
    [
      'echo hi | bzip2 -v | wc -c',
      '40\n',
      '  (stdin):  0.075:1, 106.667 bits/byte, -1233.33% saved, 3 in, 40 out.\n',
      0,
    ],
  ])('%s', async (line, stdout, stderr, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([stdout, stderr, code])
  })
})
