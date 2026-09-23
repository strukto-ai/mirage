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

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import {
  resolveLanceDBConfig,
  type LanceDBConfig,
  type LanceDBConfigResolved,
} from '../../vfs/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import { INVALID, ROOT, makeDetectScope, type DetectFn } from '../hierarchy/scope.ts'
import type { LanceDriver } from './_driver.ts'
import { detectFor, filtersOf, scopesFor, tableOf } from './scope.ts'

function cfg(over: Partial<LanceDBConfig> = {}): LanceDBConfigResolved {
  return resolveLanceDBConfig({
    uri: '/tmp/db',
    groupBy: ['label', 'kind'],
    idColumn: 'id',
    blobColumn: 'image_bytes',
    blobExt: 'png',
    vectorColumn: 'vector',
    ...over,
  })
}

const config = cfg()

function detect(c: LanceDBConfigResolved): DetectFn {
  return makeDetectScope(scopesFor(c))
}

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('lancedb scope', () => {
  it('root in multi-table mode', () => {
    expect(detect(config)(ps('/')).kind).toBe(ROOT)
  })

  it('table is a group dir', () => {
    const match = detect(config)(ps('/animals'))
    expect(match.kind).toBe('group')
    expect(tableOf(config, match)).toBe('animals')
    expect(filtersOf(config, match)).toEqual({})
  })

  it('nested group dir binds a filter', () => {
    const match = detect(config)(ps('/animals/cat'))
    expect(match.kind).toBe('group')
    expect(filtersOf(config, match)).toEqual({ label: 'cat' })
  })

  it('row card', () => {
    const match = detect(config)(ps('/animals/cat/big/3.md'))
    expect(match.kind).toBe('row_card')
    expect(match.slots.row_id).toBe('3')
    expect(filtersOf(config, match)).toEqual({ label: 'cat', kind: 'big' })
  })

  it('row blob', () => {
    const match = detect(config)(ps('/animals/cat/big/3.png'))
    expect(match.kind).toBe('row_blob')
    expect(match.slots.row_id).toBe('3')
  })

  it('blob leaf needs a blob column', () => {
    const blobless = resolveLanceDBConfig({ uri: '/tmp/db', groupBy: ['label', 'kind'] })
    const match = detect(blobless)(ps('/animals/cat/big/3.png'))
    expect(match.kind).toBe(INVALID)
  })

  it('too-deep paths are invalid', () => {
    expect(detect(config)(ps('/animals/cat/big/3.md/extra')).kind).toBe(INVALID)
  })

  it('pinned table elides the table segment', () => {
    const pinned = cfg({ table: 'animals' })
    const match = detect(pinned)(ps('/cat/big'))
    expect(match.kind).toBe('group')
    expect(tableOf(pinned, match)).toBe('animals')
    expect(filtersOf(pinned, match)).toEqual({ label: 'cat', kind: 'big' })
  })

  it('pinned flat table serves rows at the root', () => {
    const flat = detect(cfg({ table: 'animals', groupBy: [] }))
    expect(flat(ps('/')).kind).toBe(ROOT)
    expect(flat(ps('/3.md')).kind).toBe('row_card')
    expect(flat(ps('/whatever')).kind).toBe(INVALID)
  })

  it('detectFor caches per accessor', () => {
    const driver = {} as LanceDriver
    const accessor = new LanceDBAccessor(driver, config)
    expect(detectFor(accessor)).toBe(detectFor(accessor))
    const other = new LanceDBAccessor(driver, cfg({ groupBy: ['label'] }))
    expect(detectFor(other)(ps('/animals/cat/3.md')).kind).toBe('row_card')
  })
})

describe('lancedb group segments', () => {
  it('decode the path-safe rendering back to the exact value', () => {
    // `a/b` lists as `a∕b` and `a∕b` as `a⁄∕b`; the WHERE clause each
    // directory builds must hold the value it was rendered from.
    expect(filtersOf(config, detect(config)(ps('/animals/a∕b')))).toEqual({ label: 'a/b' })
    expect(filtersOf(config, detect(config)(ps('/animals/a⁄∕b')))).toEqual({ label: 'a∕b' })
    expect(filtersOf(config, detect(config)(ps('/animals/⁄')))).toEqual({ label: '' })
    expect(filtersOf(config, detect(config)(ps('/animals/⁄.env')))).toEqual({ label: '.env' })
  })
})
