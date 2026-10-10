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

import { commandIo } from '../../commands/builtin/generic_bind/adapter.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
const RAM_CUT = GENERIC_COMMANDS.filter((c) => c.name === 'cut' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runCut(
  stdin: Uint8Array | null,
  flags: Record<string, string | boolean | number | string[]>,
): Promise<string> {
  const vfs = new RAMVFS()
  const cmd = RAM_CUT[0]
  if (cmd === undefined) throw new Error('cut not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], [], {
    stdin,
    flags,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('cut', () => {
  it('-f with range', async () => {
    expect(await runCut(ENC.encode('a,b,c,d,e\n'), { delimiter: ',', fields: '2-4' })).toBe(
      'b,c,d\n',
    )
  })

  it('-w handles long whitespace runs', async () => {
    const whitespace = '\t'.repeat(50_000)
    expect(await runCut(ENC.encode(`a${whitespace}b\n`), { fields: '2', w: true })).toBe('b\n')
  })

  // One candidate, so ARGMATCH accepts any prefix of it. GNU cut has no
  // such option, so these are the general rule's answer rather than a
  // measured one, and the empty word is deliberately not pinned either way.
  // Mirrors test_cut.py.
  it.each(['trim', 't'])('--whitespace-delimited=%s resolves to trimmed', async (value) => {
    expect(
      await runCut(ENC.encode('  a   b c  \n'), {
        fields: '1,3',
        whitespace_delimited: value,
      }),
    ).toBe('a\tc\n')
  })

  it('no stdin reads empty input', async () => {
    const vfs = new RAMVFS()
    const cmd = RAM_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], [], {
      stdin: null,
      flags: { fields: '1' },
      io: commandIo(vfs),
      cwd: '/',
    })
    if (result === null) throw new Error('result null')
    const [out, ioResult] = result
    expect(ioResult.exitCode).toBe(0)
    expect(out === null ? 0 : (await materialize(out)).length).toBe(0)
  })
})
