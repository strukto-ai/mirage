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

import { expect, it, vi } from 'vitest'

import { materialize } from '../../io/types.ts'
import { UsageError } from '../errors.ts'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import type { FlagValue } from '../spec/types.ts'
import { parseFlags } from './generic/rg.ts'
import type { RgFlags, Tally } from './rg_search.ts'
import { openRg, requiredTerms, streamHaystack, type SearchHints } from './rg_stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function flagsOf(flags: Record<string, FlagValue>): RgFlags {
  return parseFlags(new FlagView(flags, specOf('rg')))
}

it.each<{
  pattern: string
  flags: Record<string, FlagValue>
  want: SearchHints | null
}>([
  {
    pattern: 'needle',
    flags: {},
    want: { texts: ['needle'], whole_word: false, ignore_case: false },
  },
  {
    pattern: 'needle',
    flags: { word_regexp: true },
    want: { texts: ['needle'], whole_word: true, ignore_case: false },
  },
  { pattern: 'n.*e', flags: {}, want: null },
])(
  'compiled terms describe safe backend candidates for $pattern ($flags)',
  async ({ pattern, flags, want }) => {
    const program = await openRg(pattern, false, flagsOf(flags))
    try {
      expect(requiredTerms(program)).toEqual(want)
    } finally {
      program.stream.close()
    }
  },
)

it('reports an invalid native pattern as a usage error', async () => {
  await expect(openRg('(', false, flagsOf({}))).rejects.toBeInstanceOf(UsageError)
})

it('preserves byte offsets across chunks and settles counts', async () => {
  const data = ENC.encode('x'.repeat(65535) + 'é needle\nneedle\n')
  const f = flagsOf({
    only_matching: true,
    byte_offset: true,
    line_number: true,
    text: true,
    stats: true,
  })
  const program = await openRg('needle', false, f)
  const tally: Tally = { selected: false }
  async function* source(): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(data.subarray(0, 65536))
    yield await Promise.resolve(data.subarray(65536))
  }
  try {
    const output = await materialize(
      streamHaystack(source(), program, f, 'f', null, tally, undefined, true, false),
    )
    expect(DEC.decode(output)).toBe('1:65538:needle\n2:65545:needle\n')
    expect(tally).toEqual({
      selected: true,
      binary: false,
      skipped: false,
      matches: 2,
      matchedLines: 2,
      searched: data.byteLength,
      nul: null,
    })
  } finally {
    program.stream.close()
  }
})

it('closes a quiet match source without reading the next chunk', async () => {
  const f = flagsOf({ quiet: true, text: true })
  const program = await openRg('needle', false, f)
  const tally: Tally = { selected: false }
  let closed = false
  let reads = 0
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      reads += 1
      yield await Promise.resolve(ENC.encode('needle\n'))
      reads += 1
      throw new Error('read beyond the selected record')
    } finally {
      closed = true
    }
  }
  try {
    const output = await materialize(
      streamHaystack(source(), program, f, 'f', null, tally, undefined, true, false),
    )
    expect(output.byteLength).toBe(0)
    expect(tally.selected).toBe(true)
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  } finally {
    program.stream.close()
  }
})

it.each([false, true])('searches without retaining unused captures (quiet=%s)', async (quiet) => {
  const f = flagsOf({ line_regexp: true, quiet, text: true })
  const program = await openRg('(a)'.repeat(10000), false, f)
  const tally: Tally = { selected: false }
  const data = ENC.encode('a'.repeat(10000) + '\n')
  async function* source(): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(data)
  }
  try {
    const output = await materialize(
      streamHaystack(source(), program, f, 'f', null, tally, undefined, true, false),
    )
    expect(output).toEqual(quiet ? new Uint8Array() : data)
    expect(tally.selected).toBe(true)
  } finally {
    program.stream.close()
  }
})

it('reports a capture memory refusal as a usage error', async () => {
  const opening = openRg('(a)'.repeat(10000), false, flagsOf({ replace: '$1' }))
  await expect(opening).rejects.toBeInstanceOf(UsageError)
  await expect(opening).rejects.toThrow(/working memory/)
})

it('settles final counts without repeated metadata during empty progress', async () => {
  const f = flagsOf({ text: true, stats: true })
  const program = await openRg('needle', false, f)
  const tally: Tally = { selected: false }
  const metadata = vi.spyOn(program.stream, 'metadata')
  const data = ENC.encode('event=42 status=ok\n'.repeat(10000))
  async function* source(): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(data)
  }
  try {
    const output = await materialize(
      streamHaystack(source(), program, f, 'f', null, tally, undefined, true, false),
    )
    expect(output.byteLength).toBe(0)
    expect(tally).toEqual({
      selected: false,
      binary: false,
      skipped: false,
      matches: 0,
      matchedLines: 0,
      searched: data.byteLength,
      nul: null,
    })
    expect(metadata).toHaveBeenCalledTimes(1)
  } finally {
    metadata.mockRestore()
    program.stream.close()
  }
})

it('keeps the current tally when the consumer closes after visible output', async () => {
  const f = flagsOf({ text: true, stats: true })
  const program = await openRg('needle', false, f)
  const tally: Tally = { selected: false }
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      yield await Promise.resolve(ENC.encode('needle\n' + 'x'.repeat(64000) + '\n'))
      throw new Error("read beyond the consumer's selected record")
    } finally {
      closed = true
    }
  }
  const output = streamHaystack(source(), program, f, 'f', null, tally, undefined, true, false)
  try {
    const first = await output.next()
    if (first.done === true) throw new Error('search ended before its selected record')
    expect(DEC.decode(first.value)).toBe('needle\n')
    expect(tally.selected).toBe(true)
    expect(tally.matches).toBe(1)
    await output.return(undefined)
    expect(closed).toBe(true)
    expect(tally.selected).toBe(true)
    expect(tally.matchedLines).toBe(1)
  } finally {
    await output.return(undefined)
    program.stream.close()
  }
})
