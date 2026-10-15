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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { TrelloAccessor } from '../../accessor/trello.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { TrelloVFS } from '../../vfs/trello/trello.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TrelloTransport } from './client.ts'
import { normalizeWorkspace, toJsonBytes } from './normalize.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { boardInScope, filteredBoards, filteredWorkspaces, readdir } from './readdir.ts'

interface Call {
  method: string
  path: string
  params?: Record<string, string>
}

class FakeTransport implements TrelloTransport {
  public readonly calls: Call[] = []
  constructor(private readonly responder: (path: string) => unknown) {}
  call(method: string, path: string, params?: Record<string, string>): Promise<unknown> {
    this.calls.push({ method, path, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(path))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

// The account behind a mount at /mnt/trello, which lists each directory's
// parent to hand an entry lister the row it needs.
function mounted(accessor: TrelloAccessor): Workspace {
  const vfs = Object.assign(new TrelloVFS({ apiKey: 'k', apiToken: 't' }), { accessor })
  return new Workspace({ '/mnt/trello/': vfs })
}

async function listedAt(accessor: TrelloAccessor, virtual: string): Promise<string[]> {
  return (await mounted(accessor).dispatch('readdir', virtual)) as string[]
}

describe('trello readdir root', () => {
  it('returns workspaces virtual root', async () => {
    const t = new FakeTransport(() => [])
    const out = rowsOf(await readdir(new TrelloAccessor(t), spec('/mnt/trello', '/mnt/trello')))
    expect(out.map((row) => row.name)).toEqual(['workspaces'])
    expect(t.calls).toHaveLength(0)
  })
})

describe('trello readdir /workspaces', () => {
  it('lists workspaces with their ids', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') {
        return [
          { id: 'w1', displayName: 'Acme' },
          { id: 'w2', name: 'beta' },
        ]
      }
      return []
    })
    const out = rowsOf(
      await readdir(new TrelloAccessor(t), spec('/mnt/trello/workspaces', '/mnt/trello')),
    )
    expect(out.map((row) => row.name)).toEqual(['Acme__w1', 'beta__w2'])
    expect(out[0]?.extra.workspace_id).toBe('w1')
  })

  it('lists a workspace dir with a sized workspace.json', async () => {
    const ws = { id: 'w1', displayName: 'Acme' }
    const t = new FakeTransport(() => [ws])
    const out = await listedAt(new TrelloAccessor(t), '/mnt/trello/workspaces/Acme__w1')
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/workspace.json',
      '/mnt/trello/workspaces/Acme__w1/boards',
    ])
    const row = (await mounted(new TrelloAccessor(t)).dispatch(
      'stat',
      '/mnt/trello/workspaces/Acme__w1/workspace.json',
    )) as FileStat
    expect(row.size).toBe(toJsonBytes(normalizeWorkspace(ws)).byteLength)
  })

  it('filters by workspaceId', async () => {
    const t = new FakeTransport(() => [
      { id: 'w1', displayName: 'Acme' },
      { id: 'w2', displayName: 'Beta' },
    ])
    const out = await listedAt(
      new TrelloAccessor(t, { workspaceId: 'w2' }),
      '/mnt/trello/workspaces',
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Beta__w2'])
  })
})

describe('trello readdir /workspaces/<ws>', () => {
  it('returns workspace.json + boards children', async () => {
    const t = new FakeTransport(() => [{ id: 'w1', displayName: 'Acme' }])
    const out = await listedAt(new TrelloAccessor(t), '/mnt/trello/workspaces/Acme__w1')
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/workspace.json',
      '/mnt/trello/workspaces/Acme__w1/boards',
    ])
  })
})

describe('trello readdir boards', () => {
  it('lists boards with auto-bootstrap of workspace parent', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') {
        return [{ id: 'b1', name: 'Roadmap', dateLastActivity: '2025-01-01' }]
      }
      return []
    })
    const out = await listedAt(new TrelloAccessor(t), '/mnt/trello/workspaces/Acme__w1/boards')
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'])
    const row = (await mounted(new TrelloAccessor(t)).dispatch(
      'stat',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1',
    )) as FileStat
    expect(row.extra.board_id).toBe('b1')
    expect(row.modified).toBe('2025-01-01')
  })

  it('filters by boardIds', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') {
        return [
          { id: 'b1', name: 'Roadmap' },
          { id: 'b2', name: 'Other' },
        ]
      }
      return []
    })
    const out = await listedAt(
      new TrelloAccessor(t, { boardIds: ['b1'] }),
      '/mnt/trello/workspaces/Acme__w1/boards',
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'])
  })
})

describe('trello readdir board children', () => {
  it('returns board.json + members + labels + lists', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      return []
    })
    const out = await listedAt(
      new TrelloAccessor(t),
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1',
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/board.json',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/members',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/labels',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists',
    ])
  })
})

