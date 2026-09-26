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

import { beforeAll, describe, expect, it } from 'vitest'
import { gzip } from '../../../utils/compress.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { writeTar } from '../tar_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const CHILD_FAILED = 'tar: Child returned status 1\ntar: Error is not recoverable: exiting now\n'

let OK: Uint8Array = new Uint8Array()
// The same archive with its CRC-32 and length trailer zeroed.
let DAMAGED = new Uint8Array()

beforeAll(async () => {
  OK = await gzip(
    await writeTar([
      { name: 'd/a.txt', data: ENC.encode('hello\n'), isFile: true },
      { name: 'd/b.txt', data: ENC.encode('bee\n'), isFile: true },
    ]),
  )
  DAMAGED = new Uint8Array([...OK.subarray(0, -8), 0, 0, 0, 0, 0, 0, 0, 0])
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

describe('tar over a gzip child that fails', () => {
  it("is gzip's refusal, then tar's, for a non-gzip archive", async () => {
    // GNU tar 1.35 reads -z through a gzip -d child and dies when it
    // fails, after gzip's own line.
    const r = await shell('tar -tzf /data/c.tgz', { '/data/c.tgz': ENC.encode('corrupted\n') })
    expect(r).toEqual([2, '', 'gzip: stdin: not in gzip format\n' + CHILD_FAILED])
  })

  it('still yields every member past a damaged trailer', async () => {
    const seed = { '/data/bad.tgz': DAMAGED }
    const reasons =
      'gzip: stdin: invalid compressed data--crc error\n' +
      'gzip: stdin: invalid compressed data--length error\n'
    expect(await shell('tar -tzf /data/bad.tgz nomatch', seed)).toEqual([
      2,
      '',
      reasons + CHILD_FAILED,
    ])
    expect(await shell('tar -xzf /data/bad.tgz -C /data; cat /data/d/*', seed)).toEqual([
      0,
      'hello\nbee\n',
      reasons + CHILD_FAILED,
    ])
  })

  it('takes the same road on the gzip magic without -z', async () => {
    const r = await shell('tar -tf /data/junk.tgz', {
      '/data/junk.tgz': new Uint8Array([...OK, ...ENC.encode('xy')]),
    })
    expect(r).toEqual([
      2,
      'd/a.txt\nd/b.txt\n',
      'gzip: stdin: decompression OK, trailing garbage ignored\n' +
        'tar: Child returned status 2\n' +
        'tar: Error is not recoverable: exiting now\n',
    ])
  })

  it('yields nothing from a member cut short', async () => {
    const r = await shell('tar -tzf /data/cut.tgz', { '/data/cut.tgz': OK.subarray(0, -40) })
    expect(r).toEqual([2, '', 'gzip: stdin: unexpected end of file\n' + CHILD_FAILED])
  })
})

it.each(['-tzf', '-tf', '-xOzf'])(
  'keeps complete tar members with a truncated gzip wrapper: %s',
  async (flags) => {
    for (const data of [
      OK.subarray(0, -8),
      OK.subarray(0, -3),
      new Uint8Array([...OK, ...OK.subarray(0, 2)]),
    ]) {
      const out = flags === '-xOzf' ? 'hello\nbee\n' : 'd/a.txt\nd/b.txt\n'
      expect(await shell(`tar ${flags} /data/cut.tgz`, { '/data/cut.tgz': data })).toEqual([
        2,
        out,
        'gzip: stdin: unexpected end of file\n' + CHILD_FAILED,
      ])
    }
  },
)

it('extracts complete tar members despite a truncated gzip trailer', async () => {
  expect(
    await shell('tar -xzf /data/cut.tgz -C /data; cat /data/d/*', {
      '/data/cut.tgz': OK.subarray(0, -3),
    }),
  ).toEqual([0, 'hello\nbee\n', 'gzip: stdin: unexpected end of file\n' + CHILD_FAILED])
})

it.each(['-tzf', '-xzf', '-xOzf'])(
  'preserves the gzip failure when tar cannot parse its output: %s',
  async (flags) => {
    const bad = await gzip(ENC.encode('not a tar\n'))
    bad.fill(0, bad.length - 8)
    expect(await shell(`tar ${flags} /data/bad.tgz`, { '/data/bad.tgz': bad })).toEqual([
      2,
      '',
      'gzip: stdin: invalid compressed data--crc error\n' +
        'gzip: stdin: invalid compressed data--length error\n' +
        CHILD_FAILED,
    ])
  },
)
