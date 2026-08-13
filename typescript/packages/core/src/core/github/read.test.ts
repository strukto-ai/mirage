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
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { populateIndex } from './tree.ts'
import { read } from './read.ts'
import type { GitHubTransport } from './_client.ts'

const ENC = new TextEncoder()

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
            { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
            { path: 'src/main.py', mode: '100644', type: 'blob', sha, size: 4 },
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
  await populateIndex(index, [
    { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
    { path: 'src/main.py', mode: '100644', type: 'blob', sha, size: 4 },
  ])
  return index
}

function spec(p: string): PathSpec {
  return new PathSpec({ resourcePath: p.slice(1), virtual: p, directory: '/src' })
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
