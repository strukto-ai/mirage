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

import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import { Session } from '../session/session.ts'
import { commandName, forkForCall, infrastructurePrefixes } from './utils.ts'

describe('commandName', () => {
  it.each([
    ['ls -la /tmp', 'ls'],
    ['  ls  ', 'ls'],
    ['', ''],
    ['   ', ''],
    ['\tcat\tfile', 'cat'],
  ])('reads the leading word of %j', (line, expected) => {
    expect(commandName(line)).toBe(expected)
  })
})

function makeSession(): Session {
  return new Session({ sessionId: 's1', cwd: '/home', env: { A: '1', B: '2' } })
}

describe('forkForCall', () => {
  it('reuses the persistent session when no overrides are given', () => {
    const session = makeSession()
    expect(forkForCall(session, undefined, undefined)).toBe(session)
  })

  it('forks on cwd without touching the original', () => {
    const session = makeSession()
    const forked = forkForCall(session, '/other', undefined)
    expect(forked).not.toBe(session)
    expect(forked.cwd).toBe('/other')
    expect(session.cwd).toBe('/home')
  })

  it('layers env overrides on top of the session env', () => {
    const session = makeSession()
    const forked = forkForCall(session, undefined, { B: '9', C: '3' })
    expect(forked.env).toEqual({ A: '1', B: '9', C: '3' })
    expect(session.env).toEqual({ A: '1', B: '2' })
  })
})

describe('infrastructurePrefixes', () => {
  it('excludes a user-defined root', () => {
    expect(infrastructurePrefixes(false)).toEqual(new Set(['/dev', HISTORY_PREFIX]))
  })

  it('includes the synthetic root anchor', () => {
    expect(infrastructurePrefixes(true)).toEqual(new Set(['/dev', HISTORY_PREFIX, '/']))
  })
})
