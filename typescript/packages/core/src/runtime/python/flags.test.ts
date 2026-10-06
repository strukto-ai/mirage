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
import { initArgv, unhonoredNotice } from './flags.ts'

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// Mirrors Python's tests/runtime/python/test_flags.py.
describe('initArgv', () => {
  it('asks for nothing on an empty bag', () => {
    expect(initArgv({})).toEqual([])
  })

  it("hands a bool switch back in CPython's own spelling", () => {
    expect(initArgv({ B: true, E: false, P: true })).toEqual(['-B', '-P'])
  })

  it('repeats a count switch, because CPython counts occurrences', () => {
    // CPython reads `-O -O` exactly as `-OO`; the same is true of -b.
    expect(initArgv({ O: 2, b: 1 })).toEqual(['-O', '-O', '-b'])
  })

  it('repeats a list switch per value', () => {
    expect(initArgv({ W: ['ignore', 'error::UserWarning'] })).toEqual([
      '-W',
      'ignore',
      '-W',
      'error::UserWarning',
    ])
  })

  it('hands the long switch back as two words', () => {
    // CPython parses --check-hash-based-pycs by hand and rejects the
    // --opt=value spelling, so it can only be handed back detached.
    expect(initArgv({ check_hash_based_pycs: 'never' })).toEqual([
      '--check-hash-based-pycs',
      'never',
    ])
  })

  it('keeps the order bools, counts, lists, then the long switch', () => {
    expect(
      initArgv({ check_hash_based_pycs: 'always', X: ['dev'], O: 1, S: true, B: true }),
    ).toEqual(['-B', '-S', '-O', '-X', 'dev', '--check-hash-based-pycs', 'always'])
  })
})

describe('unhonoredNotice', () => {
  it('names the runtime once per switch present', () => {
    expect(text(unhonoredNotice({ E: true, s: true }, 'pyodide'))).toBe(
      "python3: warning: -E is ignored by the 'pyodide' runtime\n" +
        "python3: warning: -s is ignored by the 'pyodide' runtime\n",
    )
  })

  it('says nothing when the line carried no switch', () => {
    expect(unhonoredNotice({}, 'pyodide').length).toBe(0)
  })

  it('says nothing about a switch the engine honors', () => {
    expect(unhonoredNotice({ B: true, O: 2, E: true }, 'pyodide', ['B', 'O'])).toEqual(
      unhonoredNotice({ E: true }, 'pyodide'),
    )
  })

  it('reports an optimize level above one', () => {
    // -OO is level 2; reporting only level 1 would have made the
    // stricter spelling the quiet one.
    expect(text(unhonoredNotice({ O: 2 }, 'monty'))).toContain('-O is ignored')
  })

  it('reports the long switch by its own spelling', () => {
    expect(text(unhonoredNotice({ check_hash_based_pycs: 'never' }, 'monty'))).toContain(
      '--check-hash-based-pycs is ignored',
    )
  })

  it('says nothing about an absent switch', () => {
    expect(unhonoredNotice({ B: false, O: 0, W: [] }, 'monty').length).toBe(0)
  })

  // Populating sys._xoptions is all a warm interpreter can do for -X dev,
  // whose real effect is read out of the read-only sys.flags, so a known
  // name is reported (without its value). An arbitrary name does nothing
  // on CPython either, and an engine that acts on the name says nothing.
  it.each<[string, string[], string]>([
    ['dev', ['X'], "python3: warning: -X dev is ignored by the 'pyodide' runtime\n"],
    [
      'tracemalloc=5',
      ['X'],
      "python3: warning: -X tracemalloc is ignored by the 'pyodide' runtime\n",
    ],
    ['nosuchopt', ['X'], ''],
    ['dev', ['X', 'X:dev'], ''],
  ])('-X %s with %j honored warns %j', (value, honored, notice) => {
    expect(text(unhonoredNotice({ X: [value] }, 'pyodide', honored))).toBe(notice)
  })
})
