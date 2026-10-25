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
import type * as ClientModule from '../../core/chroma/client.ts'

vi.mock('../../core/chroma/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../core/chroma/client.ts')
  return { ...actual, fetchPathTree: vi.fn() }
})

import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import * as clientMod from '../../core/chroma/client.ts'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy, type FileStat } from '../../types.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { ChromaVFS } from './chroma.ts'

describe('chroma dispatcher under read: fresh', () => {
  // chroma lists from one tree document, so a refused listing refetches the
  // whole tree. A burst through the dispatcher belongs to no shell command;
  // fresh trusts its own refill for the window instead of refetching per call.
  it('fetches the tree once for a burst', async () => {
    const fetch = vi.mocked(clientMod.fetchPathTree)
    fetch.mockResolvedValue(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, n) => [
            `guides/g${String(n)}`,
            { size: 1, created_at: null, updated_at: null },
          ]),
        ),
      ),
    )
    const vfs = new ChromaVFS({ collectionName: 'docs' })
    const empty = { get: () => Promise.resolve({ documents: [], metadatas: [] }) }
    vi.spyOn(vfs.accessor, 'getCollection').mockResolvedValue(
      empty as unknown as Awaited<ReturnType<typeof vfs.accessor.getCollection>>,
    )
    const ws = new Workspace({
      '/knowledge': new Mount(vfs, {
        mode: MountMode.READ,
        read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
      }),
    })
    try {
      const names = await ws.readdir('/knowledge/guides')
      expect(names).toHaveLength(5)
      for (const name of names) await ws.stat(name)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await ws.close()
    }
  })
})

describe('chroma stat through a mount', () => {
  // A listing leaves pages unsized; the first stat in a folder sizes every
  // page in it with one scan, and the rest answer from the sized rows.
  it('sizes a folder with one scan', async () => {
    vi.mocked(clientMod.fetchPathTree).mockResolvedValue(
      JSON.stringify({ 'guides/a': {}, 'guides/b': {}, 'guides/c': {} }),
    )
    const vfs = new ChromaVFS({ collectionName: 'docs' })
    const scans: unknown[] = []
    const collection = {
      get: (args: unknown) => {
        scans.push(args)
        return Promise.resolve({ documents: [], metadatas: [] })
      },
    }
    vi.spyOn(vfs.accessor, 'getCollection').mockResolvedValue(
      collection as unknown as Awaited<ReturnType<typeof vfs.accessor.getCollection>>,
    )
    const ws = new Workspace({ '/knowledge': new Mount(vfs, { mode: MountMode.READ }) })
    try {
      const names = await ws.readdir('/knowledge/guides')
      for (const name of names) expect(((await ws.stat(name)) as FileStat).size).toBe(0)
      expect(scans).toHaveLength(1)
    } finally {
      await ws.close()
    }
  })
})

describe('chroma-query refusals', () => {
  it.each([
    [
      'chroma-query --top-k many refunds /knowledge',
      "chroma-query: invalid int value: 'many' for '--top-k'\n" +
        "Try 'chroma-query --help' for more information.\n",
    ],
    [
      'chroma-query --bogus refunds /knowledge',
      "chroma-query: unrecognized option '--bogus'\n" +
        "Try 'chroma-query --help' for more information.\n",
    ],
    ['chroma-query --top-k 0 refunds /knowledge', 'search: top-k must be positive\n'],
    [
      'chroma-query --method keyword refunds /knowledge',
      "search: only the 'semantic' method is supported\n",
    ],
  ])('refuses %s before asking chroma', async (cmd, stderr) => {
    const vfs = new ChromaVFS({ collectionName: 'docs' })
    const asked = vi.spyOn(vfs.accessor, 'getCollection')
    const ws = new Workspace(
      { '/knowledge': new Mount(vfs, { mode: MountMode.READ }) },
      { shellParser: await getTestParser() },
    )
    try {
      const result = await ws.shell(cmd)
      expect(result.exitCode).toBe(2)
      expect(result.stderrText).toBe(stderr)
      expect(asked).not.toHaveBeenCalled()
    } finally {
      await ws.close()
    }
  })
})
