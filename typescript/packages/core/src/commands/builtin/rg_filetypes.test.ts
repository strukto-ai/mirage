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
  DEFAULT_TYPES,
  FileTypes,
  INVALID_DEFINITION,
  addDefinition,
  typeListing,
} from './rg_filetypes.ts'
import { Verdict } from './rg_glob.ts'

describe('FileTypes', () => {
  it('keeps a selected type and drops the rest', () => {
    const types = new FileTypes([], [['py', false]])
    expect(types.verdict('a.py', false)).toBe(Verdict.WHITELIST)
    expect(types.verdict('a.pyi', false)).toBe(Verdict.WHITELIST)
    expect(types.verdict('a.txt', false)).toBe(Verdict.IGNORE)
  })

  it('drops only a negated type', () => {
    const types = new FileTypes([], [['txt', true]])
    expect(types.verdict('a.txt', false)).toBe(Verdict.IGNORE)
    expect(types.verdict('a.py', false)).toBe(Verdict.NONE)
  })

  it('lets the last matching selection decide', () => {
    // `-t py -T py` drops every .py file.
    const types = new FileTypes(
      [],
      [
        ['py', false],
        ['py', true],
      ],
    )
    expect(types.verdict('a.py', false)).toBe(Verdict.IGNORE)
  })

  it('never speaks for a directory', () => {
    expect(new FileTypes([], [['py', false]]).verdict('py', true)).toBe(Verdict.NONE)
  })

  it('refuses an unknown type', () => {
    expect(() => new FileTypes([], [['nosuch', false]])).toThrow(
      'rg: unrecognized file type: nosuch',
    )
  })

  it('selects every type for all', () => {
    const types = new FileTypes([], [['all', false]])
    expect(types.verdict('a.rs', false)).toBe(Verdict.WHITELIST)
    expect(types.verdict('noext', false)).toBe(Verdict.IGNORE)
  })

  it('extends with --type-add and copies with include', () => {
    const types = new FileTypes([['add', 'foo:*.md']], [['foo', false]])
    expect(types.verdict('c.md', false)).toBe(Verdict.WHITELIST)
    const included = new FileTypes([['add', 'foo:include:py,md']], [['foo', false]])
    expect(included.verdict('b.py', false)).toBe(Verdict.WHITELIST)
    expect(included.verdict('c.md', false)).toBe(Verdict.WHITELIST)
  })

  it('empties a type with --type-clear before it is selected', () => {
    expect(() => new FileTypes([['clear', 'py']], [['py', false]])).toThrow()
  })
})

describe('addDefinition', () => {
  it.each(['nocolon', 'foo:', ':*.x', 'all:*.x', 'a-b:*.x', 'foo:bad:py', 'foo:include:nosuch'])(
    "refuses %s in ripgrep's words",
    (definition) => {
      const defs = new Map(Object.entries(DEFAULT_TYPES).map(([name, g]) => [name, [...g]]))
      expect(() => {
        addDefinition(defs, definition)
      }).toThrow(INVALID_DEFINITION)
    },
  )
})

describe('typeListing', () => {
  it('sorts names and globs', () => {
    // ripgrep 14.1.1: `--type-add 'zz:*.zz' --type-add 'zz:*.yy'` lists
    // `zz: *.yy, *.zz`, and an added glob joins a built-in type.
    const types = new FileTypes(
      [
        ['add', 'zz:*.zz'],
        ['add', 'zz:*.yy'],
        ['add', 'py:*.zz'],
      ],
      [],
    )
    const listing = typeListing(types.definitions)
    expect(listing).toContain('zz: *.yy, *.zz')
    expect(listing).toContain('py: *.py, *.pyi, *.zz')
    expect(listing[0]).toBe('ada: *.adb, *.ads')
  })
})
