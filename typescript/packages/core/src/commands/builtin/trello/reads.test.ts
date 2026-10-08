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
import { TrelloAccessor } from '../../../accessor/trello.ts'
import type { TrelloTransport } from '../../../core/trello/client.ts'
import type { CommandOpts, Command } from '../../config.ts'
import { makeTrelloReadCommands } from './reads.ts'

const DEC = new TextDecoder()

const OPTS: CommandOpts = {
  stdin: null,
  flags: {},
  filetypeFns: null,
  cwd: '/',
  mountPrefix: '/trello',
}

const BOARD_READS = [
  'trello board show',
  'trello board members',
  'trello list list',
  'trello label list',
]

// Answers GETs from a table; anything else is a call the scope guard
// should have stopped.
function transport(table: Record<string, unknown>): TrelloTransport {
  return {
    call(method: string, path: string) {
      if (method === 'GET' && path in table) return Promise.resolve(table[path])
      throw new Error(`the transport was reached: ${method} ${path}`)
    },
  }
}

function read(name: string): Command {
  const rc = makeTrelloReadCommands().find((c) => c.name === name)
  if (rc === undefined) throw new Error(`${name} is not registered`)
  return rc
}

async function run(name: string, accessor: TrelloAccessor, texts: string[]): Promise<string> {
  const result = await read(name).fn(accessor, [], texts, OPTS)
  if (result === null) throw new Error(`${name} returned nothing`)
  const [data] = result
  if (!(data instanceof Uint8Array)) throw new Error(`${name} did not return bytes`)
  return DEC.decode(data)
}

// Mirrors python's tests/commands/builtin/trello/test_reads.py.
describe('trello reads hold the mount scope', () => {
  it('board list shows only the boards the mount lists', async () => {
    const accessor = new TrelloAccessor(
      transport({
        '/members/me/organizations': [{ id: 'ws1' }, { id: 'ws2' }],
        '/organizations/ws1/boards': [
          { id: 'b1', name: 'In' },
          { id: 'b2', name: 'Out' },
        ],
      }),
      { workspaceId: 'ws1', boardIds: ['b1'] },
    )
    const boards = JSON.parse(await run('trello board list', accessor, [])) as {
      board_name: string
    }[]
    expect(boards.map((b) => b.board_name)).toEqual(['In'])
  })

  for (const name of BOARD_READS) {
    it(`${name} refuses a board outside the scope`, async () => {
      const accessor = new TrelloAccessor(transport({}), { boardIds: ['b_in'] })
      await expect(run(name, accessor, ['b_out'])).rejects.toThrow(
        /^board b_out is outside this mount's scope$/,
      )
    })
  }

  it('card list refuses a list on a board outside the scope', async () => {
    const accessor = new TrelloAccessor(transport({ '/lists/l1': { idBoard: 'b_out' } }), {
      boardIds: ['b_in'],
    })
    await expect(run('trello card list', accessor, ['l1'])).rejects.toThrow(
      /^list l1 is outside this mount's scope$/,
    )
  })

  for (const name of ['trello card show', 'trello card comments']) {
    it(`${name} refuses a card on a board outside the scope`, async () => {
      const accessor = new TrelloAccessor(
        transport({
          '/cards/c1': { idBoard: 'b_out' },
          '/boards/b_out': { id: 'b_out', idOrganization: 'ws2' },
        }),
        { workspaceId: 'ws1' },
      )
      await expect(run(name, accessor, ['c1'])).rejects.toThrow(
        /^card c1 is outside this mount's scope$/,
      )
    })
  }

  it('a card read inside the scope is answered', async () => {
    const accessor = new TrelloAccessor(
      transport({ '/cards/c1': { id: 'c1', name: 'Ship', idBoard: 'b_in' } }),
      { boardIds: ['b_in'] },
    )
    const card = JSON.parse(await run('trello card show', accessor, ['c1'])) as {
      card_name: string
    }
    expect(card.card_name).toBe('Ship')
  })
})
