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

import { describe, expect, it, vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { COMMIT_CHUNK } from './constants.ts'
import { LfsRequiredError, commit, commitUrl, payload, preupload } from './commit.ts'

function accessor(): HfHubAccessor {
  return new HfHubAccessor({ repoId: 'acme/widget' } as never)
}

function lines(raw: Uint8Array): Record<string, unknown>[] {
  return new TextDecoder()
    .decode(raw)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const bytes = (text: string) => new TextEncoder().encode(text)

describe('commitUrl', () => {
  it('targets the mount revision', () => {
    expect(commitUrl(accessor())).toContain('/api/models/acme/widget/commit/main')
    expect(commitUrl(accessor(), 'dev')).toContain('/commit/dev')
  })

  it('encodes a revision holding a slash', () => {
    // Unencoded, `feature/foo` names revision `feature` and a subtree, so
    // the commit lands somewhere else or not at all.
    expect(commitUrl(accessor(), 'feature/foo')).toContain('/commit/feature%2Ffoo')
  })
})

describe('payload', () => {
  it('puts the header first', () => {
    expect(lines(payload([], [], 'msg', 'body'))[0]).toEqual({
      key: 'header',
      value: { summary: 'msg', description: 'body' },
    })
  })

  it('base64-encodes a file', () => {
    const row = lines(payload([{ path: 'a.txt', data: bytes('hi') }], [], 'm'))[1]
    const value = row?.value as Record<string, unknown>
    expect(row?.key).toBe('file')
    expect(value.encoding).toBe('base64')
    expect(Buffer.from(String(value.content), 'base64').toString()).toBe('hi')
  })

  it('spells a deletion as a deleted file', () => {
    expect(lines(payload([], ['a.txt'], 'm'))[1]).toEqual({
      key: 'deletedFile',
      value: { path: 'a.txt' },
    })
  })

  it('carries a parent commit only when given', () => {
    const withParent = lines(payload([], [], 'm', '', 'abc'))[0]?.value as Record<string, unknown>
    expect(withParent.parentCommit).toBe('abc')
    const without = lines(payload([], [], 'm'))[0]?.value as Record<string, unknown>
    expect(without.parentCommit).toBeUndefined()
  })
})

describe('preupload', () => {
  it('sends a sample, not the content', async () => {
    const spy = vi
      .spyOn(client, 'hubPost')
      .mockResolvedValue({ files: [{ path: 'a.txt', uploadMode: 'regular' }] })
    const modes = await preupload(accessor(), [
      { path: 'a.txt', data: new Uint8Array(2000).fill(120) },
    ])
    const body = spy.mock.calls[0]?.[2] as { files: { sample: string; size: number }[] }
    const first = body.files[0] as { sample: string; size: number }
    expect(Buffer.from(first.sample, 'base64').length).toBe(512)
    expect(first.size).toBe(2000)
    expect(modes.get('a.txt')).toEqual({ mode: 'regular', ignore: false })
    spy.mockRestore()
  })

  it.each([
    ['.gitignore', '# µ\n' + '*.bin\n'.repeat(100)],
    ['.gitignore', ''],
    ['sub/.gitignore', '*'],
  ])('sends root gitignore with every chunk (%s)', async (path, content) => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({ files: [] })
    const additions = Array.from({ length: COMMIT_CHUNK }, (_, i) => ({
      path: `part-${String(i)}`,
      data: bytes('x'),
    }))
    additions.push({ path, data: bytes(content) })
    await preupload(accessor(), additions)
    expect(post).toHaveBeenCalledTimes(2)
    for (const [, , body] of post.mock.calls) {
      if (path === '.gitignore') expect(body).toHaveProperty('gitIgnore', content)
      else expect(body).not.toHaveProperty('gitIgnore')
    }
    post.mockRestore()
  })

  it('asks nothing for no additions', async () => {
    const spy = vi.spyOn(client, 'hubPost')
    expect((await preupload(accessor(), [])).size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('commit', () => {
  it('refuses a file the Hub wants through LFS', async () => {
    // Committing it anyway would reference content the Hub never received:
    // the file would appear in the tree and every read of it would fail.
    const post = vi
      .spyOn(client, 'hubPost')
      .mockResolvedValue({ files: [{ path: 'big.bin', uploadMode: 'lfs' }] })
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({})
    await expect(
      commit(accessor(), { additions: [{ path: 'big.bin', data: bytes('x') }] }),
    ).rejects.toBeInstanceOf(LfsRequiredError)
    expect(ndjson).not.toHaveBeenCalled()
    post.mockRestore()
    ndjson.mockRestore()
  })

  it('posts ndjson for a regular file', async () => {
    const post = vi
      .spyOn(client, 'hubPost')
      .mockResolvedValue({ files: [{ path: 'a.txt', uploadMode: 'regular' }] })
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({ commitOid: 'abc' })
    const result = await commit(accessor(), {
      additions: [{ path: 'a.txt', data: bytes('hi') }],
    })
    expect(result).toEqual({ commitOid: 'abc' })
    expect(ndjson.mock.calls[0]?.[3]).toBeUndefined()
    post.mockRestore()
    ndjson.mockRestore()
  })

  it('can open a pull request', async () => {
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({})
    await commit(accessor(), { deletions: ['a.txt'], createPr: true })
    expect(ndjson.mock.calls[0]?.[3]).toEqual({ create_pr: '1' })
    ndjson.mockRestore()
  })

  it('skips the preupload probe for a delete-only commit', async () => {
    const post = vi.spyOn(client, 'hubPost')
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({})
    await commit(accessor(), { deletions: ['a.txt'] })
    expect(post).not.toHaveBeenCalled()
    post.mockRestore()
    ndjson.mockRestore()
  })
})

describe('unchanged uploads', () => {
  it.each([
    ['regular', bytes('hi'), '32f95c0d1244a78b2be1bab8de17906fabb2c4a8'],
    ['lfs', bytes('hi'), '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4'],
    ['lfs', new Uint8Array(), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
    [
      'regular',
      new Uint8Array([0, 255, ...new Uint8Array(600).fill(120)]),
      'e3e299f367bb91e875a9717da73dc05badb1fe7e',
    ],
  ] as const)('skips a commit for identical %s content', async (mode, data, oid) => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({
      files: [{ path: 'same', uploadMode: mode, oid }],
    })
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({})
    expect(await commit(accessor(), { additions: [{ path: 'same', data }] })).toBeUndefined()
    expect(ndjson).not.toHaveBeenCalled()
    post.mockRestore()
    ndjson.mockRestore()
  })

  it('keeps changed files and deletions', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({
      files: [
        { path: 'same', uploadMode: 'regular', oid: '32f95c0d1244a78b2be1bab8de17906fabb2c4a8' },
        { path: 'changed', uploadMode: 'regular', oid: 'old' },
        { path: 'new', uploadMode: 'regular' },
        { path: 'ignored', uploadMode: 'lfs', shouldIgnore: true },
      ],
    })
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({ commitOid: 'next' })
    await commit(accessor(), {
      additions: ['same', 'changed', 'new', 'ignored'].map((path) => ({ path, data: bytes('hi') })),
      deletions: ['obsolete'],
    })
    const body = ndjson.mock.calls[0]?.[2]
    if (body === undefined) throw new Error('Expected a commit request')
    const operations = lines(body).slice(1)
    expect(operations.map((op) => [op.key, (op.value as { path: string }).path])).toEqual([
      ['file', 'changed'],
      ['file', 'new'],
      ['deletedFile', 'obsolete'],
    ])
    post.mockRestore()
    ndjson.mockRestore()
  })

  it('does not cancel deletions when every addition is unchanged', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({
      files: [
        { path: 'same', uploadMode: 'regular', oid: '32f95c0d1244a78b2be1bab8de17906fabb2c4a8' },
      ],
    })
    const ndjson = vi.spyOn(client, 'hubPostNdjson').mockResolvedValue({ commitOid: 'next' })
    await commit(accessor(), {
      additions: [{ path: 'same', data: bytes('hi') }],
      deletions: ['obsolete'],
    })
    const body = ndjson.mock.calls[0]?.[2]
    if (body === undefined) throw new Error('Expected a commit request')
    expect(lines(body).slice(1)).toEqual([{ key: 'deletedFile', value: { path: 'obsolete' } }])
    post.mockRestore()
    ndjson.mockRestore()
  })
})
