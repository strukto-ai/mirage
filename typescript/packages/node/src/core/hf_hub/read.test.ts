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

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as client from './client.ts'
import { read, rowToken } from './read.ts'
import * as repo from './repo.ts'
import { parseEntry, rowOf } from './tree.ts'
import { codeOf, handle, ps, rowAt, walking } from './_test_util.ts'

const PATH = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
// The row the listing of /m/m names for k.txt.
const K_ROW = rowOf(parseEntry({ type: 'file', oid: 'oid-k', size: 5, path: 'm/k.txt' }), 'k.txt')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hf_hub read', () => {
  it('never reaches the network for a path the listing knows is absent', async () => {
    const spy = vi.spyOn(client, 'hubBytesTagged')
    expect(await codeOf(() => read(handle(), ps('nope'), {}, null))).toBe('ENOENT')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports EISDIR for a directory and for the mount root', async () => {
    const folder = new FileStat({ name: 'd', type: FileType.DIRECTORY })
    expect(await codeOf(() => read(handle(), ps('d'), {}, folder))).toBe('EISDIR')
    expect(await codeOf(() => read(handle(), ps(''), {}, null))).toBe('EISDIR')
  })

  it('fetches the resolve url', async () => {
    const spy = vi
      .spyOn(client, 'hubBytesTagged')
      .mockResolvedValue([new TextEncoder().encode('hello'), ''])
    const data = await read(handle(), ps('a.txt'), {}, K_ROW)
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(spy.mock.calls[0]?.[1]).toBe('https://huggingface.co/acme/widget/resolve/main/a.txt')
    expect(spy.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('passes a byte window', async () => {
    const spy = vi.spyOn(client, 'hubBytesTagged').mockResolvedValue([new Uint8Array(2), ''])
    await read(handle(), ps('a.txt'), { offset: 0, size: 2 }, K_ROW)
    expect(spy.mock.calls[0]?.[2]).toEqual({ offset: 0, size: 2 })
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('hf_hub read record path', () => {
  it('records the virtual path', async () => {
    vi.spyOn(client, 'hubBytesTagged').mockResolvedValue([new TextEncoder().encode('hello'), ''])
    const [data, records] = await runWithRecording(() => read(handle(), PATH, {}, K_ROW))
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

// One row whose four ids all differ, and none is a hash of the content, so
// every accepted ETag is distinguishable from every other and from a guess.
const ROW = new FileStat({
  name: 'f.bin',
  type: FileType.FILE,
  fingerprint: 'O',
  extra: { oid: 'O', lfs_oid: 'L', xet_hash: 'X', last_commit: 'C' },
})
// The common case: a plain git file carries its oid and nothing else.
const PLAIN = new FileStat({
  name: 'a.txt',
  type: FileType.FILE,
  fingerprint: 'P',
  extra: { oid: 'P' },
})
// A row that carries the LFS and Xet keys empty: a missing ETag must not match
// one of them.
const BLANK = new FileStat({
  name: 'a.txt',
  type: FileType.FILE,
  fingerprint: 'P',
  extra: { oid: 'P', lfs_oid: '', xet_hash: '' },
})

describe('rowToken', () => {
  it.each([
    [ROW, '"O"', 'O'],
    [ROW, 'L', 'O'],
    [ROW, 'W/"X"', 'O'],
    [ROW, '"Z"', null],
    [ROW, '', null],
    [ROW, '"C"', null],
    [PLAIN, '"P"', 'P'],
    [PLAIN, '', null],
    [PLAIN, '"Z"', null],
    [BLANK, '', null],
  ])('stamps the oid only when the etag names the row (%#)', (entry, etag, expected) => {
    expect(rowToken(entry, etag)).toBe(expected)
  })

  it('never stamps an empty id', () => {
    // The ETag matches, so this takes the match branch; an empty id must
    // still come back as no token rather than ''.
    const entry = new FileStat({ name: 'f', type: FileType.FILE, extra: { lfs_oid: 'L' } })
    expect(rowToken(entry, '"L"')).toBeNull()
  })
})

describe('hf_hub read stamp', () => {
  it('stamps the oid when the etag names the row', async () => {
    vi.spyOn(client, 'hubBytesTagged').mockResolvedValue([
      new TextEncoder().encode('hello'),
      '"oid-k"',
    ])
    const [, records] = await runWithRecording(() => read(handle(), PATH, {}, K_ROW))
    expect(records.map((r) => r.fingerprint)).toEqual(['oid-k'])
  })

  it('stamps nothing when the bytes are another version', async () => {
    // The listing says oid-k, the download is a newer version: labelling
    // those bytes with the listing's oid is how a later revert would pass
    // them off as fresh.
    vi.spyOn(client, 'hubBytesTagged').mockResolvedValue([
      new TextEncoder().encode('newer'),
      '"another-version"',
    ])
    const [, records] = await runWithRecording(() => read(handle(), PATH, {}, K_ROW))
    expect(records.map((r) => r.fingerprint)).toEqual([null])
  })
})

describe('a read the Hub refuses', () => {
  it('is permission denied', async () => {
    // The listing that would hand the read its row is refused.
    vi.spyOn(repo, 'headCommit').mockResolvedValue('')
    const walker = walking()
    vi.mocked(client.hubGetResponse).mockRejectedValue(new client.HfHubError('nope', 403))
    expect(await codeOf(() => rowAt(walker, ps('a.txt')))).toBe('EACCES')
  })
})

describe('a download the Hub refuses', () => {
  it.each([401, 403])('is permission denied for %i', async (status) => {
    // A gated repo lists its tree but refuses the file itself.
    vi.spyOn(client, 'hubBytesTagged').mockRejectedValue(new client.HfHubError('gated', status))
    expect(await codeOf(() => read(handle(), PATH, {}, K_ROW))).toBe('EACCES')
  })

  it('keeps a vanished file a hub error', async () => {
    // One file 404ing is not a refusal to show the repo.
    vi.spyOn(client, 'hubBytesTagged').mockRejectedValue(
      new client.HfHubError('gone', 404, 'EntryNotFound'),
    )
    const err = await read(handle(), PATH, {}, K_ROW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(client.HfHubError)
  })
})
