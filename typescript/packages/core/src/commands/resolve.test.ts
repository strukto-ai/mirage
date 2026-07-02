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
import {
  COMPOUND_EXTENSIONS,
  getExtension,
  materializeStdout,
  stripPrefixFromPathKwargs,
} from './resolve.ts'
import { CommandSpec, OperandKind, Option } from './spec/types.ts'

describe('getExtension', () => {
  it('returns the dotted extension for simple paths', () => {
    expect(getExtension('/a/b.txt')).toBe('.txt')
    expect(getExtension('file.json')).toBe('.json')
  })

  it('returns null when there is no extension', () => {
    expect(getExtension('/a/b')).toBeNull()
  })

  it('returns null when dot is in a parent segment only', () => {
    expect(getExtension('/a.b/c')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(getExtension(null)).toBeNull()
  })

  it('recognizes compound extensions from COMPOUND_EXTENSIONS', () => {
    expect(getExtension('/docs/foo.gdoc.json')).toBe('.gdoc.json')
    expect(getExtension('/s/bar.gsheet.json')).toBe('.gsheet.json')
  })

  it('COMPOUND_EXTENSIONS contains the known google-doc extensions', () => {
    expect(COMPOUND_EXTENSIONS.has('.gdoc.json')).toBe(true)
    expect(COMPOUND_EXTENSIONS.has('.gsheet.json')).toBe(true)
  })
})

describe('materializeStdout', () => {
  it('returns empty bytes for null', async () => {
    expect(await materializeStdout(null)).toEqual(new Uint8Array())
  })

  it('passes through a Uint8Array', async () => {
    const b = new TextEncoder().encode('hi')
    expect(await materializeStdout(b)).toBe(b)
  })
})

describe('stripPrefixFromPathKwargs', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-o', valueKind: OperandKind.PATH })],
  })

  it('strips a matching prefix from PATH-kind flag values', () => {
    const result = stripPrefixFromPathKwargs({ o: '/ram/out.txt' }, spec, '/ram')
    expect(result.o).toBe('/out.txt')
  })

  it('leaves non-matching prefixes alone', () => {
    const result = stripPrefixFromPathKwargs({ o: '/disk/x' }, spec, '/ram')
    expect(result.o).toBe('/disk/x')
  })

  it('is a no-op when prefix is empty', () => {
    const kwargs = { o: '/ram/x' }
    expect(stripPrefixFromPathKwargs(kwargs, spec, '')).toEqual(kwargs)
  })
})
