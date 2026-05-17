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
import { PathSpec } from '../../types.ts'
import { detectScope } from './scope.ts'
import { EntityKind, ScopeLevel } from './types.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ original: p, directory: p })
}

describe('detectScope', () => {
  it('returns root for "/"', () => {
    const s = detectScope(ps('/'))
    expect(s.level).toBe(ScopeLevel.ROOT)
    expect(s.resourcePath).toBe('/')
  })

  it('returns root for empty string', () => {
    expect(detectScope(ps('')).level).toBe(ScopeLevel.ROOT)
  })

  it('returns database level for /<db>', () => {
    const s = detectScope(ps('/app'))
    expect(s.level).toBe(ScopeLevel.DATABASE)
    expect(s.database).toBe('app')
  })

  it('handles trailing slash on database path', () => {
    const s = detectScope(ps('/app/'))
    expect(s.level).toBe(ScopeLevel.DATABASE)
    expect(s.database).toBe('app')
  })

  it('returns database_json for /<db>/database.json', () => {
    const s = detectScope(ps('/app/database.json'))
    expect(s.level).toBe(ScopeLevel.DATABASE_JSON)
    expect(s.database).toBe('app')
  })

  it('returns kind_dir for /<db>/collections', () => {
    const s = detectScope(ps('/app/collections'))
    expect(s.level).toBe(ScopeLevel.KIND_DIR)
    expect(s.database).toBe('app')
    expect(s.kind).toBe(EntityKind.COLLECTION)
  })

  it('returns kind_dir for /<db>/views', () => {
    const s = detectScope(ps('/app/views'))
    expect(s.level).toBe(ScopeLevel.KIND_DIR)
    expect(s.kind).toBe(EntityKind.VIEW)
  })

  it('returns entity for /<db>/collections/<name>', () => {
    const s = detectScope(ps('/app/collections/users'))
    expect(s.level).toBe(ScopeLevel.ENTITY)
    expect(s.database).toBe('app')
    expect(s.kind).toBe(EntityKind.COLLECTION)
    expect(s.name).toBe('users')
  })

  it('returns entity for /<db>/views/<name>', () => {
    const s = detectScope(ps('/app/views/active_users'))
    expect(s.level).toBe(ScopeLevel.ENTITY)
    expect(s.kind).toBe(EntityKind.VIEW)
    expect(s.name).toBe('active_users')
  })

  it('returns schema_json for documents-deep schema.json', () => {
    const s = detectScope(ps('/app/collections/users/schema.json'))
    expect(s.level).toBe(ScopeLevel.SCHEMA_JSON)
    expect(s.kind).toBe(EntityKind.COLLECTION)
    expect(s.name).toBe('users')
  })

  it('returns documents for documents-deep documents.jsonl', () => {
    const s = detectScope(ps('/app/collections/users/documents.jsonl'))
    expect(s.level).toBe(ScopeLevel.DOCUMENTS)
    expect(s.kind).toBe(EntityKind.COLLECTION)
    expect(s.name).toBe('users')
  })

  it('returns documents for a view documents.jsonl', () => {
    const s = detectScope(ps('/app/views/active_users/documents.jsonl'))
    expect(s.level).toBe(ScopeLevel.DOCUMENTS)
    expect(s.kind).toBe(EntityKind.VIEW)
  })

  it('returns unknown for unrecognized 2-part paths', () => {
    expect(detectScope(ps('/app/something')).level).toBe(ScopeLevel.UNKNOWN)
  })

  it('returns unknown for too-deep paths', () => {
    expect(detectScope(ps('/a/collections/b/documents.jsonl/extra')).level).toBe(ScopeLevel.UNKNOWN)
  })
})

describe('detectScope (path prefix)', () => {
  it('strips mount prefix before detection', () => {
    const path = new PathSpec({
      original: '/mongo/app/collections/users/documents.jsonl',
      directory: '/mongo/app/collections/users/',
      prefix: '/mongo',
    })
    const s = detectScope(path)
    expect(s.level).toBe(ScopeLevel.DOCUMENTS)
    expect(s.database).toBe('app')
    expect(s.kind).toBe(EntityKind.COLLECTION)
    expect(s.name).toBe('users')
  })
})
