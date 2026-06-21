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
import { TrelloAccessor } from '../../accessor/trello.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { TrelloTransport } from './_client.ts'
import { stat } from './stat.ts'

class NoopTransport implements TrelloTransport {
  call(): Promise<unknown> {
    throw new Error('should not be called')
  }
}

function spec(original: string, prefix = ''): PathSpec {
  return new PathSpec({ original, directory: original, prefix })
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
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
    )
    expect(s.type).toBe(FileType.JSON)
    expect(s.name).toBe('workspace.json')
  })

  it('returns directory for boards (level 3)', async () => {
    const s = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec('/mnt/trello/workspaces/Acme__w1/boards', '/mnt/trello'),
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('boards')
  })

  it('returns directory for labels/lists/members (level 5)', async () => {
    const out = await Promise.all(
      ['members', 'labels', 'lists'].map((leaf) =>
        stat(
          new TrelloAccessor(new NoopTransport()),
          spec(`/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/${leaf}`, '/mnt/trello'),
        ),
      ),
    )
    for (const s of out) expect(s.type).toBe(FileType.DIRECTORY)
  })
})

describe('trello stat card leaves', () => {
  it('returns json for card.json and text for comments.jsonl', async () => {
    const cardJson = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec(
        '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/card.json',
        '/mnt/trello',
      ),
    )
    expect(cardJson.type).toBe(FileType.JSON)
    expect(cardJson.name).toBe('card.json')

    const comments = await stat(
      new TrelloAccessor(new NoopTransport()),
      spec(
        '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/comments.jsonl',
        '/mnt/trello',
      ),
    )
    expect(comments.type).toBe(FileType.TEXT)
    expect(comments.name).toBe('comments.jsonl')
  })
})

describe('trello stat unknown path', () => {
  it('throws ENOENT', async () => {
    await expect(
      stat(new TrelloAccessor(new NoopTransport()), spec('/mnt/trello/nope', '/mnt/trello')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
