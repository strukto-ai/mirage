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
import { ident } from '../utils/stat_view.ts'
import { posixStat } from './stat.ts'

describe('posixStat', () => {
  it('reads a file row as one link in 512-byte blocks', () => {
    const st = posixStat(
      { size: 1000, isDir: false, mode: 0o100644, mtimeMs: 5 },
      '/data/f.txt',
      '/data',
    )
    expect([st.nlink, st.blocks, st.blksize]).toEqual([1, 2, 4096])
    expect([st.atimeMs, st.mtimeMs, st.ctimeMs]).toEqual([5, 5, 5])
    expect([st.ino, st.dev]).toEqual([ident('/data/f.txt'), ident('/data')])
  })

  it('takes the fallback for an owner and access time the row lacks', () => {
    const st = posixStat({ size: 0, isDir: true, mode: 0o40755 }, '/d', '/', {
      uid: 501,
      gid: 20,
      unknownMs: 7,
    })
    expect([st.nlink, st.uid, st.gid, st.mtimeMs, st.atimeMs]).toEqual([2, 501, 20, 7, 7])
  })

  it("keeps the row's owner and access time", () => {
    const st = posixStat(
      { size: 0, isDir: false, mode: 0o100600, mtimeMs: 9, atimeMs: 3, uid: 0, gid: 0 },
      '/f',
      '/',
      { uid: 501, gid: 20 },
    )
    expect([st.uid, st.gid, st.atimeMs, st.mtimeMs]).toEqual([0, 0, 3, 9])
  })

  it('computes the ident python computes', () => {
    // Pinned in python's tests/runtime/test_stat.py too: one path is one
    // inode whichever host answers.
    expect(ident('/data/f.txt')).toBe(213244078163057)
    expect(ident('/')).toBe(192842459547137)
  })
})
