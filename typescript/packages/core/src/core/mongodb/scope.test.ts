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
import { detectScope, entityKind } from './scope.ts'
import { EntityKind } from './types.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('detectScope', () => {
  it('returns root for "/"', () => {
    const s = detectScope(ps('/'))
    expect(s.kind).toBe('root')
    expect(s.vfsPath).toBe('/')
  })

  it('returns root for empty string', () => {
    expect(detectScope(ps('')).kind).toBe('root')
  })

  it('returns database level for /<db>', () => {
    const s = detectScope(ps('/app'))
    expect(s.kind).toBe('database')
    expect(s.slots).toEqual({ database: 'app' })
  })

  it('handles trailing slash on database path', () => {
    const s = detectScope(ps('/app/'))
    expect(s.kind).toBe('database')
    expect(s.slots).toEqual({ database: 'app' })
  })

  it('returns database_json for /<db>/database.json', () => {
    const s = detectScope(ps('/app/database.json'))
    expect(s.kind).toBe('database_json')
    expect(s.slots).toEqual({ database: 'app' })
  })

  it('returns kind_dir for /<db>/collections', () => {
    const s = detectScope(ps('/app/collections'))
    expect(s.kind).toBe('kind_dir')
    expect(s.slots.database).toBe('app')
    expect(entityKind(s)).toBe(EntityKind.COLLECTION)
  })

  it('returns kind_dir for /<db>/views', () => {
    const s = detectScope(ps('/app/views'))
    expect(s.kind).toBe('kind_dir')
    expect(entityKind(s)).toBe(EntityKind.VIEW)
  })

  it('returns entity for /<db>/collections/<name>', () => {
    const s = detectScope(ps('/app/collections/users'))
    expect(s.kind).toBe('entity')
    expect(s.slots.database).toBe('app')
    expect(entityKind(s)).toBe(EntityKind.COLLECTION)
    expect(s.slots.name).toBe('users')
  })

  it('returns entity for /<db>/views/<name>', () => {
    const s = detectScope(ps('/app/views/active_users'))
    expect(s.kind).toBe('entity')
    expect(entityKind(s)).toBe(EntityKind.VIEW)
    expect(s.slots.name).toBe('active_users')
  })

  it('returns schema_json for documents-deep schema.json', () => {
    const s = detectScope(ps('/app/collections/users/schema.json'))
    expect(s.kind).toBe('schema_json')
    expect(entityKind(s)).toBe(EntityKind.COLLECTION)
    expect(s.slots.name).toBe('users')
  })

  it('returns documents for documents-deep documents.jsonl', () => {
    const s = detectScope(ps('/app/collections/users/documents.jsonl'))
    expect(s.kind).toBe('documents')
    expect(entityKind(s)).toBe(EntityKind.COLLECTION)
    expect(s.slots.name).toBe('users')
  })

  it('returns documents for a view documents.jsonl', () => {
    const s = detectScope(ps('/app/views/active_users/documents.jsonl'))
    expect(s.kind).toBe('documents')
    expect(entityKind(s)).toBe(EntityKind.VIEW)
  })

  it('returns invalid for unrecognized 2-part paths', () => {
    expect(detectScope(ps('/app/something')).kind).toBe('invalid')
  })

  it('returns invalid for too-deep paths', () => {
    expect(detectScope(ps('/a/collections/b/documents.jsonl/extra')).kind).toBe('invalid')
  })
})

describe('detectScope (path prefix)', () => {
  it('strips mount prefix before detection', () => {
    const path = new PathSpec({
      virtual: '/mongo/app/collections/users/documents.jsonl',
      directory: '/mongo/app/collections/users/',
      vfsPath: mountKey('/mongo/app/collections/users/documents.jsonl', '/mongo'),
    })
    const s = detectScope(path)
    expect(s.kind).toBe('documents')
    expect(s.slots.database).toBe('app')
    expect(entityKind(s)).toBe(EntityKind.COLLECTION)
    expect(s.slots.name).toBe('users')
  })
})
