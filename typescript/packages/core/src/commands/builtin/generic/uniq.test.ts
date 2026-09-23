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

import type { CommandOpts } from '../../config.ts'
import { uniqGeneric } from './uniq.ts'

const DEC = new TextDecoder()

async function stderrOf(flags: CommandOpts['flags']): Promise<[string, number]> {
  const opts = {
    stdin: new TextEncoder().encode('a\na\nb\n'),
    flags,
    filetypeFns: null,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await uniqGeneric([], opts, () => {
    throw new Error('paths are empty; the source is stdin')
  })
  if (result === null) throw new Error('uniq returned no result')
  const io = result[1]
  // stderr is null on a run that was not refused, which the prefix cases
  // below are.
  return [DEC.decode((io.stderr ?? new Uint8Array()) as Uint8Array), io.exitCode]
}

// Neither option's candidates share a prefix that spans two values, so
// `uniq --group=p` and `--all-repeated=n` both exit 0 (measured, coreutils
// 9.4). Mirrors test_uniq.py.
describe('uniq accepts an unambiguous prefix', () => {
  it.each(['p', 'a', 'se', 'b'])('accepts --group=%s', async (value) => {
    const [stderr, code] = await stderrOf({ group: value })
    expect(stderr).toBe('')
    expect(code).toBe(0)
  })

  it.each(['n', 'p', 'se'])('accepts --all-repeated=%s', async (value) => {
    const [stderr, code] = await stderrOf({ all_repeated: value })
    expect(stderr).toBe('')
    expect(code).toBe(0)
  })

  it('still refuses an unmatched word', async () => {
    const [stderr] = await stderrOf({ group: 'pp' })
    expect(stderr.split('\n')[0]).toBe("uniq: invalid argument 'pp' for '--group'")
  })
})

// Both of uniq's ARGMATCH refusals name the refused word through gnulib's
// quote(), so a byte outside 0x20-0x7e comes back escaped rather than
// interpolated raw. Every row measured against GNU coreutils 9.4 under
// `LC_ALL=C` with a raw `bytes` argv (`uniq --all-repeated=<w>`,
// `uniq --group=<w>`). Mirrors test_uniq.py.
const QUOTED_WORDS: [string, string][] = [
  ['xé', 'x\\303\\251'],
  ['x\r', 'x\\r'],
  ['x\x01', 'x\\001'],
  ['x\x7f', 'x\\177'],
  ["x'", "x\\'"],
  ['x\\', 'x\\\\'],
]

describe('uniq quotes the word its argument clauses refuse', () => {
  it.each(QUOTED_WORDS)('escapes %j in the --all-repeated clause', async (value, escaped) => {
    const [stderr] = await stderrOf({ all_repeated: value })
    expect(stderr.split('\n')[0]).toBe(`uniq: invalid argument '${escaped}' for '--all-repeated'`)
  })

  it.each(QUOTED_WORDS)('escapes %j in the --group clause', async (value, escaped) => {
    const [stderr] = await stderrOf({ group: value })
    expect(stderr.split('\n')[0]).toBe(`uniq: invalid argument '${escaped}' for '--group'`)
  })
})

// Measured, coreutils 9.4: both refusals append gnulib's candidate list and
// the Try-help line, in GNU's own declaration order -- `--group` lists
// `prepend append separate both`, not the accepted-set order that starts at
// its `separate` default. Mirrors test_uniq.py.
describe('uniq argument refusals carry GNU candidate blocks', () => {
  it('lists --all-repeated candidates', async () => {
    const [stderr, code] = await stderrOf({ all_repeated: 'x' })
    expect(stderr).toBe(
      "uniq: invalid argument 'x' for '--all-repeated'\n" +
        "Valid arguments are:\n  - 'none'\n  - 'prepend'\n  - 'separate'\n" +
        "Try 'uniq --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it('lists --group candidates', async () => {
    const [stderr, code] = await stderrOf({ group: 'x' })
    expect(stderr).toBe(
      "uniq: invalid argument 'x' for '--group'\n" +
        "Valid arguments are:\n  - 'prepend'\n  - 'append'\n  - 'separate'\n  - 'both'\n" +
        "Try 'uniq --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it.each([
    ['all_repeated', '--all-repeated'],
    ['group', '--group'],
  ])('words an empty %s as ambiguous', async (dest, option) => {
    const [stderr, code] = await stderrOf({ [dest]: '' })
    expect(stderr.split('\n')[0]).toBe(`uniq: ambiguous argument '' for '${option}'`)
    expect(code).toBe(1)
  })
})
