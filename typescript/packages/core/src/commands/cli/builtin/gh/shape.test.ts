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
import { ZERO_TIME, exported, listOf, orNull, pointer, struct } from './shape.ts'

describe('gh export shapes', () => {
  it('zero-fills the Go primitives', () => {
    expect(exported(null, 'string')).toBe('')
    expect(exported(null, 'int')).toBe(0)
    expect(exported(null, 'bool')).toBe(false)
    expect(exported(null, 'time')).toBe(ZERO_TIME)
    expect(exported(undefined, 'raw')).toBeNull()
  })

  it('prints a struct in its own order and a nil pointer as null', () => {
    expect(exported({ b: 2 }, struct(['b', 'int'], ['a', 'string']))).toEqual({ b: 2, a: '' })
    expect(Object.keys(exported({}, struct(['b', 'int'], ['a', 'string'])) as object)).toEqual([
      'b',
      'a',
    ])
    expect(exported(null, pointer(['oid', 'string']))).toBeNull()
    expect(exported(null, listOf('string'))).toBeNull()
  })

  it('prints a user author with its id and a bot as app/<login>', () => {
    expect(exported({ id: 'U1', login: 'octo', name: 'Octo' }, 'author')).toEqual({
      id: 'U1',
      is_bot: false,
      login: 'octo',
      name: 'Octo',
    })
    expect(exported({ login: 'dependabot' }, 'author')).toEqual({
      is_bot: true,
      login: 'app/dependabot',
    })
    expect(exported(null, orNull('author'))).toBeNull()
  })

  it('drops every reaction group nobody reacted with', () => {
    const groups = [
      { content: 'THUMBS_UP', users: { totalCount: 2 } },
      { content: 'LAUGH', users: { totalCount: 0 } },
    ]
    expect(exported(groups, 'reactions')).toEqual([groups[0]])
    expect(exported(null, 'reactions')).toEqual([])
  })

  it('leaves an empty owner id and name out', () => {
    expect(exported({ id: 'O1', login: 'org' }, 'owner')).toEqual({ id: 'O1', login: 'org' })
    expect(exported({ id: 'U1', name: 'Me', login: 'me' }, 'owner')).toEqual({
      id: 'U1',
      name: 'Me',
      login: 'me',
    })
    expect(exported(null, 'owner')).toEqual({ login: '' })
  })
})
