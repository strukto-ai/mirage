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
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import { detectScope } from './scope.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('detectScope', () => {
  it('detects root from "/"', () => {
    const s = detectScope(ps('/'))
    expect(s.kind).toBe('root')
    expect(s.vfsPath).toBe('/')
  })

  it('detects root from empty string', () => {
    expect(detectScope(ps('')).kind).toBe('root')
  })

  it('detects database.json', () => {
    const s = detectScope(ps('/database.json'))
    expect(s.kind).toBe('database_json')
  })

  it('detects schema level', () => {
    const s = detectScope(ps('/public'))
    expect(s.kind).toBe('schema')
    expect(s.slots).toEqual({ schema: 'public' })
  })

  it('detects schema level with trailing slash', () => {
    const s = detectScope(ps('/public/'))
    expect(s.kind).toBe('schema')
    expect(s.slots).toEqual({ schema: 'public' })
  })

  it('detects tables kind dir', () => {
    const s = detectScope(ps('/public/tables'))
    expect(s.kind).toBe('kind')
    expect(s.slots).toEqual({ schema: 'public', kind: 'tables' })
  })

  it('detects views kind dir', () => {
    const s = detectScope(ps('/analytics/views'))
    expect(s.kind).toBe('kind')
    expect(s.slots).toEqual({ schema: 'analytics', kind: 'views' })
  })

  it('detects a table entity dir', () => {
    const s = detectScope(ps('/public/tables/users'))
    expect(s.kind).toBe('entity')
    expect(s.slots).toEqual({ schema: 'public', kind: 'tables', entity: 'users' })
  })

  it('detects a view entity dir', () => {
    const s = detectScope(ps('/analytics/views/daily_revenue'))
    expect(s.kind).toBe('entity')
    expect(s.slots.kind).toBe('views')
    expect(s.slots.entity).toBe('daily_revenue')
  })

  it('detects an entity schema.json', () => {
    const s = detectScope(ps('/public/tables/users/schema.json'))
    expect(s.kind).toBe('entity_schema')
    expect(s.slots).toEqual({ schema: 'public', kind: 'tables', entity: 'users' })
  })

  it('detects an entity semantic.json', () => {
    const s = detectScope(ps('/public/tables/users/semantic.json'))
    expect(s.kind).toBe('entity_semantic')
    expect(s.slots).toEqual({ schema: 'public', kind: 'tables', entity: 'users' })
  })

  it('detects an entity rows.jsonl', () => {
    const s = detectScope(ps('/public/tables/users/rows.jsonl'))
    expect(s.kind).toBe('entity_rows')
    expect(s.slots.schema).toBe('public')
    expect(s.slots.entity).toBe('users')
  })

  it('detects a view entity schema.json', () => {
    const s = detectScope(ps('/analytics/views/daily_revenue/schema.json'))
    expect(s.kind).toBe('entity_schema')
    expect(s.slots.kind).toBe('views')
  })

  it('rejects an unknown kind segment', () => {
    expect(detectScope(ps('/public/sequences')).kind).toBe('invalid')
  })

  it('rejects a path that is too deep', () => {
    expect(detectScope(ps('/public/tables/users/extra/foo')).kind).toBe('invalid')
  })

  it('rejects an unknown entity file', () => {
    expect(detectScope(ps('/public/tables/users/data.jsonl')).kind).toBe('invalid')
  })

  it('rejects a wrong kind in third position', () => {
    expect(detectScope(ps('/public/wrong_kind/foo')).kind).toBe('invalid')
  })
})
