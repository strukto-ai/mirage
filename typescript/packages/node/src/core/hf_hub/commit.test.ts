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
import { LfsRequiredError, commit, commitUrl, payload, uploadModes } from './commit.ts'

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

describe('uploadModes', () => {
  it('sends a sample, not the content', async () => {
    const spy = vi
      .spyOn(client, 'hubPost')
      .mockResolvedValue({ files: [{ path: 'a.txt', uploadMode: 'regular' }] })
    const modes = await uploadModes(accessor(), [
      { path: 'a.txt', data: new Uint8Array(2000).fill(120) },
    ])
    const body = spy.mock.calls[0]?.[2] as { files: { sample: string; size: number }[] }
    const first = body.files[0] as { sample: string; size: number }
    expect(Buffer.from(first.sample, 'base64').length).toBe(512)
    expect(first.size).toBe(2000)
    expect(modes.get('a.txt')).toBe('regular')
    spy.mockRestore()
  })

  it('asks nothing for no additions', async () => {
    const spy = vi.spyOn(client, 'hubPost')
    expect((await uploadModes(accessor(), [])).size).toBe(0)
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
