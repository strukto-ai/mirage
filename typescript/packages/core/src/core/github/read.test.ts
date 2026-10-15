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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { entryAt } from '../../workspace/fixtures/handed.ts'
import { read, readStream } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { FakeGitHub, blobSha, servedAccessor } from './_test_util.ts'

const DEC = new TextDecoder()

function at(rel: string, prefix: string): PathSpec {
  const virtual = prefix === '/' ? `/${rel}` : `${prefix}/${rel}`
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resolved: false,
    vfsPath: rel,
  })
}

describe('a read against the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function serve(files: Record<string, string>): FakeGitHub {
    const gh = new FakeGitHub(files)
    vi.stubGlobal('fetch', gh.fetch)
    return gh
  }

  // A read is handed its row; with none, or a folder's, it asks nothing.
  it.each<[string, FileStat | null, string]>([
    ['src/gone.py', null, 'ENOENT'],
    ['src', new FileStat({ name: 'src', type: FileType.DIRECTORY }), 'EISDIR'],
    ['', null, 'EISDIR'],
  ])('asks nothing without a file row (%s)', async (rel, entry, code) => {
    const gh = serve({ 'src/a.txt': 'x' })
    await expect(read(servedAccessor(), at(rel, '/gh'), entry)).rejects.toMatchObject({ code })
    expect(gh.log).toEqual([])
  })

  // A mount at the root, one at /gh, and one named like a directory inside
  // the repository, so a record labelled with anything but the virtual path
  // lands on a key the cache never asks for.
  for (const prefix of ['/', '/gh', '/src']) {
    it(`records the blob sha under the virtual path (${prefix})`, async () => {
      const gh = serve({ 'src/a.txt': 'payload' })
      const path = at('src/a.txt', prefix)
      const accessor = servedAccessor()
      const row = await entryAt(readdir, accessor, path)
      const [data, records] = await runWithRecording(() => read(accessor, path, row))
      expect(DEC.decode(data)).toBe('payload')
      const sha = await blobSha('payload')
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', path.virtual, 'github', 7, sha],
      ])
      // The stamped token is the sha the blob was fetched by.
      expect(gh.log).toContainEqual(['blob', sha])
    })
  }

  it('records a stream once', async () => {
    serve({ 'a.txt': 'streamed' })
    const accessor = servedAccessor()
    const path = at('a.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    const [chunks, records] = await runWithRecording(async () => {
      const out: Uint8Array[] = []
      for await (const chunk of readStream(accessor, path, row)) out.push(chunk)
      return out
    })
    expect(chunks.map((c) => DEC.decode(c)).join('')).toBe('streamed')
    expect(records.map((r) => [r.op, r.fingerprint])).toEqual([['read', await blobSha('streamed')]])
  })

  it('stamps the sha it fetched, not a newer one', async () => {
    const gh = serve({ 'a.txt': 'old' })
    const accessor = servedAccessor()
    const path = at('a.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    gh.set('a.txt', 'reseated')
    // A later listing reseats the accessor's tree only.
    await readdir(accessor, at('', '/gh'))
    expect(accessor.tree['a.txt']?.sha).toBe(await blobSha('reseated'))
    gh.set('a.txt', 'live')
    const [data, records] = await runWithRecording(() => read(accessor, path, row))
    // Three shas are in play: the handed row's, the accessor tree's and the
    // live one. Only the first names the bytes this read returned.
    expect(DEC.decode(data)).toBe('old')
    expect(records.map((r) => r.fingerprint)).toEqual([await blobSha('old')])
    // The check that follows sees the live sha, which is not the one the read
    // stamped, so the copy it left is stale rather than fresh.
    const probe = await stat(accessor, path, null, new ListingCheckStore())
    expect(probe.fingerprint).toBe(await blobSha('live'))
    expect(probe.fingerprint).not.toBe(records[0]?.fingerprint)
  })
})
