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

import { FileStat, FileType } from '../types.ts'
import { contentSize, DIR_MODE, FILE_MODE, isDir, mtimeMs } from './stat_view.ts'

const NAIVE = '2026-01-02T03:04:05'
// Date.UTC is TZ-independent, so this pin fails under a local-time
// parse on any host whose zone is not UTC, and stays honest on a UTC
// CI runner because the implementation must route through the same
// naive-is-UTC rule isoTimestamp states.
const UTC_MS = Date.UTC(2026, 0, 2, 3, 4, 5)

describe('mtimeMs', () => {
  it('reads an offset-less stamp as UTC', () => {
    const st = new FileStat({ name: 'f', type: FileType.TEXT, modified: NAIVE })
    expect(mtimeMs(st)).toBe(UTC_MS)
  })

  it('agrees across naive, offset and zulu spellings', () => {
    const spellings = [NAIVE, `${NAIVE}+00:00`, `${NAIVE}Z`]
    const stamps = spellings.map((modified) =>
      mtimeMs(new FileStat({ name: 'f', type: FileType.TEXT, modified })),
    )
    expect(new Set(stamps).size).toBe(1)
  })

  it('answers 0 for a missing or garbage stamp', () => {
    expect(mtimeMs(new FileStat({ name: 'f', type: FileType.TEXT }))).toBe(0)
    expect(
      mtimeMs(new FileStat({ name: 'f', type: FileType.TEXT, modified: 'yesterday-ish' })),
    ).toBe(0)
  })
})

describe('contentSize', () => {
  it('is zero for a directory whatever the backend reports', () => {
    const st = new FileStat({ name: 'd', type: FileType.DIRECTORY, size: 4096 })
    expect(contentSize(st)).toBe(0)
    expect(isDir(st)).toBe(true)
  })

  it('is zero for an unknown size and passes a known one through', () => {
    expect(contentSize(new FileStat({ name: 'f', type: FileType.TEXT }))).toBe(0)
    expect(contentSize(new FileStat({ name: 'f', type: FileType.TEXT, size: 11 }))).toBe(11)
  })
})

describe('mode constants', () => {
  it('carry the POSIX type bits', () => {
    expect(DIR_MODE).toBe(0o040755)
    expect(FILE_MODE).toBe(0o100644)
  })
})
