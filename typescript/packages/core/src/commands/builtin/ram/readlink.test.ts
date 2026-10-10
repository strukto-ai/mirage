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
import { GENERIC_COMMANDS } from '../generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_READLINK = GENERIC_COMMANDS.filter((c) => c.name === 'readlink' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runReadlink(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_READLINK[0]
  if (cmd === undefined) throw new Error('readlink not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
    flags,
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

describe('readlink', () => {
  it('-f prints the normalized path', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('x'))
    const r = await runReadlink(vfs, [PathSpec.fromStrPath('/f.txt')], { canonicalize: true })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('/f.txt')
  })

  it('missing operand is a usage error', async () => {
    const vfs = new RAMVFS()
    await expect(runReadlink(vfs, [], {})).rejects.toThrow('readlink: missing operand')
  })

  it('-n omits trailing newline', async () => {
    const vfs = new RAMVFS()
    const r = await runReadlink(vfs, [PathSpec.fromStrPath('/f.txt')], { no_newline: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.endsWith('\n')).toBe(false)
  })

  it('without -n includes trailing newline', async () => {
    const vfs = new RAMVFS()
    const r = await runReadlink(vfs, [PathSpec.fromStrPath('/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.out.endsWith('\n')).toBe(true)
  })
})
