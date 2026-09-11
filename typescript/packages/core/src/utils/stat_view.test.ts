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

import { ContentType, FileStat, FileType } from '../types.ts'
import {
  CHAR_MODE,
  contentSize,
  DIR_MODE,
  FILE_MODE,
  isDir,
  isLink,
  LINK_MODE,
  mtimeMs,
  posixMode,
} from './stat_view.ts'

const NAIVE = '2026-01-02T03:04:05'
// Date.UTC is TZ-independent, so this pin fails under a local-time
// parse on any host whose zone is not UTC, and stays honest on a UTC
// CI runner because the implementation must route through the same
// naive-is-UTC rule isoTimestamp states.
const UTC_MS = Date.UTC(2026, 0, 2, 3, 4, 5)

describe('mtimeMs', () => {
  it('reads an offset-less stamp as UTC', () => {
    const st = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: NAIVE,
    })
    expect(mtimeMs(st)).toBe(UTC_MS)
  })

  it('agrees across naive, offset and zulu spellings', () => {
    const spellings = [NAIVE, `${NAIVE}+00:00`, `${NAIVE}Z`]
    const stamps = spellings.map((modified) =>
      mtimeMs(
        new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT, modified }),
      ),
    )
    expect(new Set(stamps).size).toBe(1)
  })

  it('answers null for a missing or garbage stamp', () => {
    expect(
      mtimeMs(new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT })),
    ).toBeNull()
    expect(
      mtimeMs(
        new FileStat({
          name: 'f',
          type: FileType.FILE,
          content: ContentType.TEXT,
          modified: 'yesterday-ish',
        }),
      ),
    ).toBeNull()
  })

  it('answers 0 for epoch zero, a real time distinct from unknown', () => {
    const st = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '1970-01-01T00:00:00Z',
    })
    expect(mtimeMs(st)).toBe(0)
  })
})

describe('contentSize', () => {
  it('is zero for a directory whatever the backend reports', () => {
    const st = new FileStat({ name: 'd', type: FileType.DIRECTORY, size: 4096 })
    expect(contentSize(st)).toBe(0)
    expect(isDir(st)).toBe(true)
  })

  it('is zero for an unknown size and passes a known one through', () => {
    expect(
      contentSize(new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT })),
    ).toBe(0)
    expect(
      contentSize(
        new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT, size: 11 }),
      ),
    ).toBe(11)
  })
})

describe('mode constants', () => {
  it('carry the POSIX type bits', () => {
    expect(CHAR_MODE).toBe(0o020666)
    expect(DIR_MODE).toBe(0o040755)
    expect(FILE_MODE).toBe(0o100644)
  })
})

describe('posixMode', () => {
  it('keeps the default pair when the backend reports no mode', () => {
    const dir = new FileStat({ name: 'd', type: FileType.DIRECTORY })
    const file = new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT })
    expect(posixMode(dir)).toBe(DIR_MODE)
    expect(posixMode(file)).toBe(FILE_MODE)
  })

  it('takes the permission bits from the overlay and the type bits from the kind', () => {
    const st = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      mode: 0o600,
    })
    expect(posixMode(st)).toBe((FILE_MODE & ~0o7777) | 0o600)
  })

  it('projects a character device with character type bits', () => {
    const st = new FileStat({ name: 'zero', type: FileType.CHAR_DEVICE })
    expect(posixMode(st)).toBe(CHAR_MODE)
  })

  // No POSIX system consults the bits on a symlink, so a chmod -h that
  // stored some is not what a stat consumer is told.
  it('reports a link as lrwxrwxrwx whatever the overlay holds', () => {
    const st = new FileStat({ name: 'l', type: FileType.SYMLINK, mode: 0o600 })
    expect(posixMode(st)).toBe(LINK_MODE)
  })
})

describe('isLink', () => {
  it('reads the kind', () => {
    expect(isLink(new FileStat({ name: 'l', type: FileType.SYMLINK }))).toBe(true)
    expect(
      isLink(new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT })),
    ).toBe(false)
  })
})
