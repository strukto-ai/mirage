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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { recordingScope } from '../../observe/context.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { read, readMany, readStream } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { GRAPHQL, GitHubRepo, TOKEN, blobSha } from '../../../tests/core/github/repo.ts'
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'
import { GitHubVFS } from '../../vfs/github/github.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()
const FETCH = globalThis.fetch

let origin: string
let repo: GitHubRepo

beforeAll(async () => {
  origin = await serve('github')
})

beforeEach(() => {
  repo = new GitHubRepo(origin)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await repo.run.close()
})

function at(rel: string, prefix: string): PathSpec {
  const virtual = prefix === '/' ? `/${rel}` : `${prefix}/${rel}`
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resolved: false,
    vfsPath: rel,
  })
}

// github.com's API and raw hosts, reached on the fake's run instead: the
// accessor names them itself, so only the network under it is rerouted.
function onGithubCom(): void {
  const api = 'https://api.github.com'
  const raw = 'https://raw.githubusercontent.com'
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const routed = url.startsWith(raw)
      ? `${repo.run.url}/raw${url.slice(raw.length)}`
      : url.startsWith(api)
        ? `${repo.run.url}${url.slice(api.length)}`
        : url
    return FETCH(input instanceof Request ? new Request(routed, input) : routed, init)
  })
}

function anonymous(baseUrl?: string): GitHubAccessor {
  return new GitHubAccessor({
    account: new GitHubAccount(baseUrl === undefined ? {} : { baseUrl }),
    owner: repo.owner,
    repo: repo.name,
    ref: 'main',
    defaultBranch: 'main',
  })
}