describe('trello readdir lists', () => {
  it('lists lists for a board', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      return []
    })
    const out = await listedAt(
      new TrelloAccessor(t),
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists',
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1'])
  })
})

describe('trello readdir cards', () => {
  it('lists cards under a list', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      if (path === '/lists/l1/cards') {
        return [{ id: 'c1', name: 'fix bug', dateLastActivity: '2025-01-02' }]
      }
      return []
    })
    const out = await listedAt(
      new TrelloAccessor(t),
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards',
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1',
    ])
  })

  it('entering a card dir reuses the traversal listings', async () => {
    // The old find chain re-fetched every ancestor listing per card dir,
    // which made a recursive walk quadratic in listing payloads.
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      if (path === '/lists/l1/cards') {
        return [
          { id: 'c1', name: 'one' },
          { id: 'c2', name: 'two' },
          { id: 'c3', name: 'three' },
        ]
      }
      return []
    })
    const ws = mounted(new TrelloAccessor(t))
    const listed = (await ws.dispatch(
      'readdir',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards',
    )) as string[]
    expect(listed).toHaveLength(3)
    for (const cardDir of listed) await ws.dispatch('readdir', cardDir)
    expect(t.calls.filter((c) => c.path === '/lists/l1/cards')).toHaveLength(1)
    expect(t.calls.filter((c) => c.path === '/members/me/organizations')).toHaveLength(1)
    expect(t.calls.filter((c) => c.path === '/organizations/w1/boards')).toHaveLength(1)
    expect(t.calls.filter((c) => c.path === '/boards/b1/lists')).toHaveLength(1)
  })

  it('returns card.json + comments.jsonl under a card', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      if (path === '/lists/l1/cards') return [{ id: 'c1', name: 'fix bug' }]
      return []
    })
    const out = await listedAt(
      new TrelloAccessor(t),
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1',
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/card.json',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/comments.jsonl',
    ])
  })
})

describe('trello readdir errors', () => {
  it('throws ENOENT for a workspace no listing carries', async () => {
    const t = new FakeTransport(() => [])
    await expect(
      listedAt(new TrelloAccessor(t), '/mnt/trello/workspaces/Acme__w1/boards'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('trello readdir unrecognized paths', () => {
  it('throws ENOENT rather than reporting an empty directory', async () => {
    // Returning [] made `ls` and `tree` report a bogus path as real-but-empty,
    // and left `rg` without a message.
    const t = new FakeTransport(() => [])
    await expect(readdir(new TrelloAccessor(t), spec('/__nf_missing__'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for an unrecognized nested path', async () => {
    const t = new FakeTransport(() => [])
    await expect(
      readdir(new TrelloAccessor(t), spec('/workspaces/w/nope/deeper')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// Mirrors python's test_board_in_scope_* and
// test_filtered_boards_and_workspaces_apply_both_knobs.
describe('trello board scope', () => {
  it('admits every id on an unnarrowed mount without a call', async () => {
    const t = new FakeTransport(() => ({}))
    expect(await boardInScope(new TrelloAccessor(t), 'b_any')).toBe(true)
    expect(t.calls).toHaveLength(0)
  })

  it('holds an id to boardIds without a call', async () => {
    const t = new FakeTransport(() => ({}))
    const accessor = new TrelloAccessor(t, { boardIds: ['b_in'] })
    expect(await boardInScope(accessor, 'b_in')).toBe(true)
    expect(await boardInScope(accessor, 'b_out')).toBe(false)
    expect(await boardInScope(accessor, '')).toBe(false)
    expect(t.calls).toHaveLength(0)
  })

  it('holds an id to workspaceId', async () => {
    const t = new FakeTransport((path) =>
      path === '/boards/b_in'
        ? { id: 'b_in', idOrganization: 'ws1' }
        : { id: 'b_out', idOrganization: 'ws2' },
    )
    const accessor = new TrelloAccessor(t, { workspaceId: 'ws1' })
    expect(await boardInScope(accessor, 'b_in')).toBe(true)
    expect(await boardInScope(accessor, 'b_out')).toBe(false)
  })

  it('filters workspaces and boards by both knobs', async () => {
    const t = new FakeTransport((path) =>
      path === '/members/me/organizations'
        ? [{ id: 'ws1' }, { id: 'ws2' }]
        : [{ id: 'b1' }, { id: 'b2' }],
    )
    const accessor = new TrelloAccessor(t, { workspaceId: 'ws1', boardIds: ['b1'] })
    expect(await filteredWorkspaces(accessor)).toEqual([{ id: 'ws1' }])
    expect(await filteredBoards(accessor, 'ws1')).toEqual([{ id: 'b1' }])
  })
})
