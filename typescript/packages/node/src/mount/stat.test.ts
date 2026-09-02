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

import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { FileStatInit } from '@struktoai/mirage-core/types'
import { mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import { describe, expect, it } from 'vitest'
import { applyStatAttrs, dirStat, fileStat, linkStat } from './stat.ts'

const NOW = new Date(1_700_000_000_000)

function row(over: Partial<FileStatInit>): FileStat {
  return new FileStat({ name: 'f', type: FileType.TEXT, ...over })
}

describe('mount stat rows', () => {
  it('reports a directory owned by the mounting user', () => {
    const entry = dirStat(501, 20, NOW)

    expect(entry.mode & 0o170000).toBe(0o040000)
    expect([entry.size, entry.nlink]).toEqual([0, 2])
    expect([entry.uid, entry.gid]).toEqual([501, 20])
    expect(entry.mtime).toBe(NOW)
  })

  it('carries the size a file was given', () => {
    const entry = fileStat(42, 501, 20, NOW)

    expect(entry.mode & 0o170000).toBe(0o100000)
    expect([entry.size, entry.nlink]).toEqual([42, 1])
  })

  it('sizes a link by its target string and reports lrwxrwxrwx', () => {
    const entry = linkStat('../a.txt', null, 501, 20, NOW)

    expect(entry.mode).toBe(0o120777)
    expect(entry.size).toBe('../a.txt'.length)
  })

  it('keeps the link mode even when the row overlays one', () => {
    // A symlink's permission bits are not consulted by any POSIX
    // system, so an overlaid chmod must not make it read as a file.
    const entry = linkStat('a.txt', row({ type: FileType.SYMLINK, mode: 0o600 }), 0, 0, NOW)

    expect(entry.mode).toBe(0o120777)
  })

  it("takes the link row's own owner and stamp", () => {
    const own = row({ type: FileType.SYMLINK, uid: 1234, modified: '2026-01-02T03:04:05Z' })

    const entry = linkStat('a.txt', own, 0, 0, NOW)

    expect(entry.uid).toBe(1234)
    expect(entry.mtime.getTime()).toBe(mtimeMs(own))
  })

  it('ignores named owners', () => {
    // There is no user database to map a name against, and the kernel
    // wants a number, so a name leaves the mounting user in place.
    const entry = applyStatAttrs(fileStat(0, 501, 20, NOW), row({ uid: 'alice', gid: 'staff' }))

    expect([entry.uid, entry.gid]).toEqual([501, 20])
  })

  it('keeps the type bits and takes the permissions', () => {
    const entry = applyStatAttrs(dirStat(0, 0, NOW), row({ type: FileType.DIRECTORY, mode: 0o700 }))

    expect(entry.mode & 0o170000).toBe(0o040000)
    expect(entry.mode & 0o7777).toBe(0o700)
  })

  it('lands epoch zero instead of reading it as unknown', () => {
    // 1970-01-01T00:00:00Z is a real answer, not a missing stamp.
    const entry = applyStatAttrs(fileStat(0, 0, 0, NOW), row({ modified: '1970-01-01T00:00:00Z' }))

    expect(entry.mtime.getTime()).toBe(0)
    expect(entry.ctime.getTime()).toBe(0)
  })
})
