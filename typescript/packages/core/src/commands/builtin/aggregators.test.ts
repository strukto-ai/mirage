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
import { concatAggregate, headerAggregate, prefixAggregate } from './aggregators.ts'

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('aggregators', () => {
  it('concat joins bytes in order', () => {
    const out = concatAggregate([
      ['/a', encode('hello ')],
      ['/b', encode('world')],
    ])
    expect(decode(out)).toBe('hello world')
  })

  it('header returns bare data for single result', () => {
    const out = headerAggregate([['/a', encode('only\n')]])
    expect(decode(out)).toBe('only\n')
  })

  it('header adds ==> <== separators for multiple', () => {
    const out = headerAggregate([
      ['/a', encode('A\n')],
      ['/b', encode('B\n')],
    ])
    expect(decode(out)).toBe('==> /a <==\nA\n\n==> /b <==\nB\n')
  })

  it('prefix drops the prefix for single file', () => {
    const out = prefixAggregate([['/a', encode('alpha\nbeta\n')]])
    expect(decode(out)).toBe('alpha\nbeta\n')
  })

  it('prefix adds path:line for multiple', () => {
    const out = prefixAggregate([
      ['/a', encode('alpha\n')],
      ['/b', encode('beta\n')],
    ])
    expect(decode(out)).toBe('/a:alpha\n/b:beta\n')
  })

  it('prefix skips empty data', () => {
    const out = prefixAggregate([
      ['/a', encode('')],
      ['/b', encode('x\n')],
    ])
    expect(decode(out)).toBe('/b:x\n')
  })
})
