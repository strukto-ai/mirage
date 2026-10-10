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

const RAM_TR = GENERIC_COMMANDS.filter((c) => c.name === 'tr' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runTr(
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_TR[0]
  const vfs = new RAMVFS()
  if (cmd === undefined) throw new Error('tr not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin,
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

describe('tr', () => {
  it('pads set2 by default (no -t)', async () => {
    const r = await runTr(['abcde', 'xy'], {}, ENC.encode('abcde'))
    expect(r.out).toBe('xyyyy')
  })

  it('--complement long form', async () => {
    const r = await runTr(['0-9', '_'], { complement: true }, ENC.encode('abc123'))
    expect(r.out).toBe('___123')
  })

  it('-d without -s names the second operand as extra', async () => {
    const two = await runTr(['a', 'b'], { delete: true }, ENC.encode('x'))
    expect(two.exitCode).toBe(1)
    await expect(runTr(['a', 'b', 'c'])).rejects.toThrow("tr: extra operand 'c'")
  })
})
