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

import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { gzip } from '../../../utils/compress.ts'
const RAM_ZCAT = RAM_COMMANDS.filter((c) => c.name === 'zcat' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runZcat(
  vfs: RAMVFS,
  paths: PathSpec[],
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_ZCAT[0]
  if (cmd === undefined) throw new Error('zcat not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags: {},
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('zcat', () => {
  it('decompresses a gzip file', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('hello world\n'))
    vfs.store.files.set('/f.gz', compressed)
    const r = await runZcat(vfs, [PathSpec.fromStrPath('/f.gz')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('hello world\n')
  })

  it('decompresses from stdin', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('stdin data\n'))
    const r = await runZcat(vfs, [], compressed)
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('stdin data\n')
  })
})

async function shell(
  line: string,
  stdin: Uint8Array | null = null,
  seed: Record<string, Uint8Array> = {},
): Promise<[string, string, number]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, body] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: body })
    }
    const io = await ws.shell(line, { stdin })
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('zcat on inputs gzip refuses', () => {
  it('reports a plain input and goes on', async () => {
    const r = await shell('zcat /data/plain.txt /data/h.gz', null, {
      '/data/plain.txt': ENC.encode('hello\n'),
      '/data/h.gz': await gzip(ENC.encode('hi\n')),
    })
    expect(r).toEqual(['hi\n', '\ngzip: /data/plain.txt: not in gzip format\n', 1])
  })

  it('stops at a truncated archive', async () => {
    const cut = (await gzip(ENC.encode('hello\n'))).subarray(0, 10)
    const r = await shell('zcat /data/cut.gz /data/h.gz', null, {
      '/data/cut.gz': cut,
      '/data/h.gz': await gzip(ENC.encode('hi\n')),
    })
    expect(r).toEqual(['', '\ngzip: /data/cut.gz: unexpected end of file\n', 1])
  })

  it('reads a dash after a refused operand', async () => {
    const r = await shell('cd /data && zcat plain.txt -', await gzip(ENC.encode('hi\n')), {
      '/data/plain.txt': ENC.encode('hello\n'),
    })
    expect(r).toEqual(['hi\n', '\ngzip: plain.txt: not in gzip format\n', 1])
  })

  it('calls empty stdin an unexpected end', async () => {
    expect(await shell('zcat')).toEqual(['', '\ngzip: stdin: unexpected end of file\n', 1])
  })
})
