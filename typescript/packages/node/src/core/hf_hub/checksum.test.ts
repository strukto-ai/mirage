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

import type { FileStat } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checksum } from './checksum.ts'
import * as client from './client.ts'
import { codeOf, handle, ps } from '../../../tests/core/hf_hub/_test_util.ts'
import { parseEntry, rowOf } from './tree.ts'

const SHA = 'a'.repeat(64)
const LFS = { oid: SHA, size: 7, pointerSize: 135 }

function fileRow(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'file', oid: `oid-${path}`, size: 7, path, ...extra }
}

function row(item: Record<string, unknown>): FileStat {
  const path = String(item.path)
  return rowOf(parseEntry(item), path.slice(path.lastIndexOf('/') + 1))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checksum', () => {
  it('answers an LFS file its sha256 from one row', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([fileRow('w.bin', { lfs: LFS })])
    const listed = row(fileRow('w.bin', { lfs: LFS }))
    expect(await checksum(handle(), ps('w.bin'), 'sha256', listed)).toBe(SHA)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[2]).toEqual({ paths: ['w.bin'], expand: false })
  })

  it('asks the row again since the listing can be older', async () => {
    vi.spyOn(client, 'hubPost').mockResolvedValue([fileRow('w.bin', { lfs: LFS })])
    const listed = row(fileRow('w.bin', { lfs: { oid: 'b'.repeat(64) } }))
    expect(await checksum(handle(), ps('w.bin'), 'sha256', listed)).toBe(SHA)
  })

  it('reads a plain blob without a request', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([fileRow('a.txt')])
    expect(await checksum(handle(), ps('a.txt'), 'sha256', row(fileRow('a.txt')))).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it('reads a row no longer LFS', async () => {
    vi.spyOn(client, 'hubPost').mockResolvedValue([fileRow('w.bin')])
    const listed = row(fileRow('w.bin', { lfs: LFS }))
    expect(await checksum(handle(), ps('w.bin'), 'sha256', listed)).toBeNull()
  })

  it.each(['md5', 'sha1', 'sha512'])('reads %s without a request', async (algorithm) => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([])
    const listed = row(fileRow('w.bin', { lfs: LFS }))
    expect(await checksum(handle(), ps('w.bin'), algorithm, listed)).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it('reads a row gone since the listing', async () => {
    vi.spyOn(client, 'hubPost').mockResolvedValue([])
    const listed = row(fileRow('w.bin', { lfs: LFS }))
    expect(await checksum(handle(), ps('w.bin'), 'sha256', listed)).toBeNull()
  })

  it('raises as the read for a missing path and a directory', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([])
    const folder = row({ type: 'directory', oid: 'tree-d', size: 0, path: 'd' })
    expect(await codeOf(() => checksum(handle(), ps('nope'), 'sha256', null))).toBe('ENOENT')
    expect(await codeOf(() => checksum(handle(), ps('d'), 'sha256', folder))).toBe('EISDIR')
    expect(post).not.toHaveBeenCalled()
  })
})
