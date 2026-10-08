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
import { UsageError } from '../../errors.ts'
import { numfmtGeneric } from './numfmt.ts'

const DEC = new TextDecoder()

async function run(value: string, flags: CommandOpts['flags'] = {}): Promise<string> {
  const opts = {
    stdin: null,
    flags,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await numfmtGeneric([value], opts)
  const io = result?.[1]
  if (io !== undefined && io.exitCode !== 0) {
    throw new UsageError((await io.stderrStr()).replace(/\n$/, ''), io.exitCode)
  }
  return DEC.decode(result?.[0] as Uint8Array).replace(/\n$/, '')
}

describe('numfmt --to=none rendering', () => {
  // This used to render through String(double), which printed '1e+24'.
  it.each([
    ['1Y', 'si', '1000000000000000000000000'],
    ['1Q', 'iec', '1267650600228229401496703205376'],
  ])('prints every digit of %s in %s', async (value, from, expected) => {
    expect(await run(value, { from })).toBe(expected)
  })

  // GNU echoes an unscaled value at the precision it was typed with.
  // Deliberate divergence: GNU reads through a long double, so '1.10' comes
  // back as '1.11' while '1.20' and '1.30' do not.
  it.each([
    ['1.20', '1.20'],
    ['00012', '12'],
  ])('keeps the precision %s was given', async (value, expected) => {
    expect(await run(value)).toBe(expected)
  })

  it.each([
    ['1.0005K', '1001'],
    ['-0.0015K', '-2'],
  ])('rounds the scaled %s away from zero to a whole number', async (value, expected) => {
    expect(await run(value, { from: 'si' })).toBe(expected)
  })
})

describe('numfmt --from suffixes', () => {
  it.each([
    ['1k', 'iec', '1024'],
    ['1ki', 'auto', '1024'],
  ])('reads %s under --from=%s', async (value, from, expected) => {
    expect(await run(value, { from })).toBe(expected)
  })

  // '1KiB' used to read as a kilobyte: the suffix went through
  // .replace(/i?B$/, '').replace(/i$/, '') before the unit lookup.
  it.each([
    ['1KiB', 'iec', "numfmt: invalid suffix in input '1KiB': 'iB'"],
    ['1KiB', 'auto', "numfmt: invalid suffix in input '1KiB': 'B'"],
  ])('names the junk after the unit in %s', async (value, from, message) => {
    await expect(run(value, { from })).rejects.toThrow(new UsageError(message, 2))
  })

  // Only kilo has a lowercase spelling, so '1m' and '1g' are not units;
  // both languages used to upper-case the suffix and accept them.
  it.each([
    ['1m', 'si', "numfmt: invalid suffix in input: '1m'"],
    ['1e3', 'none', "numfmt: invalid suffix in input: '1e3'"],
  ])('quotes only the field for the unusable %s', async (value, from, message) => {
    await expect(run(value, { from })).rejects.toThrow(new UsageError(message, 2))
  })

  // The clause answers for every field whose unit letter is not followed by
  // an 'i'; mirage used to call `1Kx` and `1Ké` invalid suffixes. A field
  // with no unit at all is read as it stands (coreutils 9.7). Mirrored in
  // test_numfmt.py.
  it.each([
    ['1K', '1K'],
    ['1Ké', '1K\\303\\251'],
  ])('demands the i under --from=iec-i for %j', async (value, named) => {
    expect(await run('1.5', { from: 'iec-i' })).toBe('1.5')
    await expect(run(value, { from: 'iec-i' })).rejects.toThrow(
      new UsageError(`numfmt: missing 'i' suffix in input: '${named}' (e.g Ki/Mi/Gi)`, 2),
    )
  })

  // The other side of that branch: once the 'i' is consumed the field
  // reports its remainder like any other mode, and a first character that
  // is not a unit letter never reaches the 'i' test at all.
  it.each([
    ['1Kii', "numfmt: invalid suffix in input '1Kii': 'i'"],
    ['1iK', "numfmt: invalid suffix in input: '1iK'"],
  ])('names the leftover past the i for %j', async (value, message) => {
    await expect(run(value, { from: 'iec-i' })).rejects.toThrow(new UsageError(message, 2))
  })

  // The clause is an INPUT one: --to=iec-i renders a bare number happily,
  // so the demand above must not leak onto the output mode.
  it.each([
    ['1000', '1000'],
    ['1024', '1.0Ki'],
  ])('renders %s under --to=iec-i with no missing-i clause', async (value, expected) => {
    expect(await run(value, { to: 'iec-i' })).toBe(expected)
  })

  it.each([['1k'], ['1KiB']])('points %s at --from when none was given', async (value) => {
    await expect(run(value)).rejects.toThrow(
      new UsageError(`numfmt: rejecting suffix in input: '${value}' (consider using --from)`, 2),
    )
  })

  // GNU reads no leading '+', no bare trailing '.' and no exponent.
  it.each([
    ['+1', 'si'],
    ['1.', 'none'],
  ])('reports %s as an invalid number', async (value, from) => {
    await expect(run(value, { from })).rejects.toThrow(
      new UsageError(`numfmt: invalid number: '${value}'`, 2),
    )
  })
})

// Every numfmt clause that names a field names it through gnulib's quote(),
// so a byte outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Rows measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
// `bytes` argv. Mirrors test_numfmt.py.
const QUOTED_CLAUSES: [string, string, string][] = [
  ['1{0}', 'si', "numfmt: invalid suffix in input: '1{0}'"],
  ['1K{0}', 'si', "numfmt: invalid suffix in input '1K{0}': '{0}'"],
  ['x{0}', 'none', "numfmt: invalid number: 'x{0}'"],
  ['1K{0}', 'none', "numfmt: rejecting suffix in input: '1K{0}' (consider using --from)"],
]

describe.each([
  ['é', '\\303\\251'],
  ['\\', '\\\\'],
])('numfmt quotes the field it names (%j)', (tail, esc) => {
  it.each(QUOTED_CLAUSES)('escapes it in %s under --from=%s', async (field, from, message) => {
    await expect(run(field.replaceAll('{0}', tail), { from })).rejects.toThrow(
      new UsageError(message.replaceAll('{0}', esc), 2),
    )
  })
})
