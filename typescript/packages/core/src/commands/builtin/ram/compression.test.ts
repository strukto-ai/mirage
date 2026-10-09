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

import { invoke } from '../../../io/stdio.ts'
import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import type { Command } from '../../config.ts'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
import { gzip as gzipUtil, gunzip as gunzipUtil } from '../../../utils/compress.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
const RAM_GZIP = RAM_COMMANDS.filter((c) => c.name === 'gzip' && c.filetype == null)
const RAM_GUNZIP = RAM_COMMANDS.filter((c) => c.name === 'gunzip' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runCmd(
  reg: readonly Command[],
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
  stdin: Uint8Array | null,
): Promise<{ out: Uint8Array; writes: Record<string, Uint8Array>; exitCode: number }> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await invoke(() =>
    cmd.fn(vfs.accessor, paths, [], {
      stdin,
      flags,
      io: commandIo(vfs),
      cwd: '/',
    }),
  )
  if (result === null) return { out: new Uint8Array(), writes: {}, exitCode: 0 }
  const [output, io] = result as [unknown, { writes: Record<string, Uint8Array>; exitCode: number }]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return { out: outBytes, writes: io.writes, exitCode: io.exitCode }
}

describe('gzip / gunzip', () => {
  it('gzip from stdin produces gzip output', async () => {
    const vfs = new RAMVFS()
    const { out } = await runCmd(RAM_GZIP, vfs, [], {}, ENC.encode('hello world'))
    const decompressed = await gunzipUtil(out)
    expect(DEC.decode(decompressed)).toBe('hello world')
  })

  it('gunzip from stdin decompresses', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzipUtil(ENC.encode('hello world'))
    const { out } = await runCmd(RAM_GUNZIP, vfs, [], {}, compressed)
    expect(DEC.decode(out)).toBe('hello world')
  })

  it('gzip -> gunzip round trip via stdin', async () => {
    const vfs = new RAMVFS()
    const { out: gz } = await runCmd(RAM_GZIP, vfs, [], {}, ENC.encode('roundtrip test'))
    const { out: plain } = await runCmd(RAM_GUNZIP, vfs, [], {}, gz)
    expect(DEC.decode(plain)).toBe('roundtrip test')
  })

  it('gzip on a file writes <path>.gz', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('test content'))
    const { writes } = await runCmd(RAM_GZIP, vfs, [PathSpec.fromStrPath('/f.txt')], {}, null)
    expect(writes['/f.txt.gz']).toBeDefined()
  })

  it('gunzip on a file writes <path> without .gz', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzipUtil(ENC.encode('original data'))
    vfs.store.files.set('/f.txt.gz', compressed)
    const { writes } = await runCmd(RAM_GUNZIP, vfs, [PathSpec.fromStrPath('/f.txt.gz')], {}, null)
    expect(writes['/f.txt']).toBeDefined()
    expect(DEC.decode(writes['/f.txt'])).toBe('original data')
  })
})

async function readOnlyShell(line: string): Promise<[number, string, string, string[]]> {
  const vfs = new RAMVFS()
  vfs.store.files.set('/f.txt', ENC.encode('hello\n'))
  vfs.store.files.set('/f.txt.gz', await gzipUtil(ENC.encode('hello\n')))
  vfs.store.files.set('/g.txt', ENC.encode('fresh\n'))
  const ws = new Workspace(
    { '/ro/': [vfs, MountMode.READ] },
    { shellParser: await getTestParser() },
  )
  try {
    const r = await ws.shell(line)
    return [
      r.exitCode,
      DEC.decode(r.stdout),
      DEC.decode(r.stderr),
      [...vfs.store.files.keys()].sort(),
    ]
  } finally {
    await ws.close()
  }
}

describe('gzip and gunzip on a read-only mount', () => {
  it.each([
    ["cd /ro && printf 'x\\n' | gzip | gunzip", 'x\n'],
    ['gzip -c /ro/f.txt | gunzip', 'hello\n'],
    ['gzip -dc /ro/f.txt.gz', 'hello\n'],
    ["cd /ro && printf 'x\\n' | gzip - | gunzip -", 'x\n'],
    ['gunzip -c /ro/f.txt.gz', 'hello\n'],
    ['gunzip -t /ro/f.txt.gz && echo ok', 'ok\n'],
    ['cd /ro && gunzip < f.txt.gz', 'hello\n'],
    ['cd /ro && gunzip - < f.txt.gz', 'hello\n'],
  ])('runs %s, which writes nothing', async (line, stdout) => {
    expect(await readOnlyShell(line)).toEqual([0, stdout, '', ['/f.txt', '/f.txt.gz', '/g.txt']])
  })

  // Nothing refuses the command before it runs: the write of the
  // replacement file is what the mount refuses, in the command's own
  // voice, and the operand it would have replaced is left in place. An
  // output already there is left alone without -f (a warning); -f's refused
  // replace goes on to the next operand, and an output that cannot be
  // created ends the run with write_error's leading newline. Pinned against
  // gzip 1.13 on a read-only tmpfs; mirrors test_gzip.py.
  const exists = 'gzip: /ro/f.txt.gz already exists;\tnot overwritten\n'
  it.each([
    ['gzip /ro/f.txt', 2, exists],
    ['gzip -k /ro/f.txt', 2, exists],
    ['gzip -f /ro/f.txt', 1, 'gzip: /ro/f.txt.gz: Read-only file system\n'],
    ['gzip /ro/g.txt', 1, '\ngzip: /ro/g.txt.gz: Read-only file system\n'],
    ['gzip /ro/f.txt /ro/g.txt', 1, exists + '\ngzip: /ro/g.txt.gz: Read-only file system\n'],
    ['gzip -d /ro/f.txt.gz', 2, 'gzip: /ro/f.txt already exists;\tnot overwritten\n'],
    ['gzip -df /ro/f.txt.gz', 1, 'gzip: /ro/f.txt: Read-only file system\n'],
    ['gunzip /ro/f.txt.gz', 2, 'gzip: /ro/f.txt already exists;\tnot overwritten\n'],
    ['gunzip -kf /ro/f.txt.gz', 1, 'gzip: /ro/f.txt: Read-only file system\n'],
  ])('refuses %s at its write', async (line, code, stderr) => {
    expect(await readOnlyShell(line)).toEqual([code, '', stderr, ['/f.txt', '/f.txt.gz', '/g.txt']])
  })
})
