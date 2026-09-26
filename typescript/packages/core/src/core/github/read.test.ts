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
import { GitHubAccessor } from '../../accessor/github.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { populateIndex, refillIndex } from './tree.ts'
import { read, stream } from './read.ts'
import type { GitHubTransport } from './client.ts'
import { FakeGitHub, blobSha, raceIndex, servedAccessor } from './_test_util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Probe {
  trees: number
  blobs: string[]
}

// The blob a given sha holds, so a read that used a stale row is visible as
// the wrong bytes rather than as an error.
const BLOBS: Record<string, string> = { bbb: 'one\n', ccc: 'two\n' }

function accessorFor(sha: string, probe: Probe): GitHubAccessor {
  const transport = {
    get: (path: string) => {
      if (path.includes('/git/trees/')) {
        probe.trees += 1
        return Promise.resolve({
          tree: [
            { path: 'src', type: 'tree' as const, sha: 'aaa' },
            { path: 'src/main.py', type: 'blob' as const, sha, size: 4 },
          ],
          truncated: false,
        })
      }
      const blobSha = path.slice(path.lastIndexOf('/') + 1)
      probe.blobs.push(blobSha)
      return Promise.resolve({
        content: Buffer.from(ENC.encode(BLOBS[blobSha] ?? '')).toString('base64'),
        encoding: 'base64',
      })
    },
  } as unknown as GitHubTransport
  return new GitHubAccessor({
    transport,
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
  })
}

async function seeded(sha: string): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await populateIndex(
    index,
    {
      src: { path: 'src', type: 'tree', sha: 'aaa', size: null },
      'src/main.py': { path: 'src/main.py', type: 'blob', sha, size: 4 },
    },
    '',
  )
  return index
}

function spec(p: string): PathSpec {
  return new PathSpec({ vfsPath: p.slice(1), virtual: p, directory: '/src' })
}

describe('github read freshness', () => {
  // The row survives an invalidation carrying the *pre-write* blob sha, so
  // trusting it served the old bytes. Freshness is tracked per directory,
  // so the parent listing is what says the row aged out.
  it('refetches the tree when the parent listing expired', async () => {
    const index = await seeded('bbb')
    await index.invalidate()
    const probe: Probe = { trees: 0, blobs: [] }
    const out = await read(accessorFor('ccc', probe), spec('/src/main.py'), index)
    expect(new TextDecoder().decode(out)).toBe('two\n')
    expect(probe.trees).toBe(1)
    expect(probe.blobs).toEqual(['ccc'])
  })

  it('trusts a live listing without refetching', async () => {
    const index = await seeded('bbb')
    const probe: Probe = { trees: 0, blobs: [] }
    const out = await read(accessorFor('ccc', probe), spec('/src/main.py'), index)
    expect(new TextDecoder().decode(out)).toBe('one\n')
    expect(probe.trees).toBe(0)
  })

  // A miss against a live index is a real absence. Refilling here would
  // spend a full recursive-tree fetch on every ENOENT.
  it('does not refetch on a real miss', async () => {
    const index = await seeded('bbb')
    const probe: Probe = { trees: 0, blobs: [] }
    await expect(read(accessorFor('ccc', probe), spec('/src/gone.py'), index)).rejects.toThrow()
    expect(probe.trees).toBe(0)
  })
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

describe('a read against the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function serve(files: Record<string, string>): FakeGitHub {
    const gh = new FakeGitHub(files)
    vi.stubGlobal('fetch', gh.fetch)
    return gh
  }

  // A mount at the root, one at /gh, and one named like a directory inside
  // the repository, so a record labelled with anything but the virtual path
  // lands on a key the cache never asks for.
  for (const prefix of ['/', '/gh', '/src']) {
    it(`records the blob sha under the virtual path (${prefix})`, async () => {
      const gh = serve({ 'src/a.txt': 'payload' })
      const path = at('src/a.txt', prefix)
      const [data, records] = await runWithRecording(() =>
        read(servedAccessor(), path, new RAMIndexCacheStore()),
      )
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
    const [chunks, records] = await runWithRecording(async () => {
      const out: Uint8Array[] = []
      for await (const chunk of stream(
        servedAccessor(),
        at('a.txt', '/gh'),
        new RAMIndexCacheStore(),
      ))
        out.push(chunk)
      return out
    })
    expect(chunks.map((c) => DEC.decode(c)).join('')).toBe('streamed')
    expect(records.map((r) => [r.op, r.fingerprint])).toEqual([['read', await blobSha('streamed')]])
  })

  for (const kind of ['list', 'stale', 'get', 'reseed'] as const) {
    it(`retries when the index changes under it (${kind})`, async () => {
      const gh = serve({ 'docs/sub/b.txt': 'bravo' })
      const index = raceIndex(kind)
      const accessor = servedAccessor()
      await refillIndex(accessor, index, '/gh')
      index.accessor = accessor
      index.fired = false
      gh.log.length = 0
      expect(DEC.decode(await read(accessor, at('docs/sub/b.txt', '/gh'), index))).toBe('bravo')
      expect(gh.counts()).toEqual([0, 1, 1])
    })
  }

  it('refills the mount index after a clear', async () => {
    const gh = serve({ 'docs/a.txt': 'alpha' })
    const index = new RAMIndexCacheStore()
    const accessor = servedAccessor()
    await refillIndex(accessor, index, '/gh')
    await index.clear()
    gh.log.length = 0
    expect(DEC.decode(await read(accessor, at('docs/a.txt', '/gh'), index))).toBe('alpha')
    // A read reseeds the listing rather than asking one directory, so the
    // stats after it are answered from the index again.
    expect(gh.counts()).toEqual([0, 1, 1])
    expect((await index.listDir('/gh')).status).not.toBe(LookupStatus.NOT_FOUND)
  })

  it('refuses a directory without fetching a blob', async () => {
    const gh = serve({ 'docs/a.txt': 'alpha' })
    await expect(
      read(servedAccessor(), at('docs', '/gh'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(gh.count('blob')).toBe(0)
  })

  it('answers ENOENT without an index', async () => {
    serve({ 'docs/a.txt': 'alpha' })
    await expect(read(servedAccessor(), at('docs/a.txt', '/gh'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('stamps the sha it fetched, not a newer one', async () => {
    const gh = serve({ 'a.txt': 'old' })
    const accessor = servedAccessor()
    const index = new RAMIndexCacheStore()
    await refillIndex(accessor, index, '/gh')
    gh.set('a.txt', 'reseated')
    // A refill on some other index reseats the accessor's tree only.
    await refillIndex(accessor, new RAMIndexCacheStore(), '/gh')
    expect(accessor.tree['a.txt']?.sha).toBe(await blobSha('reseated'))
    gh.set('a.txt', 'live')
    const [data, records] = await runWithRecording(() => read(accessor, at('a.txt', '/gh'), index))
    // Three shas are in play: the mount index's, the accessor tree's and the
    // live one. Only the first names the bytes this read returned.
    expect(DEC.decode(data)).toBe('old')
    expect(records.map((r) => r.fingerprint)).toEqual([await blobSha('old')])
  })
})
