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

import { expect, it } from 'vitest'
import { posixStat } from '../stat.ts'
import { CHAR_MODE, DIR_MODE, FILE_MODE, LINK_MODE } from '../../utils/stat_view.ts'
import { FT_CHR, FT_DIR, FT_REG, FT_SYMLINK, FT_UNKNOWN } from './constants.ts'
import { filetypeOf, packFdstat, packFilestat, packPrestat } from './stat.ts'

it('packs records in the preview1 layouts', () => {
  expect(packPrestat(1).byteLength).toBe(8)
  expect(packFdstat(FT_REG).byteLength).toBe(24)
  const row = { size: 0, isDir: false, mode: 0o100644 }
  expect(packFilestat(posixStat(row, '/f', '/'), FT_REG).byteLength).toBe(64)
})

it('packs a stamp in nanoseconds, to the microsecond, past 2**53', () => {
  const row = { size: 0, isDir: false, mode: FILE_MODE, mtimeMs: 981173107123.456 }
  const record = packFilestat(posixStat(row, '/f', '/'), FT_REG)
  expect(new DataView(record.buffer).getBigUint64(48, true)).toBe(981173107123456000n)
})

it('answers a stat and a listing row alike', () => {
  // One table for path_filestat_get and fd_readdir, so d_type never
  // disagrees with the stat: a character device lists as one.
  expect(filetypeOf({ size: 3, isDir: false, mode: LINK_MODE, isLink: true })).toBe(FT_SYMLINK)
  expect(filetypeOf({ size: 0, isDir: true, mode: DIR_MODE })).toBe(FT_DIR)
  expect(filetypeOf({ size: 1, isDir: false, mode: FILE_MODE })).toBe(FT_REG)
  expect(filetypeOf({ path: '/dev/null', size: 0, isDir: false, mode: CHAR_MODE })).toBe(FT_CHR)
  expect(filetypeOf({ path: '/data/sub/', size: 0, isDir: true })).toBe(FT_DIR)
  expect(filetypeOf({ path: '/data/bad', size: 0, isDir: false })).toBe(FT_UNKNOWN)
})