describe('a read against the wire', () => {
  // A read is handed its row; with none, or a folder's, it asks nothing.
  it.each<[string, FileStat | null, string]>([
    ['src/gone.py', null, 'ENOENT'],
    ['src', new FileStat({ name: 'src', type: FileType.DIRECTORY }), 'EISDIR'],
    ['', null, 'EISDIR'],
  ])('asks nothing without a file row (%s)', async (rel, entry, code) => {
    await repo.create({ 'src/a.txt': 'x' })
    await expect(read(repo.accessor(), at(rel, '/gh'), entry)).rejects.toMatchObject({ code })
    expect(await repo.log()).toEqual([])
  })

  // A mount at the root, one at /gh, and one named like a directory inside
  // the repository, so a record labelled with anything but the virtual path
  // lands on a key the cache never asks for.
  for (const prefix of ['/', '/gh', '/src']) {
    it(`records the blob sha under the virtual path (${prefix})`, async () => {
      await repo.create({ 'src/a.txt': 'payload' })
      const path = at('src/a.txt', prefix)
      const accessor = repo.accessor()
      const row = await entryAt(readdir, accessor, path)
      const [data, records] = await recordingScope(() => read(accessor, path, row))
      expect(DEC.decode(data)).toBe('payload')
      const sha = blobSha('payload')
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', path.virtual, 'github', 7, sha],
      ])
      // The stamped token is the sha the blob was fetched by.
      expect(await repo.log()).toContainEqual(['blob', sha])
    })
  }

  it('records a stream once', async () => {
    await repo.create({ 'a.txt': 'streamed' })
    const accessor = repo.accessor()
    const path = at('a.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    const [chunks, records] = await recordingScope(async () => {
      const out: Uint8Array[] = []
      for await (const chunk of readStream(accessor, path, row)) out.push(chunk)
      return out
    })
    expect(chunks.map((c) => DEC.decode(c)).join('')).toBe('streamed')
    expect(records.map((r) => [r.op, r.fingerprint])).toEqual([['read', blobSha('streamed')]])
  })

  it('stamps the sha it fetched, not a newer one', async () => {
    await repo.create({ 'a.txt': 'old' })
    const accessor = repo.accessor()
    const path = at('a.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    await repo.commit({ 'a.txt': 'reseated' })
    // A later listing reseats the accessor's tree only.
    await readdir(accessor, at('', '/gh'))
    expect(accessor.tree['a.txt']?.sha).toBe(blobSha('reseated'))
    await repo.commit({ 'a.txt': 'live' })
    const [data, records] = await recordingScope(() => read(accessor, path, row))
    // Three shas are in play: the handed row's, the accessor tree's and the
    // live one. Only the first names the bytes this read returned.
    expect(DEC.decode(data)).toBe('old')
    expect(records.map((r) => r.fingerprint)).toEqual([blobSha('old')])
    // The check that follows sees the live sha, which is not the one the read
    // stamped, so the copy it left is stale rather than fresh.
    const probe = await stat(accessor, path, null, new ListingCheckStore())
    expect(probe.fingerprint).toBe(blobSha('live'))
    expect(probe.fingerprint).not.toBe(records[0]?.fingerprint)
  })

  // Twin of test_read_many_reads_a_batch_in_one_query_and_records_each: bytes
  // that are not UTF-8 come back with no text, so that file is left to its
  // own read.
  it('reads a batch in one query and records each file kept', async () => {
    await repo.create({
      'a.txt': 'alpha\n',
      'b.txt': 'beta\r\n',
      'latin.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    })
    const accessor = repo.accessor()
    const paths = ['a.txt', 'b.txt', 'latin.txt'].map((rel) => at(rel, '/gh'))
    const handed: Handed[] = []
    for (const path of paths) handed.push({ entry: await entryAt(readdir, accessor, path) })
    const [got, records] = await recordingScope(() => readMany(accessor, paths, 1 << 20, handed))
    expect([...got].map(([path, data]) => [path, DEC.decode(data)])).toEqual([
      ['/gh/a.txt', 'alpha\n'],
      ['/gh/b.txt', 'beta\r\n'],
    ])
    expect([await repo.count('graphql'), await repo.count('blob')]).toEqual([1, 0])
    expect(records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([
      ['read', '/gh/a.txt', blobSha('alpha\n')],
      ['read', '/gh/b.txt', blobSha('beta\r\n')],
    ])
  })

  // Twin of test_read_many_leaves_out_text_cut_short_or_not_its_bytes: only
  // text whose own sha is the row's is kept. The fake answers every blob
  // whole, so the batch's answer is GitHub's with two blobs changed, one
  // alias per file in the order they were asked.
  it('leaves out text cut short or not its bytes', async () => {
    await repo.create({ 'a.txt': 'alpha\n', 'long.txt': 'x'.repeat(64), 'latin.txt': 'caf' })
    const accessor = repo.accessor()
    const paths = ['a.txt', 'long.txt', 'latin.txt'].map((rel) => at(rel, '/gh'))
    const handed: Handed[] = []
    for (const path of paths) handed.push({ entry: await entryAt(readdir, accessor, path) })
    await repo.run.answerNext('POST', GRAPHQL, 200, {
      data: {
        repository: {
          f0: { text: 'alpha\n', isTruncated: false },
          f1: { text: 'x'.repeat(32), isTruncated: true },
          f2: { text: 'caf�', isTruncated: false },
        },
      },
    })
    const got = await readMany(accessor, paths, 1 << 20, handed)
    expect([...got].map(([path, data]) => [path, DEC.decode(data)])).toEqual([
      ['/gh/a.txt', 'alpha\n'],
    ])
  })

  // Twin of test_read_many_asks_nothing_for_a_file_it_leaves_out.
  it('asks nothing for a file it leaves out', async () => {
    await repo.create({ 'a.txt': 'alpha', 'src/b.txt': 'b' })
    const accessor = repo.accessor()
    const a = at('a.txt', '/gh')
    const src = at('src', '/gh')
    const handed = [
      { entry: await entryAt(readdir, accessor, a) },
      { entry: await entryAt(readdir, accessor, src) },
      {},
    ]
    expect((await readMany(accessor, [a, src, at('gone.txt', '/gh')], 4, handed)).size).toBe(0)
    expect(await repo.count('graphql')).toBe(0)
  })

  // Twin of test_cat_reads_ahead_its_operands_in_one_query.
  it('lets cat read ahead its operands in one query', async () => {
    await repo.create(
      Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [`${name}.txt`, `${name}\n`])),
    )
    const vfs = await GitHubVFS.create({
      token: TOKEN,
      owner: repo.owner,
      repo: repo.name,
      ref: 'main',
      baseUrl: repo.run.url,
    })
    const ws = new Workspace({ '/gh': vfs })
    try {
      const result = await ws.shell('cat /gh/a.txt /gh/b.txt /gh/c.txt /gh/d.txt')
      expect(result.stdoutText).toBe('a\nb\nc\nd\n')
    } finally {
      await ws.close()
    }
    expect([await repo.count('blob'), await repo.count('graphql')]).toEqual([1, 1])
  })
})

async function noCredentialSent(): Promise<void> {
  const listed = await repo.run.call<{ requests: { headers: Record<string, string> }[] }>(
    'GET',
    '/_kit/requests',
  )
  expect(listed.requests.length).toBeGreaterThan(0)
  expect(listed.requests.every((r) => Object.keys(r.headers).length === 0)).toBe(true)
}

