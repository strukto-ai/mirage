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
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await numfmtGeneric([value], opts)
  return DEC.decode(result?.[0] as Uint8Array).replace(/\n$/, '')
}

describe('numfmt --to=none rendering', () => {
  // This used to render through String(double), which printed '1e+24'.
  it.each([
    ['1Y', 'si', '1000000000000000000000000'],
    ['1Q', 'si', '1000000000000000000000000000000'],
    ['1Y', 'iec', '1208925819614629174706176'],
    ['1Q', 'iec', '1267650600228229401496703205376'],
    ['1.5Y', 'si', '1500000000000000000000000'],
    ['1.5Y', 'iec', '1813388729421943762059264'],
    ['12345678901234567890123456789', 'none', '12345678901234567890123456789'],
  ])('prints every digit of %s in %s', async (value, from, expected) => {
    expect(await run(value, { from })).toBe(expected)
  })

  // GNU echoes an unscaled value at the precision it was typed with.
  // Deliberate divergence: GNU reads through a long double, so '1.10' comes
  // back as '1.11' while '1.20' and '1.30' do not.
  it.each([
    ['1', '1'],
    ['1.000', '1.000'],
    ['1.100', '1.100'],
    ['1.20', '1.20'],
    ['0.10', '0.10'],
    ['00012', '12'],
    ['-1', '-1'],
  ])('keeps the precision %s was given', async (value, expected) => {
    expect(await run(value)).toBe(expected)
  })

  it.each([
    ['1.5K', '1500'],
    ['1.500K', '1500'],
    ['.5K', '500'],
    ['1.0005K', '1001'],
    ['1.0000005K', '1001'],
    ['0.0015K', '2'],
    ['1.23456789K', '1235'],
    ['-1.5K', '-1500'],
    ['-0.0015K', '-2'],
  ])('rounds the scaled %s away from zero to a whole number', async (value, expected) => {
    expect(await run(value, { from: 'si' })).toBe(expected)
  })
})

describe('numfmt --from suffixes', () => {
  it.each([
    ['1K', 'si', '1000'],
    ['1k', 'si', '1000'],
    ['1K', 'iec', '1024'],
    ['1k', 'iec', '1024'],
    ['1Ki', 'iec-i', '1024'],
    ['1K', 'auto', '1000'],
    ['1Ki', 'auto', '1024'],
    ['1ki', 'auto', '1024'],
    ['1M', 'auto', '1000000'],
    ['1Mi', 'auto', '1048576'],
  ])('reads %s under --from=%s', async (value, from, expected) => {
    expect(await run(value, { from })).toBe(expected)
  })

  // '1KiB' used to read as a kilobyte: the suffix went through
  // .replace(/i?B$/, '').replace(/i$/, '') before the unit lookup.
  it.each([
    ['1KiB', 'iec', "numfmt: invalid suffix in input '1KiB': 'iB'"],
    ['1Ki', 'iec', "numfmt: invalid suffix in input '1Ki': 'i'"],
    ['1KB', 'iec', "numfmt: invalid suffix in input '1KB': 'B'"],
    ['1kB', 'si', "numfmt: invalid suffix in input '1kB': 'B'"],
    ['1KiB', 'auto', "numfmt: invalid suffix in input '1KiB': 'B'"],
    ['1kI', 'auto', "numfmt: invalid suffix in input '1kI': 'I'"],
    ['1KiB', 'iec-i', "numfmt: invalid suffix in input '1KiB': 'B'"],
    ['1Z9', 'si', "numfmt: invalid suffix in input '1Z9': '9'"],
    ['1Kx', 'si', "numfmt: invalid suffix in input '1Kx': 'x'"],
    ['1KK', 'si', "numfmt: invalid suffix in input '1KK': 'K'"],
  ])('names the junk after the unit in %s', async (value, from, message) => {
    await expect(run(value, { from })).rejects.toThrow(new UsageError(message, 2))
  })

  // Only kilo has a lowercase spelling, so '1m' and '1g' are not units;
  // both languages used to upper-case the suffix and accept them.
  it.each([
    ['1m', 'si', "numfmt: invalid suffix in input: '1m'"],
    ['1g', 'si', "numfmt: invalid suffix in input: '1g'"],
    ['1J', 'si', "numfmt: invalid suffix in input: '1J'"],
    ['1i', 'auto', "numfmt: invalid suffix in input: '1i'"],
    ['1i', 'iec-i', "numfmt: invalid suffix in input: '1i'"],
    ['1e3', 'none', "numfmt: invalid suffix in input: '1e3'"],
    ['0x10', 'none', "numfmt: invalid suffix in input: '0x10'"],
    ['1.5.5', 'si', "numfmt: invalid suffix in input: '1.5.5'"],
  ])('quotes only the field for the unusable %s', async (value, from, message) => {
    await expect(run(value, { from })).rejects.toThrow(new UsageError(message, 2))
  })

  it('demands the i under --from=iec-i', async () => {
    await expect(run('1K', { from: 'iec-i' })).rejects.toThrow(
      new UsageError("numfmt: missing 'i' suffix in input: '1K' (e.g Ki/Mi/Gi)", 2),
    )
  })

  it.each([['1K'], ['1k'], ['1Ki'], ['1KiB'], ['1Kx'], ['1.5K']])(
    'points %s at --from when none was given',
    async (value) => {
      await expect(run(value)).rejects.toThrow(
        new UsageError(`numfmt: rejecting suffix in input: '${value}' (consider using --from)`, 2),
      )
    },
  )

  // GNU reads no leading '+', no bare trailing '.' and no exponent.
  it.each([
    ['abc', 'si'],
    ['abc', 'none'],
    ['+1', 'si'],
    ['1.', 'none'],
    ['1.x', 'si'],
  ])('reports %s as an invalid number', async (value, from) => {
    await expect(run(value, { from })).rejects.toThrow(
      new UsageError(`numfmt: invalid number: '${value}'`, 2),
    )
  })
})
