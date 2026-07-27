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
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../resource/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { rename } from './rename.ts'

function mkPath(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

function mkAccessor(): RAMAccessor {
  const store = new RAMStore()
  const enc = new TextEncoder()
  store.files.set('/a.txt', enc.encode('hi'))
  store.files.set('/plain', enc.encode('y'))
  store.dirs.add('/dir')
  store.files.set('/dir/f', enc.encode('x'))
  store.dirs.add('/d')
  return new RAMAccessor(store)
}

async function codeOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe('core/ram rename', () => {
  it('moves a file', async () => {
    const acc = mkAccessor()
    await rename(acc, mkPath('/a.txt'), mkPath('/d/b.txt'))
    expect(acc.store.files.has('/d/b.txt')).toBe(true)
    expect(acc.store.files.has('/a.txt')).toBe(false)
  })

  it('moves a directory with its children', async () => {
    const acc = mkAccessor()
    await rename(acc, mkPath('/dir'), mkPath('/d/moved'))
    expect(acc.store.dirs.has('/d/moved')).toBe(true)
    expect(acc.store.files.has('/d/moved/f')).toBe(true)
    expect(acc.store.files.has('/dir/f')).toBe(false)
  })

  it('a missing source is ENOENT', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/nope'), mkPath('/d/x')))).toBe('ENOENT')
  })

  it('a file into a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/a.txt'), mkPath('/missing/a.txt')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/a.txt')).toBe(true)
    expect(acc.store.files.has('/missing/a.txt')).toBe(false)
  })

  it('a directory into a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/dir'), mkPath('/missing/dir')))).toBe('ENOENT')
    expect(acc.store.dirs.has('/dir')).toBe(true)
    expect(acc.store.files.has('/dir/f')).toBe(true)
    expect(acc.store.dirs.has('/missing/dir')).toBe(false)
  })

  it('a missing grandparent is ENOENT', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/a.txt'), mkPath('/missing/sub/a.txt')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/a.txt')).toBe(true)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/a.txt'), mkPath('/plain/c.txt')))).toBe(
      'ENOTDIR',
    )
    expect(acc.store.files.has('/a.txt')).toBe(true)
    expect(acc.store.files.has('/plain/c.txt')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/a.txt'), mkPath('/plain/sub/c.txt')))).toBe(
      'ENOTDIR',
    )
    expect(acc.store.files.has('/a.txt')).toBe(true)
  })

  // rename(2) resolves the destination path first: a bad destination parent
  // outranks a missing source (ENOTDIR, not ENOENT).
  it('resolves the destination before the source', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => rename(acc, mkPath('/nope'), mkPath('/plain/x')))).toBe('ENOTDIR')
  })

  it('a root child is allowed', async () => {
    const acc = mkAccessor()
    await rename(acc, mkPath('/a.txt'), mkPath('/b.txt'))
    expect(acc.store.files.has('/b.txt')).toBe(true)
  })
})
