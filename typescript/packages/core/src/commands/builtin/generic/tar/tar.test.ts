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

// Mirrors python/tests/commands/builtin/generic/tar/test_tar.py.

import { beforeAll, expect, it } from 'vitest'
import { gzip } from '../../../../utils/compress.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { writeTar } from '../../tar_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

let OK: Uint8Array = new Uint8Array()

beforeAll(async () => {
  OK = await gzip(
    await writeTar([
      { name: 'd/a.txt', data: ENC.encode('hello\n'), isFile: true },
      { name: 'd/b.txt', data: ENC.encode('bee\n'), isFile: true },
    ]),
  )
})

async function shell(
  line: string,
  seed: Record<string, Uint8Array>,
): Promise<[number, string, string]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, data] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: data })
    }
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

it('lists the member a cut short stream reaches', async () => {
  // The stream holds the first header and no data block: GNU lists the
  // member it reached, then stops there without its child's status (tar
  // 1.35, same bytes).
  const r = await shell('tar -tzf /data/cut.tgz', { '/data/cut.tgz': OK.subarray(0, -40) })
  expect(r).toEqual([
    2,
    'd/a.txt\n',
    '\ngzip: stdin: unexpected end of file\n' +
      'tar: Unexpected EOF in archive\n' +
      'tar: Error is not recoverable: exiting now\n',
  ])
})

it('streams an archive without a writable root or a dash file', async () => {
  const ws = new Workspace(
    { '/data': [new RAMVFS(), MountMode.WRITE] },
    {
      mode: MountMode.READ,
      shellParser: await getTestParser(),
    },
  )
  await ws.shell('printf hello > /data/a')
  const result = await ws.shell('tar -cvf - -C /data a | tar -xOf -')
  expect(result.exitCode).toBe(0)
  expect(DEC.decode(result.stdout)).toBe('hello')
  expect(DEC.decode(result.stderr)).toBe('a\n')
  expect((await ws.shell('test ! -e /-')).exitCode).toBe(0)
  await ws.close()
})
