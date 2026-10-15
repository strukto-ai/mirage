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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { TrelloVFS } from '../../vfs/trello/trello.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TrelloTransport } from './client.ts'
import { read } from './read.ts'

class FakeTransport implements TrelloTransport {
  constructor(private readonly responder: (path: string) => unknown) {}
  call(_method: string, path: string): Promise<unknown> {
    return Promise.resolve(this.responder(path))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

// The directory a read is under, as the mount hands its row: a read proves
// the file's directory exists through it before fetching by the ids in the
// path.
const DIR = new FileStat({ name: 'dir', type: FileType.DIRECTORY })

function mounted(accessor: TrelloAccessor): Workspace {
  const vfs = Object.assign(new TrelloVFS({ apiKey: 'k', apiToken: 't' }), { accessor })
  return new Workspace({ '/trello/': vfs })
}

// The listing chain a mount walks to hand a read its directory's row:
// workspace w1 > board b1 > list l1 > card c1.
const LISTINGS: Record<string, unknown> = {
  '/members/me/organizations': [{ id: 'w1', displayName: 'Acme' }],
  '/organizations/w1/boards': [{ id: 'b1', name: 'Roadmap' }],
  '/boards/b1/lists': [{ id: 'l1', name: 'Doing' }],
  '/lists/l1/cards': [{ id: 'c1', name: 'fix bug' }],
}

describe('trello read', () => {
  it('reads workspace.json', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      return []
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec('/workspaces/Acme__w1/workspace.json'),
      null,
      DIR,
    )
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    expect(parsed).toEqual({ workspace_id: 'w1', workspace_name: 'Acme' })
  })

  it('reads board.json', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/boards/b1') {
        return { id: 'b1', name: 'Roadmap', idOrganization: 'w1', closed: false }
      }
      return LISTINGS[path] ?? null
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec('/workspaces/Acme__w1/boards/Roadmap__b1/board.json'),
      null,
      DIR,
    )
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      board_id: 'b1',
      board_name: 'Roadmap',
    })
  })

  it('reads card.json', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/cards/c1') {
        return { id: 'c1', name: 'fix bug', idBoard: 'b1', idList: 'l1', desc: 'd' }
      }
      return LISTINGS[path] ?? null
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec('/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/card.json'),
      null,
      DIR,
    )
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      card_id: 'c1',
      card_name: 'fix bug',
    })
  })

  it('reads comments.jsonl sorted by date', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/cards/c1/actions') {
        return [
          {
            id: 'a2',
            date: '2025-01-02',
            memberCreator: { id: 'u1', fullName: 'Alice' },
            data: { text: 'second' },
          },
          {
            id: 'a1',
            date: '2025-01-01',
            memberCreator: { id: 'u1', fullName: 'Alice' },
            data: { text: 'first' },
          },
        ]
      }
      return LISTINGS[path] ?? []
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec(
        '/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/comments.jsonl',
      ),
      null,
      DIR,
    )
    const lines = new TextDecoder().decode(bytes).trim().split('\n')
    expect((JSON.parse(lines[0] ?? '') as { text: string }).text).toBe('first')
    expect((JSON.parse(lines[1] ?? '') as { text: string }).text).toBe('second')
  })

  it('throws ENOENT for unknown path', async () => {
    const t = new FakeTransport(() => null)
    await expect(read(new TrelloAccessor(t), spec('/nonsense'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT when workspace id missing', async () => {
    const t = new FakeTransport(() => [])
    await expect(
      read(new TrelloAccessor(t), spec('/workspaces/Acme__w1/workspace.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The listing drops a board `boardIds` leaves out, and the read used to go
  // straight to the id in the path: `cat` served a board `ls` and `stat` both
  // reported absent.
  it('refuses a board outside boardIds on every surface', async () => {
    const fetched: string[] = []
    const t = new FakeTransport((path) => {
      if (path === '/organizations/w1/boards') {
        return [
          { id: 'b1', name: 'Roadmap' },
          { id: 'b2', name: 'Secret' },
        ]
      }
      if (path.startsWith('/boards/') || path.startsWith('/cards/')) fetched.push(path)
      if (path === '/boards/b1') return { id: 'b1', name: 'Roadmap' }
      if (path === '/boards/b2') return { id: 'b2', name: 'Secret' }
      if (path === '/cards/c9') return { id: 'c9', name: 'Payroll' }
      return LISTINGS[path] ?? []
    })
    const ws = mounted(new TrelloAccessor(t, { boardIds: ['b1'] }))
    const secret = '/trello/workspaces/Acme__w1/boards/Secret__b2'
    for (const op of ['read', 'stat']) {
      await expect(ws.dispatch(op, `${secret}/board.json`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
    await expect(ws.dispatch('readdir', secret)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      ws.dispatch('read', `${secret}/lists/Todo__l9/cards/Payroll__c9/card.json`),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fetched).toEqual([])
    const scoped = (await ws.dispatch(
      'read',
      '/trello/workspaces/Acme__w1/boards/Roadmap__b1/board.json',
    )) as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(scoped))).toMatchObject({ board_id: 'b1' })
  })

  it('refuses a workspace outside workspaceId', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') {
        return [
          { id: 'w1', displayName: 'Acme' },
          { id: 'w2', displayName: 'Finance' },
        ]
      }
      return []
    })
    const ws = mounted(new TrelloAccessor(t, { workspaceId: 'w1' }))
    await expect(
      ws.dispatch('read', '/trello/workspaces/Finance__w2/workspace.json'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const scoped = (await ws.dispatch(
      'read',
      '/trello/workspaces/Acme__w1/workspace.json',
    )) as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(scoped))).toEqual({
      workspace_id: 'w1',
      workspace_name: 'Acme',
    })
  })

  // `sanitizeName` kept a leading dot, so a board titled `.plan` rendered
  // `.plan__b1`: the kit drops a dot-led name from the listing and classifies
  // it as hidden, so the board was neither listed nor readable, with no error.
  it('lists and reads a board whose title is dot-led', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/organizations/w1/boards') return [{ id: 'b1', name: '.plan' }]
      if (path === '/boards/b1') return { id: 'b1', name: '.plan' }
      return LISTINGS[path] ?? []
    })
    const ws = mounted(new TrelloAccessor(t))
    const listed = (await ws.dispatch('readdir', '/trello/workspaces/Acme__w1/boards')) as string[]
    expect(listed).toEqual(['/trello/workspaces/Acme__w1/boards/plan__b1'])
    const boardJson = `${listed[0] ?? ''}/board.json`
    expect(((await ws.dispatch('stat', boardJson)) as FileStat).name).toBe('board.json')
    const bytes = (await ws.dispatch('read', boardJson)) as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ board_name: '.plan' })
  })

  it('resolves a prefixed mount path through the classifier', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      return []
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
      null,
      DIR,
    )
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      workspace_id: 'w1',
      workspace_name: 'Acme',
    })
  })
})
