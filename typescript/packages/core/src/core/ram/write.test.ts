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
import { appendBytes } from './append.ts'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { writeBytes } from './write.ts'

const ENC = new TextEncoder()

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
  store.files.set('/plain', ENC.encode('y'))
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

describe('core/ram writeBytes destination parents', () => {
  it('writes into an existing directory', async () => {
    const acc = mkAccessor()
    await writeBytes(acc, mkPath('/d/f.txt'), ENC.encode('hi'))
    expect(acc.store.files.has('/d/f.txt')).toBe(true)
  })

  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => writeBytes(acc, mkPath('/missing/f.txt'), ENC.encode('hi')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a missing grandparent is ENOENT', async () => {
    const acc = mkAccessor()
    expect(
      await codeOf(() => writeBytes(acc, mkPath('/missing/sub/f.txt'), ENC.encode('hi'))),
    ).toBe('ENOENT')
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => writeBytes(acc, mkPath('/plain/f.txt'), ENC.encode('hi')))).toBe(
      'ENOTDIR',
    )
    expect(acc.store.files.has('/plain/f.txt')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => writeBytes(acc, mkPath('/plain/sub/f.txt'), ENC.encode('hi')))).toBe(
      'ENOTDIR',
    )
  })

  it('reports the operand, not the internal parent phrasing', async () => {
    const acc = mkAccessor()
    try {
      await writeBytes(acc, mkPath('/missing/f.txt'), ENC.encode('hi'))
      expect.unreachable()
    } catch (err) {
      expect((err as { virtualPath?: string }).virtualPath).toBe('/missing/f.txt')
      expect((err as Error).message).not.toContain('parent directory does not exist')
    }
  })
})

describe('core/ram create destination parents', () => {
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => create(acc, mkPath('/missing/f.txt')))).toBe('ENOENT')
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => create(acc, mkPath('/plain/f.txt')))).toBe('ENOTDIR')
  })

  it('into an existing directory is allowed', async () => {
    const acc = mkAccessor()
    await create(acc, mkPath('/d/f.txt'))
    expect(acc.store.files.get('/d/f.txt')?.byteLength).toBe(0)
  })
})

describe('core/ram appendBytes destination parents', () => {
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => appendBytes(acc, mkPath('/missing/f.txt'), ENC.encode('hi')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => appendBytes(acc, mkPath('/plain/f.txt'), ENC.encode('hi')))).toBe(
      'ENOTDIR',
    )
  })

  it('appends into an existing directory', async () => {
    const acc = mkAccessor()
    await appendBytes(acc, mkPath('/d/f.txt'), ENC.encode('a'))
    await appendBytes(acc, mkPath('/d/f.txt'), ENC.encode('b'))
    expect(new TextDecoder().decode(acc.store.files.get('/d/f.txt'))).toBe('ab')
  })
})

describe('core/ram mkdir destination parents', () => {
  // The non-parents branch used to throw a bare Error, so the failure was
  // not even classified as a filesystem error and could not be reported
  // with a GNU strerror.
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/missing/sub')))).toBe('ENOENT')
    expect(acc.store.dirs.has('/missing/sub')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/plain/sub')))).toBe('ENOTDIR')
    expect(acc.store.dirs.has('/plain/sub')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/plain/sub/deeper')))).toBe('ENOTDIR')
  })

  it('into an existing directory is allowed', async () => {
    const acc = mkAccessor()
    await mkdir(acc, mkPath('/d/sub'))
    expect(acc.store.dirs.has('/d/sub')).toBe(true)
  })
})
