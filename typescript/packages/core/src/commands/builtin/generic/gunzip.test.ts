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
import { MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { gunzipWrites } from './gunzip.ts'

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

describe('gunzip on a dash operand', () => {
  it('writes nothing', () => {
    // A `-` has no file to replace: gunzip decompresses stdin to stdout.
    const dash = new PathSpec({
      virtual: '/data/-',
      directory: '/data/',
      vfsPath: '-',
      rawPath: '-',
    })
    expect(gunzipWrites({}, [dash])).toBe(false)
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

// gzip -n of "hello\n" with its CRC-32 and length trailer zeroed.
const HELLO = [
  0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 2, 0, 0x20, 0x30, 0x3a,
  0x36, 6, 0, 0, 0,
]
const DAMAGED = new Uint8Array([...HELLO.slice(0, -8), 0, 0, 0, 0, 0, 0, 0, 0])

describe('gunzip on a damaged member', () => {
  it('keeps the inflated bytes before the trailer errors', async () => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      await ws.shell('tee /data/bad.gz > /dev/null', { stdin: DAMAGED })
      await ws.shell('tee /data/ok.gz > /dev/null', {
        stdin: await gzip(new TextEncoder().encode('x\n')),
      })
      const io = await ws.shell('gunzip -c /data/bad.gz /data/ok.gz')
      const dec = new TextDecoder()
      expect([dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]).toEqual([
        'hello\n',
        'gunzip: /data/bad.gz: invalid compressed data--crc error\n' +
          'gunzip: /data/bad.gz: invalid compressed data--length error\n',
        1,
      ])
    } finally {
      await ws.close()
    }
  })

  it('keeps the members before a later bad header', async () => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const bad = [...HELLO.slice(0, 2), 7, ...HELLO.slice(3)]
      await ws.shell('tee /data/two.gz > /dev/null', { stdin: new Uint8Array([...HELLO, ...bad]) })
      const io = await ws.shell('cd /data && gunzip two.gz; ls; cat two')
      const dec = new TextDecoder()
      expect([dec.decode(io.stdout), dec.decode(io.stderr)]).toEqual([
        'two\nhello\n',
        'gunzip: two.gz: unknown method 7 -- not supported\n',
      ])
    } finally {
      await ws.close()
    }
  })
})
