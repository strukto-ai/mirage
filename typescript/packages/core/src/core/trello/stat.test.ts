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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import type { TrelloTransport } from './client.ts'
import { stat } from './stat.ts'

class NoopTransport implements TrelloTransport {
  call(): Promise<unknown> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('trello stat virtual roots', () => {
  it('returns directory for /', async () => {
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello', '/mnt/trello'),
    )
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('returns directory for /workspaces', async () => {
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces', '/mnt/trello'),
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('workspaces')
  })
})

describe('trello stat workspace nodes', () => {
  it('returns directory for indexed workspace', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/trello/workspaces', [
      [
        'Acme__w1',
        new IndexEntry({
          id: 'w1',
          name: 'Acme',
          resourceType: 'trello/workspace',
          remoteTime: '2026-04-05T00:00:00.000Z',
          vfsName: 'Acme__w1',
        }),
      ],
    ])
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces/Acme__w1', '/mnt/trello'),
      idx,
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('Acme__w1')
    expect(s.extra.workspace_id).toBe('w1')
    expect(s.modified).toBe('2026-04-05T00:00:00.000Z')
  })

  it('returns json for workspace.json', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/trello/workspaces/Acme__w1', [
      [
        'workspace.json',
        new IndexEntry({
          id: 'w1',
          name: 'workspace.json',
          resourceType: 'trello/workspace_json',
          vfsName: 'workspace.json',
          size: 42,
        }),
      ],
    ])
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
      idx,
    )
    expect(s.content).toBe(ContentType.JSON)
    expect(s.name).toBe('workspace.json')
    expect(s.size).toBe(42)
    expect(s.extra.workspace_id).toBe('w1')
  })

  it('returns directory for boards (level 3) off the warm parent listing', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/trello/workspaces/Acme__w1', [
      [
        'workspace.json',
        new IndexEntry({
          id: 'w1',
          name: 'workspace.json',
          resourceType: 'trello/workspace_json',
          vfsName: 'workspace.json',
        }),
      ],
      [
        'boards',
        new IndexEntry({
          id: 'w1',
          name: 'boards',
          resourceType: 'trello/boards_dir',
          vfsName: 'boards',
        }),
      ],
    ])
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces/Acme__w1/boards', '/mnt/trello'),
      idx,
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('boards')
  })

  it('returns directory for labels/lists/members (level 5)', async () => {
    const idx = new RAMIndexCacheStore()
    const boardDir = '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'
    await idx.setDir(
      boardDir,
      ['board.json', 'members', 'labels', 'lists'].map((name) => [
        name,
        new IndexEntry({
          id: 'b1',
          name,
          resourceType: name === 'board.json' ? 'trello/board_json' : `trello/${name}_dir`,
          vfsName: name,
        }),
      ]),
    )
    const out = await Promise.all(
      ['members', 'labels', 'lists'].map((leaf) =>
        stat(
          new TrelloAccessor(new NoopTransport()),
          spec(`${boardDir}/${leaf}`, '/mnt/trello'),
          idx,
        ),
      ),
    )
    for (const s of out) expect(s.type).toBe(FileType.DIRECTORY)
  })
})

describe('trello stat card leaves', () => {
  it('returns json for card.json and text for comments.jsonl', async () => {
    const idx = new RAMIndexCacheStore()
    const cardDir =
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1'
    await idx.setDir(cardDir, [
      [
        'card.json',
        new IndexEntry({
          id: 'c1',
          name: 'card.json',
          resourceType: 'trello/card_json',
          vfsName: 'card.json',
          size: 99,
        }),
      ],
      [
        'comments.jsonl',
        new IndexEntry({
          id: 'c1',
          name: 'comments.jsonl',
          resourceType: 'trello/comments_jsonl',
          vfsName: 'comments.jsonl',
        }),
      ],
    ])
    const cardJson = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec(`${cardDir}/card.json`, '/mnt/trello'),
      idx,
    )
    expect(cardJson.content).toBe(ContentType.JSON)
    expect(cardJson.name).toBe('card.json')
    expect(cardJson.size).toBe(99)

    const comments = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec(`${cardDir}/comments.jsonl`, '/mnt/trello'),
      idx,
    )
    expect(comments.content).toBe(ContentType.TEXT)
    expect(comments.name).toBe('comments.jsonl')
    expect(comments.size).toBeNull()
  })
})

describe('trello stat unknown path', () => {
  it('throws ENOENT', async () => {
    await expect(
      stat(new TrelloAccessor(new NoopTransport()), spec('/mnt/trello/nope', '/mnt/trello')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for an id-less dirname without touching the API', async () => {
    // Every dynamic level is `label__id`; a segment with no id cannot
    // name anything, so the classifier refuses it before any call.
    await expect(
      stat(
        new TrelloAccessor(new NoopTransport()),
        spec('/mnt/trello/workspaces/w1/boards', '/mnt/trello'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('trello stat parent-listing failures', () => {
  class FailingTransport implements TrelloTransport {
    constructor(private readonly err: Error) {}
    call(): Promise<unknown> {
      return Promise.reject(this.err)
    }
  }

  it('propagates a backend failure instead of reporting ENOENT', async () => {
    const boom = Object.assign(new Error('401 invalid key'), { status: 401 })
    await expect(
      stat(
        new TrelloAccessor(new FailingTransport(boom)),
        spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toThrow('401 invalid key')
  })

  it('still reports ENOENT when the parent is genuinely missing', async () => {
    const gone = Object.assign(new Error('/mnt/trello/workspaces'), { code: 'ENOENT' })
    await expect(
      stat(
        new TrelloAccessor(new FailingTransport(gone)),
        spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
