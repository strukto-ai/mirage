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

import { parseFlags } from './wc.ts'

// GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
// so a byte outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a
// raw `bytes` argv (`wc --total=<w>`). Mirrors test_wc.py.
describe('wc quotes the word --total refuses', () => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['x\x01', 'x\\001'],
    ['x\x7f', 'x\\177'],
    ["x'", "x\\'"],
    ['x\\', 'x\\\\'],
  ])('escapes %j in the --total clause', (value, escaped) => {
    const message = parseFlags({ total: value })
    expect(typeof message === 'string' ? message.split('\n')[0] : message).toBe(
      `wc: invalid argument '${escaped}' for '--total'`,
    )
  })
})

// Measured, coreutils 9.4: `wc --total=x f` lists all four modes and adds
// the Try-help line. `--total=` is NOT the default -- GNU reads the empty
// word as a prefix of every candidate and answers `ambiguous argument ''`,
// which python used to take as `auto` and exit 0. Mirrors test_wc.py.
describe('wc --total refusal carries GNU candidate block', () => {
  it('lists the candidates', () => {
    expect(parseFlags({ total: 'x' })).toBe(
      "wc: invalid argument 'x' for '--total'\n" +
        "Valid arguments are:\n  - 'auto'\n  - 'always'\n  - 'only'\n  - 'never'\n" +
        "Try 'wc --help' for more information.\n",
    )
  })

  it('words an empty value as ambiguous', () => {
    const message = parseFlags({ total: '' })
    expect(typeof message === 'string' ? message.split('\n')[0] : message).toBe(
      "wc: ambiguous argument '' for '--total'",
    )
  })

  it('still defaults an absent --total to auto', () => {
    const parsed = parseFlags({})
    expect(typeof parsed === 'string' ? parsed : parsed.total).toBe('auto')
  })
})
