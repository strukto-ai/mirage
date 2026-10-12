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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TrelloTransport } from './client.ts'
import { unsearchedText } from './normalize.ts'
import { SEARCH_LIMIT, filesContaining } from './search.ts'

const CARDS: Record<string, unknown>[] = [
  {
    id: 'c1',
    name: 'Fix login',
    desc: 'broken',
    idBoard: 'b1',
    idList: 'l1',
    shortUrl: 'https://trello.test/c1',
  },
  {
    id: 'c2',
    name: 'Write notes',
    desc: '',
    idBoard: 'b1',
    idList: 'l1',
    url: 'https://trello.test/c/c2/2-ship-it',
  },
  { id: 'c3', name: 'Docs', desc: 'Visit wombat.example.com first', idBoard: 'b1', idList: 'l1' },
]

const LIST = 'workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1'

// Answers the listings down to the cards and the card search, recording each
// searched query.
class FakeTransport implements TrelloTransport {
  readonly searched: string[] = []
  listed: Record<string, unknown>[] = CARDS
  constructor(
    private readonly named: string[] | Record<string, string[]>,
    private readonly reply?: Record<string, unknown> | Error,
  ) {}
  call(_method: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (path === '/search') {
      this.searched.push(params.query ?? '')
      if (this.reply instanceof Error) return Promise.reject(this.reply)
      if (this.reply !== undefined) return Promise.resolve(this.reply)
      const ids = Array.isArray(this.named) ? this.named : (this.named[params.query ?? ''] ?? [])
      return Promise.resolve({ cards: ids.map((id) => ({ id })) })
    }
    if (path === '/members/me/organizations') {
      return Promise.resolve([{ id: 'ws1', displayName: 'Engineering' }])
    }
    if (path.endsWith('/boards')) return Promise.resolve([{ id: 'b1', name: 'Roadmap' }])
    if (path === '/boards/b1') return Promise.resolve({ id: 'b1', name: 'Roadmap' })
    if (path.endsWith('/lists')) return Promise.resolve([{ id: 'l1', name: 'Doing' }])
    if (path.endsWith('/cards')) return Promise.resolve(this.listed)
    return Promise.resolve([])
  }
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/trello' : `/trello/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

async function ask(
  text: string,
  named: string[] | Record<string, string[]>,
  under = scope(),
  reply?: Record<string, unknown> | Error,
): Promise<[PathSpec[] | null, string[]]> {
  const transport = new FakeTransport(named, reply)
  const out = await filesContaining(
    new TrelloAccessor(transport, { contentSearch: true }),
    text,
    [under],
    new RAMIndexCacheStore(),
  )
  return [out, transport.searched]
}

// Twin of python/tests/core/trello/test_search.py.
describe('trello filesContaining', () => {
  it('leaves the name and description out of the unsearched text', () => {
    const kept = unsearchedText(CARDS[1] ?? {})
    expect(kept).toContain('ship')
    expect(kept).toContain('c2')
    expect(kept).not.toContain('notes')
    expect(kept).not.toContain('write')
  })

  // Trello names the card whose name holds the word; the other is named by
  // its link, which Trello's search does not read.
  it('answers what Trello names and what the listing kept', async () => {
    const [out, searched] = await ask('ship', ['c1'])
    expect(out?.map((p) => p.vfsPath)).toEqual([
      `${LIST}/cards/Fix_login__c1/card.json`,
      `${LIST}/cards/Write_notes__c2/card.json`,
    ])
    expect(searched).toEqual(['ship'])
  })

  // Trello's search may miss a word inside a link, so the listing keeps it,
  // and each word of a phrase is found in either place.
  it('keeps a word inside a link in the listing', async () => {
    const [out, searched] = await ask('visit wombat', { visit: ['c3'] })
    expect(out?.map((p) => p.vfsPath)).toEqual([`${LIST}/cards/Docs__c3/card.json`])
    expect(searched).toEqual(['visit', 'wombat'])
  })

  // A read fetches the card as it is now, so the kept text is checked against
  // listings made for the search, not the ones the walk cached; a card gone
  // since is read.
  it('finds a text changed since the listing', async () => {
    const transport = new FakeTransport({ numbat: ['c1'] })
    const accessor = new TrelloAccessor(transport, { contentSearch: true })
    const index = new RAMIndexCacheStore()
    const search = () => filesContaining(accessor, 'numbat', [scope()], index)
    await search()
    transport.listed = CARDS.map((card) =>
      card.id === 'c2' ? { ...card, desc: 'See numbat.io' } : card,
    )
    let out = await search()
    expect(out?.map((p) => p.vfsPath)).toEqual([
      `${LIST}/cards/Fix_login__c1/card.json`,
      `${LIST}/cards/Write_notes__c2/card.json`,
    ])
    transport.listed = CARDS.slice(0, 1)
    out = await search()
    expect(out).toHaveLength(CARDS.length)
  })

  it('names a card scope its own card.json', async () => {
    const [out] = await ask('login', ['c1'], scope(`${LIST}/cards/Fix_login__c1`))
    expect(out?.map((p) => p.vfsPath)).toEqual([`${LIST}/cards/Fix_login__c1/card.json`])
  })

  it.each([
    ['desc', ['c1']],
    ['true', ['c1']],
    ['q4', ['c1']],
    ['login', []],
    ['login', Array.from({ length: SEARCH_LIMIT }, (_, i) => `x${String(i)}`)],
  ])('reads every file for %j', async (text, named) => {
    const [out] = await ask(text, named)
    expect(out).toBeNull()
  })

  // A reply that is not a list of cards, or not JSON, is a failed search:
  // c2's link holds "ship", but Trello may have named c1 too.
  it.each<[Record<string, unknown> | Error]>([
    [{ cards: {} }],
    [{}],
    [{ cards: [{ name: 'Fix login' }] }],
    [new SyntaxError('Unexpected token < in JSON')],
  ])('reads every file for the garbled reply %#', async (reply) => {
    const [out] = await ask('ship', [], scope(), reply)
    expect(out).toBeNull()
  })
})