describe('an anonymous read', () => {
  // Twin of test_an_anonymous_read_downloads_the_file_at_the_listed_commit:
  // with no credential on github.com each blob request would spend one of the
  // 60 an hour the REST API allows, so a file is downloaded instead, at the
  // commit its listing named even after the branch moved on.
  it('downloads the file at the listed commit', async () => {
    const listed = await repo.create({ 'src/a b.txt': 'payload' })
    await repo.run.recordRequests('authorization')
    onGithubCom()
    const accessor = anonymous()
    const path = at('src/a b.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    await repo.commit({ 'src/a b.txt': 'moved on' })
    const [[data, streamed], records] = await recordingScope(async () => {
      const whole = await read(accessor, path, row)
      const chunks: Uint8Array[] = []
      for await (const chunk of readStream(accessor, path, row)) chunks.push(chunk)
      return [whole, chunks] as const
    })
    expect(DEC.decode(data)).toBe('payload')
    expect(streamed.map((c) => DEC.decode(c)).join('')).toBe('payload')
    const sha = blobSha('payload')
    expect(records.map((r) => r.fingerprint)).toEqual([sha, sha])
    const log = await repo.log()
    expect(log.filter(([name]) => name === 'blob')).toHaveLength(0)
    expect(
      log.filter(([name, raw]) => name === 'raw' && raw === `${listed}/src/a b.txt`),
    ).toHaveLength(2)
    await noCredentialSent()
  })

  // Twin of test_an_anonymous_read_of_an_older_row_asks_its_blob.
  it('asks the blob of a row the listed tree no longer holds', async () => {
    await repo.create({ 'a.txt': 'old' })
    onGithubCom()
    const accessor = anonymous()
    const path = at('a.txt', '/gh')
    const row = await entryAt(readdir, accessor, path)
    await repo.commit({ 'a.txt': 'new' })
    await readdir(accessor, at('', '/gh'))
    expect(DEC.decode(await read(accessor, path, row))).toBe('old')
    expect([await repo.count('blob'), await repo.count('raw')]).toEqual([1, 0])
  })

  // Twin of test_a_read_off_github_com_or_with_a_token_asks_the_blob.
  it.each(['enterprise', 'token'])(
    'asks the blob off github.com or with a token (%s)',
    async (kind) => {
      await repo.create({ 'a.txt': 'x' })
      let accessor: GitHubAccessor
      if (kind === 'token') {
        onGithubCom()
        accessor = new GitHubAccessor({
          account: new GitHubAccount({ token: TOKEN }),
          owner: repo.owner,
          repo: repo.name,
          ref: 'main',
          defaultBranch: 'main',
        })
      } else {
        accessor = anonymous(repo.run.url)
      }
      const path = at('a.txt', '/gh')
      const row = await entryAt(readdir, accessor, path)
      expect(DEC.decode(await read(accessor, path, row))).toBe('x')
      expect([await repo.count('blob'), await repo.count('raw')]).toEqual([1, 0])
    },
  )

  // Twin of test_an_anonymous_read_many_asks_nothing: GraphQL refuses a call
  // with no credential, so a batch leaves each file to its own read.
  it('reads no batch', async () => {
    await repo.create({ 'a.txt': 'alpha' })
    onGithubCom()
    const accessor = anonymous()
    const path = at('a.txt', '/gh')
    const handed = [{ entry: await entryAt(readdir, accessor, path) }]
    expect((await readMany(accessor, [path], 1 << 20, handed)).size).toBe(0)
    expect(await repo.count('graphql')).toBe(0)
  })

  // Twin of test_cat_reads_a_public_repository_with_no_credential.
  it('lets cat read a public repository with no credential', async () => {
    await repo.create(
      Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [`${name}.txt`, `${name}\n`])),
    )
    await repo.run.recordRequests('authorization')
    onGithubCom()
    const vfs = await GitHubVFS.create({ owner: repo.owner, repo: repo.name })
    const ws = new Workspace({ '/gh': vfs })
    try {
      const result = await ws.shell('cat /gh/a.txt /gh/b.txt /gh/c.txt /gh/d.txt')
      expect(result.stdoutText).toBe('a\nb\nc\nd\n')
    } finally {
      await ws.close()
    }
    expect([
      await repo.count('blob'),
      await repo.count('graphql'),
      await repo.count('raw'),
    ]).toEqual([0, 0, 4])
    await noCredentialSent()
  })
})
