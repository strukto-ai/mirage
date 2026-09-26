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
// Mirrors python/tests/commands/builtin/generic/test_gzip.py.

import { describe, expect, it } from 'vitest'
import { gzip } from '../../../utils/compress.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

async function shell(
  line: string,
  stdin: Uint8Array | null = null,
  seed: Record<string, string> = {},
): Promise<[string, string, number]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, body] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: new TextEncoder().encode(body) })
    }
    const io = await ws.shell(line, { stdin })
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('gzip with a dash operand', () => {
  it('writes the dash to stdout while files compress in place', async () => {
    const r = await shell(
      'cd /data && gzip - a.txt | gzip -dc; ls',
      new TextEncoder().encode('hi\n'),
      {
        '/data/a.txt': 'file\n',
      },
    )
    expect(r).toEqual(['hi\na.txt.gz\n', '', 0])
  })
})

describe('gzip -d on inputs gzip refuses', () => {
  it('calls a truncated stdin an unexpected end', async () => {
    const cut = (await gzip(new TextEncoder().encode('hi\n'))).subarray(0, 10)
    expect(await shell('gzip -dc', cut)).toEqual(['', 'gzip: stdin: unexpected end of file\n', 1])
  })
})
