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

import { tarGeneric } from './tar.ts'
import type { Context } from '../../../../commands/config.ts'
import { ensureStream } from '../../../../io/stream.ts'
import { materialize } from '../../../../io/types.ts'
import { readTar } from '../../tar_helper.ts'
// Mirrors python/tests/commands/builtin/generic/tar/test_tar.py.

import { expect, it } from 'vitest'
import { PathSpec, FileStat, FileType, MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function shell(
  line: string,
  seed: Record<string, Uint8Array>,
): Promise<[number, string, string]> {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
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
  const cut = new Uint8Array([
    31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 209, 79, 212, 43, 169, 40, 97, 160, 37, 48, 0, 2, 51, 19,
    19, 48, 13, 4, 232, 52, 72, 22, 137, 13, 18, 55, 55, 52, 49, 101, 80, 48, 160, 169, 171, 160,
    160, 180, 184, 36, 177, 8, 104, 37, 61, 236, 26, 132, 32, 35, 53, 39, 39, 159, 107, 160, 93, 49,
    10, 6,
  ])
  const r = await shell('tar -tzf /data/cut.tgz', { '/data/cut.tgz': cut })
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

it('emits a known-size archive header before draining its source', async () => {
  const pulled: string[] = []
  let closed = false
  const result = await tarGeneric(
    [PathSpec.fromStrPath('/a')],
    [],
    {
      flags: { create: true },
      cwd: PathSpec.fromStrPath('/'),
      stdin: null,
    } as Context,
    {
      async *stream() {
        try {
          for (const part of ['abc', 'def']) {
            await Promise.resolve()
            pulled.push(part)
            yield ENC.encode(part)
          }
        } finally {
          closed = true
        }
      },
      write: () => {
        throw new Error('unexpected write')
      },
      mkdir: () => {
        throw new Error('unexpected mkdir')
      },
      stat: () => Promise.resolve(new FileStat({ name: 'a', type: FileType.FILE, size: 6 })),
      walk: () => {
        throw new Error('unexpected walk')
      },
      isDir: () => Promise.resolve(false),
    },
  )
  if (result?.[0] == null) throw new Error('missing archive')
  const stream = ensureStream(result[0])[Symbol.asyncIterator]()
  const first = await stream.next()
  expect(first.done).toBe(false)
  expect(pulled).toEqual(['abc'])
  const rest = await materialize({ [Symbol.asyncIterator]: () => stream })
  const header: unknown = first.value
  if (!(header instanceof Uint8Array)) throw new Error('missing header')
  const all = new Uint8Array(header.length + rest.length)
  all.set(header)
  all.set(rest, header.length)
  expect(DEC.decode((await readTar(all))[0]?.data)).toBe('abcdef')
  expect(result[1].exitCode).toBe(0)
  expect(closed).toBe(true)
})
