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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TrelloTransport } from './_client.ts'
import { readdir } from './readdir.ts'

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
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('trello readdir root', () => {
  it('returns workspaces virtual root', async () => {
    const t = new FakeTransport(() => [])
    const out = await readdir(new TrelloAccessor(t), spec('/mnt/trello', '/mnt/trello'))
    expect(out).toEqual(['/mnt/trello/workspaces'])
    expect(t.calls).toHaveLength(0)
  })
})

describe('trello readdir /workspaces', () => {
  it('lists workspaces and populates index', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') {
        return [
          { id: 'w1', displayName: 'Acme' },
          { id: 'w2', name: 'beta' },
        ]
      }
      return []
    })
    const idx = new RAMIndexCacheStore()
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces', '/mnt/trello'),
      idx,
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1', '/mnt/trello/workspaces/beta__w2'])
    const lookup = await idx.get('/mnt/trello/workspaces/Acme__w1')
    expect(lookup.entry?.id).toBe('w1')
    expect(lookup.entry?.resourceType).toBe('trello/workspace')
  })

  it('filters by workspaceId', async () => {
    const t = new FakeTransport(() => [
      { id: 'w1', displayName: 'Acme' },
      { id: 'w2', displayName: 'Beta' },
    ])
    const idx = new RAMIndexCacheStore()
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces', '/mnt/trello'),
      idx,
      { workspaceId: 'w2' },
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Beta__w2'])
  })

  it('returns from index cache without API call', async () => {
    const idx = new RAMIndexCacheStore()
    const t1 = new FakeTransport(() => [{ id: 'w1', displayName: 'Acme' }])
    await readdir(new TrelloAccessor(t1), spec('/mnt/trello/workspaces', '/mnt/trello'), idx)
    const t2 = new FakeTransport(() => {
      throw new Error('should not be called')
    })
    const out = await readdir(
      new TrelloAccessor(t2),
      spec('/mnt/trello/workspaces', '/mnt/trello'),
      idx,
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1'])
    expect(t2.calls).toHaveLength(0)
  })
})

describe('trello readdir /workspaces/<ws>', () => {
  it('returns workspace.json + boards children', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport(() => [{ id: 'w1', displayName: 'Acme' }])
    await readdir(new TrelloAccessor(t), spec('/mnt/trello/workspaces', '/mnt/trello'), idx)
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1', '/mnt/trello'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/workspace.json',
      '/mnt/trello/workspaces/Acme__w1/boards',
    ])
  })
})

describe('trello readdir boards', () => {
  it('lists boards with auto-bootstrap of workspace parent', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') {
        return [{ id: 'b1', name: 'Roadmap', dateLastActivity: '2025-01-01' }]
      }
      return []
    })
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/boards', '/mnt/trello'),
      idx,
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'])
    const lookup = await idx.get('/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1')
    expect(lookup.entry?.id).toBe('b1')
    expect(lookup.entry?.remoteTime).toBe('2025-01-01')
  })

  it('filters by boardIds', async () => {
    const idx = new RAMIndexCacheStore()
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
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/boards', '/mnt/trello'),
      idx,
      { boardIds: ['b1'] },
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'])
  })
})

describe('trello readdir board children', () => {
  it('returns board.json + members + labels + lists', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      return []
    })
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1', '/mnt/trello'),
      idx,
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
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      return []
    })
    const out = await readdir(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists', '/mnt/trello'),
      idx,
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1'])
  })
})

describe('trello readdir cards', () => {
  it('lists cards under a list', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      if (path === '/lists/l1/cards') {
        return [{ id: 'c1', name: 'fix bug', dateLastActivity: '2025-01-02' }]
      }
      return []
    })
    const out = await readdir(
      new TrelloAccessor(t),
      spec(
        '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards',
        '/mnt/trello',
      ),
      idx,
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1',
    ])
  })

  it('returns card.json + comments.jsonl under a card', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: 'Roadmap' }]
      if (path === '/boards/b1/lists') return [{ id: 'l1', name: 'Doing' }]
      if (path === '/lists/l1/cards') return [{ id: 'c1', name: 'fix bug' }]
      return []
    })
    const out = await readdir(
      new TrelloAccessor(t),
      spec(
        '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1',
        '/mnt/trello',
      ),
      idx,
    )
    expect(out).toEqual([
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/card.json',
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/comments.jsonl',
    ])
  })
})

describe('trello readdir errors', () => {
  it('throws ENOENT when no index for workspace lookup', async () => {
    const t = new FakeTransport(() => [])
    await expect(
      readdir(new TrelloAccessor(t), spec('/mnt/trello/workspaces/Acme__w1/boards', '/mnt/trello')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
