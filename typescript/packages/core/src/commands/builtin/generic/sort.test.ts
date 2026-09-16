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
import { sortGeneric } from './sort.ts'

const DEC = new TextDecoder()

async function stderrOf(flags: CommandOpts['flags']): Promise<[string, number]> {
  const opts = {
    stdin: new TextEncoder().encode('b\na\n'),
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await sortGeneric([], opts, () => {
    throw new Error('paths are empty; the source is stdin')
  })
  if (result === null) throw new Error('sort returned no result')
  const io = result[1]
  return [DEC.decode(io.stderr as Uint8Array), io.exitCode]
}

// GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
// so a byte outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a
// raw `bytes` argv (`sort --check=<w>`). Mirrors test_sort.py.
describe('sort quotes the word --check refuses', () => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['x\x01', 'x\\001'],
    ['x\x7f', 'x\\177'],
    ["x'", "x\\'"],
    ['x\\', 'x\\\\'],
  ])('escapes %j in the --check clause', async (value, escaped) => {
    const [stderr] = await stderrOf({ check: value })
    expect(stderr.split('\n')[0]).toBe(`sort: invalid argument '${escaped}' for '--check'`)
  })
})

// Measured, coreutils 9.4: `sort --check=x f` is SIX lines and exit 1.
// `quiet` and `silent` are aliases of one value, so gnulib's
// `argmatch_valid` puts them on one row; the exit is 1, not sort's usual
// usage code of 2, because `argmatch_die` always calls
// `usage (EXIT_FAILURE)`. Mirrors test_sort.py.
describe('sort --check refusal carries GNU candidate block', () => {
  it('lists the candidates and exits 1', async () => {
    const [stderr, code] = await stderrOf({ check: 'x' })
    expect(stderr).toBe(
      "sort: invalid argument 'x' for '--check'\n" +
        "Valid arguments are:\n  - 'quiet', 'silent'\n  - 'diagnose-first'\n" +
        "Try 'sort --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it('words an empty value as ambiguous', async () => {
    const [stderr, code] = await stderrOf({ check: '' })
    expect(stderr.split('\n')[0]).toBe("sort: ambiguous argument '' for '--check'")
    expect(code).toBe(1)
  })
})
