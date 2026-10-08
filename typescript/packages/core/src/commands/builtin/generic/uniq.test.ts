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
  it.each([
    ['group', 'p'],
    ['all_repeated', 'n'],
  ])('accepts %s=%s', async (dest, value) => {
    const [stderr, code] = await stderrOf({ [dest]: value })
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
// interpolated raw. Rows measured against GNU coreutils 9.4 under
// `LC_ALL=C` with a raw `bytes` argv (`uniq --all-repeated=<w>`,
// `uniq --group=<w>`). Mirrors test_uniq.py.
describe.each([
  ['all_repeated', '--all-repeated'],
  ['group', '--group'],
])('uniq quotes the word its %s clause refuses', (dest, option) => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\\', 'x\\\\'],
  ])('escapes %j', async (value, escaped) => {
    const [stderr] = await stderrOf({ [dest]: value })
    expect(stderr.split('\n')[0]).toBe(`uniq: invalid argument '${escaped}' for '${option}'`)
  })
})

// Measured, coreutils 9.4: both refusals append gnulib's candidate list and
// the Try-help line, in GNU's own declaration order -- `--group` lists
// `prepend append separate both`, not the accepted-set order that starts at
// its `separate` default. Mirrors test_uniq.py.
describe('uniq argument refusals carry GNU candidate blocks', () => {
  it.each([
    ['all_repeated', '--all-repeated', ['none', 'prepend', 'separate']],
    ['group', '--group', ['prepend', 'append', 'separate', 'both']],
  ] as const)('lists the %s candidates', async (dest, option, candidates) => {
    const [stderr, code] = await stderrOf({ [dest]: 'x' })
    const listed = candidates.map((word) => `  - '${word}'\n`).join('')
    expect(stderr).toBe(
      `uniq: invalid argument 'x' for '${option}'\n` +
        `Valid arguments are:\n${listed}` +
        "Try 'uniq --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it('words an empty --group as ambiguous', async () => {
    const [stderr, code] = await stderrOf({ group: '' })
    expect(stderr.split('\n')[0]).toBe("uniq: ambiguous argument '' for '--group'")
    expect(code).toBe(1)
  })
})
