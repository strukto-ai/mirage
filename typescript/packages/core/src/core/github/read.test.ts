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
import type { Handed } from '../../vfs/types.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { read, readMany, readStream } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { FakeGitHub, blobSha, servedAccessor } from '../../../tests/core/github/_test_util.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { GitHubVFS } from '../../vfs/github/github.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

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

  // Twin of test_read_many_reads_a_batch_in_one_query_and_records_each.
  it('reads a batch in one query and records each file kept', async () => {
    const gh = serve({
      'a.txt': 'alpha\n',
      'b.txt': 'beta\r\n',
      'long.txt': 'x'.repeat(64),
    })
    gh.set('latin.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    gh.graphqlTextLimit = 32
    const accessor = servedAccessor()
    const paths = ['a.txt', 'b.txt', 'latin.txt', 'long.txt'].map((rel) => at(rel, '/gh'))
    const handed: Handed[] = []
    for (const path of paths) handed.push({ entry: await entryAt(readdir, accessor, path) })
    const [got, records] = await runWithRecording(() => readMany(accessor, paths, 1 << 20, handed))
    expect([...got].map(([path, data]) => [path, DEC.decode(data)])).toEqual([
      ['/gh/a.txt', 'alpha\n'],
      ['/gh/b.txt', 'beta\r\n'],
    ])
    expect([gh.count('graphql'), gh.count('blob')]).toEqual([1, 0])
    expect(records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([
      ['read', '/gh/a.txt', await blobSha('alpha\n')],
      ['read', '/gh/b.txt', await blobSha('beta\r\n')],
    ])
  })

  // Twin of test_read_many_asks_nothing_for_a_file_it_leaves_out.
  it('asks nothing for a file it leaves out', async () => {
    const gh = serve({ 'a.txt': 'alpha', 'src/b.txt': 'b' })
    const accessor = servedAccessor()
    const a = at('a.txt', '/gh')
    const src = at('src', '/gh')
    const handed = [
      { entry: await entryAt(readdir, accessor, a) },
      { entry: await entryAt(readdir, accessor, src) },
      {},
    ]
    expect((await readMany(accessor, [a, src, at('gone.txt', '/gh')], 4, handed)).size).toBe(0)
    expect(gh.count('graphql')).toBe(0)
  })

  // Twin of test_cat_reads_ahead_its_operands_in_one_query.
  it('lets cat read ahead its operands in one query', async () => {
    const gh = serve(
      Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [`${name}.txt`, `${name}\n`])),
    )
    const vfs = await GitHubVFS.create({
      token: 't',
      owner: 'o',
      repo: 'r',
      ref: 'main',
      baseUrl: gh.url,
    })
    const ws = new Workspace({ '/gh': vfs }, { shellParser: await getTestParser() })
    try {
      const result = await ws.shell('cat /gh/a.txt /gh/b.txt /gh/c.txt /gh/d.txt')
      expect(result.stdoutText).toBe('a\nb\nc\nd\n')
    } finally {
      await ws.close()
    }
    expect([gh.count('blob'), gh.count('graphql')]).toEqual([1, 1])
  })
})
