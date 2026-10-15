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
import type * as ClientModule from './client.ts'

const graph = vi.hoisted(() => ({
  folders: {} as Record<string, string>,
  pages: [] as (Record<string, unknown>[] | Error)[],
}))

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return {
    ...actual,
    graphGet: (_config: unknown, url: string) => {
      if (url === `${DRIVE}/root/delta`) {
        return Promise.resolve({ value: [], '@odata.deltaLink': 'L0' })
      }
      if (url === `${DRIVE}/root`) return Promise.resolve({ id: 'R' })
      if (url.startsWith(`${DRIVE}/root:/`)) {
        const found = graph.folders[url.slice(`${DRIVE}/root:/`.length)]
        if (found === undefined)
          return Promise.reject(new actual.GraphError(404, 'itemNotFound', url))
        return Promise.resolve({ id: found })
      }
      const n = Number(url.slice(1))
      const page = graph.pages[n]
      if (page instanceof Error) return Promise.reject(page)
      return Promise.resolve({ value: page, '@odata.deltaLink': `L${String(n + 1)}` })
    },
  }
})

import { type Delta, FileChangeKind, PathSpec } from '../../types.ts'
import { GraphError } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'
import { GraphDeltaHook } from './watch.ts'

const DRIVE = 'https://graph.test/drives/d'
const ROOT = PathSpec.fromStrPath('/m', '')
const NEW = '2026-10-01T00:00:00Z'

function item(id: string, name: string, parent: string, facets: Record<string, unknown> = {}) {
  return {
    id,
    name,
    parentReference: { id: parent },
    createdDateTime: NEW,
    lastModifiedDateTime: NEW,
    ...facets,
  }
}

function hook(folder = ''): GraphDeltaHook {
  return new GraphDeltaHook(resolveMsGraphConfig({ accessToken: 't' }), () =>
    Promise.resolve([{ drive: DRIVE, folder, virtual: '/m' }]),
  )
}

function pairs(delta: Delta): [string, string][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

async function twoPulls(target: GraphDeltaHook): Promise<[Delta, Delta]> {
  const baseline = await target.pull(ROOT, null)
  const first = await target.pull(ROOT, baseline.checkpoint)
  const second = await target.pull(ROOT, first.checkpoint)
  return [first, second]
}

describe('GraphDeltaHook', () => {
  // Twin of test_a_child_listed_before_its_renamed_folder_lands_in_it.
  it('places a child listed before its renamed folder in that folder', async () => {
    graph.folders = {}
    graph.pages = [
      [item('F', 'Docs', 'R', { folder: {} })],
      [item('c', 'a.txt', 'F', { file: {} }), item('F', 'Papers', 'R', { folder: {} })],
    ]
    const [first, second] = await twoPulls(hook())
    expect(pairs(first)).toEqual([[FileChangeKind.CREATE, '/m/Docs']])
    expect(pairs(second)).toEqual([
      [FileChangeKind.CREATE, '/m/Papers/a.txt'],
      [FileChangeKind.DELETE, '/m/Docs'],
      [FileChangeKind.CREATE, '/m/Papers'],
    ])
  })

  // Twin of test_a_resync_forgets_every_place_it_kept.
  it('forgets every place it kept on a resync', async () => {
    graph.folders = {}
    graph.pages = [
      [item('F', 'Docs', 'R', { folder: {} })],
      new GraphError(410, 'resyncRequired', 'resync'),
    ]
    const [, second] = await twoPulls(hook())
    expect(pairs(second)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    const kept = (
      JSON.parse(second.checkpoint ?? '') as {
        graph: { drives: Record<string, { folders: object; seen: object; link: string }> }
      }
    ).graph.drives[DRIVE]
    expect(kept).toMatchObject({ folders: {}, seen: {}, link: 'L0' })
  })

  // Twin of test_a_root_folder_replaced_or_gone_is_found_again: the mount root
  // is a path, so a folder recreated there takes over, and one moved away
  // leaves the root unknown until something is there.
  it('finds a replaced or vanished root folder again', async () => {
    graph.folders = { Work: 'w1' }
    graph.pages = [[], [], []]
    const target = hook('Work')
    const baseline = await target.pull(ROOT, null)
    graph.folders.Work = 'w2'
    graph.pages[0] = [
      item('w1', 'Work', 'R', { deleted: {} }),
      item('w2', 'Work', 'R', { folder: {} }),
      item('x', 'x.txt', 'w2', { file: {} }),
    ]
    const replaced = await target.pull(ROOT, baseline.checkpoint)
    graph.folders = {}
    const gone = await target.pull(ROOT, replaced.checkpoint)
    graph.folders.Work = 'w3'
    const back = await target.pull(ROOT, gone.checkpoint)
    expect(pairs(replaced)).toEqual([
      [FileChangeKind.UNKNOWN, '/m'],
      [FileChangeKind.CREATE, '/m/x.txt'],
    ])
    expect(pairs(gone)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
    expect(pairs(back)).toEqual([[FileChangeKind.UNKNOWN, '/m']])
  })
})
