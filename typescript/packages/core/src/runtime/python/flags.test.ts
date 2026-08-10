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
import { unhonoredNotice } from './flags.ts'

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

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
})
