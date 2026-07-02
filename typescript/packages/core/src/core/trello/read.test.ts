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
import { PathSpec } from '../../types.ts'
import type { TrelloTransport } from './_client.ts'
import { read, readBytes } from './read.ts'

class FakeTransport implements TrelloTransport {
  constructor(private readonly responder: (path: string) => unknown) {}
  call(_method: string, path: string): Promise<unknown> {
    return Promise.resolve(this.responder(path))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('trello readBytes', () => {
  it('reads workspace.json', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      return []
    })
    const bytes = await readBytes(t, '/workspaces/Acme__w1/workspace.json')
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    expect(parsed).toEqual({ workspace_id: 'w1', workspace_name: 'Acme' })
  })

  it('reads board.json', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/boards/b1') {
        return { id: 'b1', name: 'Roadmap', idOrganization: 'w1', closed: false }
      }
      return null
    })
    const bytes = await readBytes(t, '/workspaces/Acme__w1/boards/Roadmap__b1/board.json')
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
      return null
    })
    const bytes = await readBytes(
      t,
      '/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/card.json',
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
      return []
    })
    const bytes = await readBytes(
      t,
      '/workspaces/Acme__w1/boards/Roadmap__b1/lists/Doing__l1/cards/fix_bug__c1/comments.jsonl',
    )
    const lines = new TextDecoder().decode(bytes).trim().split('\n')
    expect((JSON.parse(lines[0] ?? '') as { text: string }).text).toBe('first')
    expect((JSON.parse(lines[1] ?? '') as { text: string }).text).toBe('second')
  })

  it('throws ENOENT for unknown path', async () => {
    const t = new FakeTransport(() => null)
    await expect(readBytes(t, '/nonsense')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT when workspace id missing', async () => {
    const t = new FakeTransport(() => [])
    await expect(readBytes(t, '/workspaces/Acme__w1/workspace.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('trello read (PathSpec)', () => {
  it('strips prefix and delegates to readBytes', async () => {
    const t = new FakeTransport((path) => {
      if (path === '/members/me/organizations') return [{ id: 'w1', displayName: 'Acme' }]
      return []
    })
    const bytes = await read(
      new TrelloAccessor(t),
      spec('/mnt/trello/workspaces/Acme__w1/workspace.json', '/mnt/trello'),
    )
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      workspace_id: 'w1',
      workspace_name: 'Acme',
    })
  })
})
