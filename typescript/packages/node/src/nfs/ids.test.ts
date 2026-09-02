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
import { EINVAL } from '../mount/errors.ts'
import { RenameIntoSelfError, StaleHandleError } from './errors.ts'
import { IdTable, ROOT_PATH } from './ids.ts'

describe('IdTable', () => {
  it('mints a stable id per path', () => {
    const t = new IdTable()
    const first = t.alloc('/a.txt')
    expect(t.alloc('/a.txt')).toBe(first)
    expect(t.alloc('/b.txt')).not.toBe(first)
  })

  it('resolves an id back to its path', () => {
    const t = new IdTable()
    expect(t.resolve(t.alloc(ROOT_PATH))).toBe(ROOT_PATH)
  })

  it('answers an unknown id as stale', () => {
    expect(() => new IdTable().resolve(4242)).toThrow(StaleHandleError)
  })

  it('never reuses an invalidated id', () => {
    // A client may hold a handle to a deleted file forever; reusing
    // the id would silently point it at a different file.
    const t = new IdTable()
    const gone = t.alloc('/gone.txt')
    t.invalidate(gone)
    expect(t.alloc('/other.txt')).not.toBe(gone)
    expect(() => t.resolve(gone)).toThrow(StaleHandleError)
  })

  it('invalidate is idempotent', () => {
    const t = new IdTable()
    const id = t.alloc('/x')
    t.invalidate(id)
    expect(() => {
      t.invalidate(id)
    }).not.toThrow()
  })

  it('idFor does not mint', () => {
    const t = new IdTable()
    expect(t.idFor('/nope')).toBeUndefined()
  })

  it('rename carries the id and the whole subtree', () => {
    const t = new IdTable()
    const dir = t.alloc('/dir')
    const child = t.alloc('/dir/deep/f.txt')
    t.rename('/dir', '/moved')
    expect(t.resolve(dir)).toBe('/moved')
    expect(t.resolve(child)).toBe('/moved/deep/f.txt')
  })

  it('rename leaves a same-prefix sibling alone', () => {
    const t = new IdTable()
    const sibling = t.alloc('/directory.txt')
    t.alloc('/dir')
    t.rename('/dir', '/moved')
    expect(t.resolve(sibling)).toBe('/directory.txt')
  })

  it('refuses a rename into its own subtree with EINVAL', () => {
    const t = new IdTable()
    const id = t.alloc('/dir')
    try {
      t.rename('/dir', '/dir/inner')
      throw new Error('expected RenameIntoSelfError')
    } catch (err) {
      expect(err).toBeInstanceOf(RenameIntoSelfError)
      expect((err as RenameIntoSelfError).errno).toBe(EINVAL)
    }
    expect(t.resolve(id)).toBe('/dir')
  })

  it('guardRename refuses before any mutation', () => {
    const t = new IdTable()
    t.alloc('/dir')
    expect(() => {
      t.guardRename('/dir', '/dir/inner')
    }).toThrow(RenameIntoSelfError)
    expect(() => {
      t.guardRename('/dir', '/elsewhere')
    }).not.toThrow()
  })

  it('rename onto an existing path invalidates the displaced id', () => {
    const t = new IdTable()
    const victim = t.alloc('/dst.txt')
    const mover = t.alloc('/src.txt')
    t.rename('/src.txt', '/dst.txt')
    expect(t.resolve(mover)).toBe('/dst.txt')
    expect(() => t.resolve(victim)).toThrow(StaleHandleError)
  })
})
