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

import { VarAttr } from '../../shell/variable.ts'
import { Session } from './session.ts'
import { assignElement, elementIsSet } from './elements.ts'
import { seedVar, setAttr } from './state.ts'

function makeSession(): Session {
  const session = new Session({ sessionId: 's', cwd: '/' })
  seedVar(session, 'm', { a: '1', k5: '9', '0': 'z' })
  seedVar(session, 'arr', ['10', '20', '30'])
  seedVar(session, 's5', '5')
  seedVar(session, 'i', '1')
  return session
}

describe('elementIsSet', () => {
  it('answers key membership, index presence, and bare element 0', async () => {
    const session = makeSession()
    expect(await elementIsSet(session, 'm[a]')).toBe(true)
    expect(await elementIsSet(session, 'm[zz]')).toBe(false)
    // The subscript is the key verbatim, never arithmetic.
    expect(await elementIsSet(session, 'm[1+1]')).toBe(false)
    // A quoted subscript asks after the unquoted key, as bash does.
    expect(await elementIsSet(session, 'm["a"]')).toBe(true)
    expect(await elementIsSet(session, "m['a']")).toBe(true)
    expect(await elementIsSet(session, 'm[@]')).toBe(true)
    expect(await elementIsSet(session, 'arr[2]')).toBe(true)
    expect(await elementIsSet(session, 'arr[9]')).toBe(false)
    expect(await elementIsSet(session, 'arr[@]')).toBe(true)
    // An indexed subscript is arithmetic, and what it assigns lands.
    expect(await elementIsSet(session, 'arr[j=2]')).toBe(true)
    expect(session.vars.j?.value).toBe('2')
    // A bare name over an array checks element 0 (the literal key "0"
    // for an associative one).
    expect(await elementIsSet(session, 'm')).toBe(true)
    expect(await elementIsSet(session, 'arr')).toBe(true)
    expect(await elementIsSet(session, 's5')).toBe(true)
    expect(await elementIsSet(session, 'missing')).toBe(false)
    expect(await elementIsSet(session, 'not a ref')).toBe(false)
  })
})

describe('assignElement', () => {
  it('writes associative keys, appends, and refuses the empty key', async () => {
    const session = makeSession()
    expect(await assignElement(session, null, 'm', 'b', '2')).toBe('ok')
    expect(await assignElement(session, null, 'm', 'b', 'x', true)).toBe('ok')
    // A bare target over an associative array is the key "0".
    expect(await assignElement(session, null, 'm', null, 'top')).toBe('ok')
    expect(await assignElement(session, null, 'm', '', 'v')).toBe('subscript')
    expect(session.assocs.m?.b).toBe('2x')
    expect(session.assocs.m?.['0']).toBe('top')
  })

  it('writes indexed elements, migrates scalars, and reports statuses', async () => {
    const session = makeSession()
    setAttr(session, 'ro', VarAttr.Readonly)
    expect(await assignElement(session, null, 'arr', '1', 'X')).toBe('ok')
    expect(await assignElement(session, null, 'arr', '-1', 'Y')).toBe('ok')
    expect(await assignElement(session, null, 'arr', '-9', 'n')).toBe('subscript')
    // An existing scalar migrates to element 0 under a subscript.
    seedVar(session, 'sc', 'base')
    expect(await assignElement(session, null, 'sc', '1', 'one')).toBe('ok')
    expect(await assignElement(session, null, 'ro', '0', 'x')).toBe('readonly')
    expect(session.arrays.arr).toEqual(['10', 'X', 'Y'])
    expect(session.arrays.sc).toEqual(['base', 'one'])
  })
})
