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
import { ContentType, FileType, PathSpec, type FileStat } from '../../types.ts'
import { TrelloVFS } from '../../vfs/trello/trello.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TrelloTransport } from './client.ts'
import { normalizeCard, normalizeWorkspace, toJsonBytes } from './normalize.ts'
import { stat } from './stat.ts'

class NoopTransport implements TrelloTransport {
  call(): Promise<unknown> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const WORKSPACE = { id: 'w1', displayName: 'Acme' }
const CARD = {
  id: 'c1',
  name: 'fix bug',
  desc: 'broken',
  dateLastActivity: '2026-04-06T00:00:00.000Z',
}
const LISTED: Record<string, unknown> = {
  '/members/me/organizations': [WORKSPACE],
  '/organizations/w1/boards': [
    { id: 'b1', name: 'Roadmap', dateLastActivity: '2026-04-05T00:00:00.000Z' },
  ],
  '/boards/b1/lists': [{ id: 'l1', name: 'Doing' }],
  '/lists/l1/cards': [CARD],
}

// Answers each listing of the tree above.
class TreeTransport implements TrelloTransport {
  call(_method: string, path: string): Promise<unknown> {
    return Promise.resolve(LISTED[path] ?? [])
  }
}

// `path`'s stat through a mount at /mnt/trello, which lists its parent to
// hand the backend the row there.
async function statAt(transport: TrelloTransport, path: string): Promise<FileStat> {
  const accessor = new TrelloAccessor(transport)
  const vfs = Object.assign(new TrelloVFS({ apiKey: 'k', apiToken: 't' }), { accessor })
  return (await new Workspace({ '/mnt/trello/': vfs }).dispatch('stat', path)) as FileStat
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
  it('returns directory for a listed workspace', async () => {
    const s = await statAt(new TreeTransport(), '/mnt/trello/workspaces/Acme__w1')
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('Acme__w1')
    expect(s.extra.workspace_id).toBe('w1')
  })

  it('returns json for workspace.json', async () => {
    const s = await statAt(new TreeTransport(), '/mnt/trello/workspaces/Acme__w1/workspace.json')
    expect(s.content).toBe(ContentType.JSON)
    expect(s.name).toBe('workspace.json')
    expect(s.size).toBe(toJsonBytes(normalizeWorkspace(WORKSPACE)).byteLength)
    expect(s.extra.workspace_id).toBe('w1')
  })

  it('returns directory for boards (level 3)', async () => {
    const s = await statAt(new TreeTransport(), '/mnt/trello/workspaces/Acme__w1/boards')
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('boards')
  })

  it('returns a listed board with its id and time', async () => {
    const s = await statAt(
      new TreeTransport(),
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1',
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.board_id).toBe('b1')
    expect(s.modified).toBe('2026-04-05T00:00:00.000Z')
  })

  it('returns directory for labels/lists/members (level 5)', async () => {
    const boardDir = '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1'
    for (const leaf of ['members', 'labels', 'lists']) {
      const s = await statAt(new TreeTransport(), `${boardDir}/${leaf}`)
      expect(s.type).toBe(FileType.DIRECTORY)
    }
  })
})

describe('trello stat card leaves', () => {
  it('returns json for card.json and text for comments.jsonl', async () => {
    const cardDir =
      '/mnt/trello/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1'
    const cardJson = await statAt(new TreeTransport(), `${cardDir}/card.json`)
    expect(cardJson.content).toBe(ContentType.JSON)
    expect(cardJson.name).toBe('card.json')
    expect(cardJson.size).toBe(toJsonBytes(normalizeCard(CARD)).byteLength)

    const comments = await statAt(new TreeTransport(), `${cardDir}/comments.jsonl`)
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
      statAt(new FailingTransport(boom), '/mnt/trello/workspaces/Acme__w1/workspace.json'),
    ).rejects.toThrow('401 invalid key')
  })

  it('still reports ENOENT when the parent is genuinely missing', async () => {
    const gone = Object.assign(new Error('/mnt/trello/workspaces'), { code: 'ENOENT' })
    await expect(
      statAt(new FailingTransport(gone), '/mnt/trello/workspaces/Acme__w1/workspace.json'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
