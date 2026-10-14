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

import { describe, expect, it } from 'vitest'

import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { tacGeneric } from './tac.ts'

const ENC = new TextEncoder()

function streamOf(data: Uint8Array): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return async function* () {
    await Promise.resolve()
    yield data
  }
}

function opts(flags: Record<string, unknown>, stdin: Uint8Array | null = null): CommandOpts {
  return { flags, stdin } as unknown as CommandOpts
}

describe('tac records', () => {
  // Mirrors python's test_tac_keeps_bytes_and_puts_b_before_the_record.
  it.each([
    [ENC.encode('a|b|c|'), true, ENC.encode('||c|ba')],
    [ENC.encode('a|b|c|'), false, ENC.encode('c|b|a|')],
    [
      Uint8Array.of(0xff, 0xfe, 0x7c, 0x80, 0x7c),
      false,
      Uint8Array.of(0x80, 0x7c, 0xff, 0xfe, 0x7c),
    ],
  ])('%#', async (data, before, expected) => {
    const flags = before ? { before: true, separator: '|' } : { separator: '|' }
    const [out] = await tacGeneric([], opts(flags, data), streamOf(new Uint8Array()))
    expect(await materialize(out)).toEqual(expected)
  })
})

describe('tac failures and separators', () => {
  // Mirrors python's test_a_file_that_fails_to_read_is_reported_and_tac_goes_on.
  it('reports a file that fails to read and goes on', async () => {
    const stream = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      if (p.virtual === '/bad') throw Object.assign(new Error('/bad'), { code: 'EACCES' })
      yield ENC.encode('a\nb\n')
    }
    const [out, io] = await tacGeneric(
      [PathSpec.fromStrPath('/bad'), PathSpec.fromStrPath('/good')],
      opts({}),
      stream,
    )
    expect(new TextDecoder().decode(await materialize(out))).toBe('b\na\n')
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toContain('/bad')
  })

  // Mirrors python's test_an_empty_separator_is_nul.
  it('reads an empty separator as NUL', async () => {
    const data = Uint8Array.of(0x61, 0x00, 0x62, 0x00)
    const [out] = await tacGeneric([], opts({ separator: '' }, data), streamOf(new Uint8Array()))
    expect(await materialize(out)).toEqual(Uint8Array.of(0x62, 0x00, 0x61, 0x00))
  })

  // Mirrors python's test_a_raw_byte_separator_splits_on_that_byte.
  it('splits on a raw byte separator', async () => {
    const data = Uint8Array.of(0x61, 0x80, 0x62, 0x80)
    const [out] = await tacGeneric(
      [],
      opts({ separator: '\udc80' }, data),
      streamOf(new Uint8Array()),
    )
    expect(await materialize(out)).toEqual(Uint8Array.of(0x62, 0x80, 0x61, 0x80))
  })
})
