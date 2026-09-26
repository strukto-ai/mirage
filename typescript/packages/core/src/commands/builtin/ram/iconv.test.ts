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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { PathSpec } from '../../../types.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
const RAM_ICONV = RAM_COMMANDS.filter((c) => c.name === 'iconv' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runIconv(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: Uint8Array; exitCode: number }> {
  const cmd = RAM_ICONV[0]
  if (cmd === undefined) throw new Error('iconv not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: new Uint8Array(), exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: buf, exitCode: ioResult.exitCode }
}

describe('iconv', () => {
  it('utf-8 to latin-1', async () => {
    const vfs = new RAMVFS()
    const input = ENC.encode('caf\u00e9\n')
    const r = await runIconv(vfs, [], { f: 'utf-8', t: 'latin-1' }, input)
    expect(r.exitCode).toBe(0)
    const expected = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
    expect(Array.from(r.out)).toEqual(Array.from(expected))
  })
})

async function readOnlyShell(
  seed: string,
  line: string,
): Promise<[number, string, string, string[]]> {
  const vfs = new RAMVFS()
  const ws = new Workspace(
    { '/ro/': [vfs, MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const seeded = await ws.shell(seed)
    if (seeded.exitCode !== 0) throw new Error(DEC.decode(seeded.stderr))
    ws.setMountMode('/ro/', MountMode.READ)
    const before = [...vfs.store.files.keys()].sort()
    const r = await ws.shell(line)
    const after = [...vfs.store.files.keys()].sort()
    expect(after).toEqual(before)
    return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr), after]
  } finally {
    await ws.close()
  }
}

describe('iconv on a read-only mount', () => {
  const seed = "printf 'caf\\351\\n' > /ro/in.txt"

  it('converts to stdout, which writes nothing', async () => {
    expect(await readOnlyShell(seed, 'iconv -f latin1 -t utf-8 /ro/in.txt')).toEqual([
      0,
      'caf\u00e9\n',
      '',
      ['/in.txt'],
    ])
    const [exitCode, out] = await readOnlyShell(seed, 'cd /ro && iconv -f latin1 -t utf-8 < in.txt')
    expect([exitCode, out]).toEqual([0, 'caf\u00e9\n'])
  })

  it('refuses its output file at the write', async () => {
    const [exitCode, , stderr] = await readOnlyShell(
      seed,
      'iconv -f latin1 -t utf-8 -o /ro/out.txt /ro/in.txt',
    )
    expect([exitCode, stderr]).toEqual([1, 'iconv: /ro/out.txt: Read-only file system\n'])
  })
})
