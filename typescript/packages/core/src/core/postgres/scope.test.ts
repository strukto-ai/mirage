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

import { stripSlash } from '../../utils/slash.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import { detectScope } from './scope.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ resourcePath: stripSlash(p), virtual: p, directory: p })
}

describe('detectScope', () => {
  it('detects root from "/"', () => {
    const s = detectScope(ps('/'))
    expect(s.level).toBe('root')
    expect(s.resourcePath).toBe('/')
  })

  it('detects root from empty string', () => {
    expect(detectScope(ps('')).level).toBe('root')
  })

  it('detects database.json', () => {
    const s = detectScope(ps('/database.json'))
    expect(s.level).toBe('database_json')
    if (s.level !== 'database_json') return
    expect(s.file).toBe('database.json')
  })

  it('detects schema level', () => {
    const s = detectScope(ps('/public'))
    expect(s.level).toBe('schema')
    if (s.level !== 'schema') return
    expect(s.schema).toBe('public')
  })

  it('detects schema level with trailing slash', () => {
    const s = detectScope(ps('/public/'))
    expect(s.level).toBe('schema')
    if (s.level !== 'schema') return
    expect(s.schema).toBe('public')
  })

  it('detects kind=tables', () => {
    const s = detectScope(ps('/public/tables'))
    expect(s.level).toBe('kind')
    if (s.level !== 'kind') return
    expect(s.schema).toBe('public')
    expect(s.kind).toBe('tables')
  })

  it('detects kind=views', () => {
    const s = detectScope(ps('/analytics/views'))
    expect(s.level).toBe('kind')
    if (s.level !== 'kind') return
    expect(s.schema).toBe('analytics')
    expect(s.kind).toBe('views')
  })

  it('detects entity under tables', () => {
    const s = detectScope(ps('/public/tables/users'))
    expect(s.level).toBe('entity')
    if (s.level !== 'entity') return
    expect(s.schema).toBe('public')
    expect(s.kind).toBe('tables')
    expect(s.entity).toBe('users')
  })

  it('detects entity under views', () => {
    const s = detectScope(ps('/analytics/views/daily_revenue'))
    expect(s.level).toBe('entity')
    if (s.level !== 'entity') return
    expect(s.kind).toBe('views')
    expect(s.entity).toBe('daily_revenue')
  })

  it('detects entity_schema file', () => {
    const s = detectScope(ps('/public/tables/users/schema.json'))
    expect(s.level).toBe('entity_schema')
    if (s.level !== 'entity_schema') return
    expect(s.schema).toBe('public')
    expect(s.kind).toBe('tables')
    expect(s.entity).toBe('users')
    expect(s.file).toBe('schema.json')
  })

  it('detects entity_rows file', () => {
    const s = detectScope(ps('/public/tables/users/rows.jsonl'))
    expect(s.level).toBe('entity_rows')
    if (s.level !== 'entity_rows') return
    expect(s.entity).toBe('users')
    expect(s.file).toBe('rows.jsonl')
  })

  it('detects view entity_schema file', () => {
    const s = detectScope(ps('/analytics/views/daily_revenue/schema.json'))
    expect(s.level).toBe('entity_schema')
    if (s.level !== 'entity_schema') return
    expect(s.kind).toBe('views')
  })

  it('marks invalid kind segment', () => {
    expect(detectScope(ps('/public/sequences')).level).toBe('invalid')
  })

  it('marks too-deep path invalid', () => {
    expect(detectScope(ps('/public/tables/users/extra/foo')).level).toBe('invalid')
  })

  it('marks unknown file invalid', () => {
    expect(detectScope(ps('/public/tables/users/data.jsonl')).level).toBe('invalid')
  })

  it('marks invalid kind in third position', () => {
    expect(detectScope(ps('/public/wrong_kind/foo')).level).toBe('invalid')
  })

  it('strips mount prefix before detection', () => {
    const path = new PathSpec({
      virtual: '/pg/public/tables/users',
      directory: '/pg/public/tables/',
      resourcePath: mountKey('/pg/public/tables/users', '/pg/'),
    })
    const s = detectScope(path)
    expect(s.level).toBe('entity')
    if (s.level !== 'entity') return
    expect(s.schema).toBe('public')
    expect(s.entity).toBe('users')
  })
})
