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
// Mirrors python/tests/commands/builtin/generic/test_gunzip.py.

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

describe('gunzip with a dash operand', () => {
  it('writes the dash to stdout while files decompress in place', async () => {
    const r = await shell(
      'cd /data && gzip b.txt && gunzip - b.txt.gz; ls; cat b.txt',
      await gzip(new TextEncoder().encode('hi\n')),
      { '/data/b.txt': 'file\n' },
    )
    expect(r).toEqual(['hi\nb.txt\nfile\n', '', 0])
  })
})

describe('gunzip on inputs gzip refuses', () => {
  it('reports a plain file and leaves it in place', async () => {
    const r = await shell('cd /data && gzip b.txt && gunzip p.gz b.txt.gz; ls', null, {
      '/data/b.txt': 'file\n',
      '/data/p.gz': 'plain\n',
    })
    expect(r).toEqual(['b.txt\np.gz\n', 'gunzip: p.gz: not in gzip format\n', 0])
  })

  it('calls plain stdin not in gzip format', async () => {
    const r = await shell('gunzip', new TextEncoder().encode('hello\n'))
    expect(r).toEqual(['', 'gunzip: stdin: not in gzip format\n', 1])
  })
})
