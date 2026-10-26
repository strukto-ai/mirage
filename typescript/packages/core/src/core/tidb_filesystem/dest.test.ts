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
import { spec } from '../../../tests/core/tidb_filesystem/drive9.ts'
import {
  brokenParent,
  checkMkdirTarget,
  checkRename,
  checkWriteTarget,
  lookupError,
} from './dest.ts'
import type { Entry, Kinds } from './types.ts'

const ROOT: Entry = { name: '/', isDir: true, size: 0, mtime: null }
const DIR: Entry = { name: 'd', isDir: true, size: 0, mtime: null }
const FILE: Entry = { name: 'f', isDir: false, size: 1, mtime: null }

function kinds(entries: Record<string, Entry | null>): Kinds {
  return new Map([['/', ROOT], ...Object.entries(entries)])
}

describe('dest', () => {
  it('stops at the first gap above a path', () => {
    expect(
      brokenParent(kinds({ '/a': null, '/a/b': FILE }), spec('/fs/a/b/c'), '/a/b/c')?.code,
    ).toBe('ENOENT')
  })

  it('takes a folder beside a file of its name as the folder above', () => {
    expect(brokenParent(kinds({ '/a': FILE, '/a/': DIR }), spec('/fs/a/b'), '/a/b')).toBeNull()
  })

  it('names a file above a lookup', () => {
    expect(lookupError(kinds({ '/a': FILE }), spec('/fs/a/x'), '/a/x').code).toBe('ENOTDIR')
  })

  it('refuses a write onto a directory', () => {
    expect(() => {
      checkWriteTarget(kinds({ '/d': DIR }), spec('/fs/d'), '/d')
    }).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  })

  it('answers EEXIST for plain mkdir on anything', () => {
    expect(() => checkMkdirTarget(kinds({ '/f': FILE }), spec('/fs/f'), '/f', false)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    )
  })

  it('names the file mkdir -p crosses', () => {
    expect(() =>
      checkMkdirTarget(kinds({ '/f': FILE, '/f/sub': null }), spec('/fs/f/sub'), '/f/sub', true),
    ).toThrow(expect.objectContaining({ code: 'ENOTDIR', virtualPath: '/fs/f' }))
  })

  it('finds mkdir -p on a directory done', () => {
    expect(checkMkdirTarget(kinds({ '/d': DIR }), spec('/fs/d'), '/d', true)).toBe(true)
  })

  it.each([
    [{ '/f': FILE, '/d': DIR }, '/f', '/d', 'EISDIR'],
    [{ '/d': DIR, '/f': FILE }, '/d', '/f', 'ENOTDIR'],
    [{ '/d': DIR, '/d/in': null }, '/d', '/d/in', 'EINVAL'],
    [{ '/f': FILE, '/x': null, '/x/y': null }, '/f', '/x/y', 'ENOENT'],
    [{ '/f': null, '/g': null }, '/f', '/g', 'ENOENT'],
  ] as const)('refuses rename %#', (entries, src, dst, code) => {
    expect(() => {
      checkRename(kinds(entries), spec(`/fs${src}`), src, spec(`/fs${dst}`), dst)
    }).toThrow(expect.objectContaining({ code }))
  })
})
