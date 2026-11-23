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
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

async function shell(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const out = await ws.shell(line)
    return [out.exitCode, DEC.decode(out.stdout), DEC.decode(out.stderr)]
  } finally {
    await ws.close()
  }
}

describe('hexdump builder', () => {
  it('names files in the working directory with a format file and a dash', async () => {
    expect(
      await shell(
        `cd /d && printf '%s\\n' '1/1 "<%c>" "\\n"' > fmt && printf hi > ./- && echo no | hexdump -f fmt -`,
      ),
    ).toEqual([0, '<h>\n<i>\n', ''])
  })

  it('keeps the bytes of a format string', async () => {
    expect(await shell(`printf h > /d/a && hexdump -e '1/1 "é%c\\n"' /d/a`)).toEqual([
      0,
      'éh\n',
      '',
    ])
  })
})
