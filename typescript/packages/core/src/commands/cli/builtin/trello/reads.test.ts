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
import { TrelloAccessor } from '../../../../accessor/trello.ts'
import type { TrelloTransport } from '../../../../core/trello/client.ts'
import { materialize } from '../../../../io/types.ts'
import { context } from '../../../../../tests/workspace/fixtures/context.ts'
import type { CLIVerbFn } from '../../types.ts'
import { TRELLO } from './index.ts'

const DEC = new TextDecoder()

const BOARD_READS = ['board show', 'board members', 'list list', 'label list']

function transport(table: Record<string, unknown>): TrelloTransport {
  return {
    call(method: string, path: string) {
      if (method === 'GET' && path in table) return Promise.resolve(table[path])
      throw new Error(`the transport was reached: ${method} ${path}`)
    },
  }
}

function leaf(path: string): CLIVerbFn {
  const fn = TRELLO.handlers[path]?.fn
  if (fn === null || fn === undefined) throw new Error(`trello ${path} has no handler`)
  return fn
}

async function run(path: string, accessor: TrelloAccessor, texts: string[]): Promise<string> {
  const result = await leaf(path)(accessor, [], texts, context())
  if (result === null) throw new Error(`trello ${path} returned nothing`)
  return DEC.decode(await materialize(result[0]))
}

// Mirrors python's tests/commands/cli/builtin/trello/test_reads.py.
describe('trello reads hold the configured scope', () => {
  it('board list shows only the boards the scope covers', async () => {
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
    const boards = JSON.parse(await run('board list', accessor, [])) as {
      board_name: string
    }[]
    expect(boards.map((b) => b.board_name)).toEqual(['In'])
  })

  for (const path of BOARD_READS) {
    it(`${path} refuses a board outside the scope`, async () => {
      const accessor = new TrelloAccessor(transport({}), { boardIds: ['b_in'] })
      await expect(run(path, accessor, ['b_out'])).rejects.toThrow(
        /^board b_out is outside the configured scope$/,
      )
    })
  }

  it('card list refuses a list on a board outside the scope', async () => {
    const accessor = new TrelloAccessor(transport({ '/lists/l1': { idBoard: 'b_out' } }), {
      boardIds: ['b_in'],
    })
    await expect(run('card list', accessor, ['l1'])).rejects.toThrow(
      /^list l1 is outside the configured scope$/,
    )
  })

  for (const path of ['card show', 'card comments']) {
    it(`${path} refuses a card on a board outside the scope`, async () => {
      const accessor = new TrelloAccessor(
        transport({
          '/cards/c1': { idBoard: 'b_out' },
          '/boards/b_out': { id: 'b_out', idOrganization: 'ws2' },
        }),
        { workspaceId: 'ws1' },
      )
      await expect(run(path, accessor, ['c1'])).rejects.toThrow(
        /^card c1 is outside the configured scope$/,
      )
    })
  }

  it('a card read inside the scope is answered', async () => {
    const accessor = new TrelloAccessor(
      transport({ '/cards/c1': { id: 'c1', name: 'Ship', idBoard: 'b_in' } }),
      { boardIds: ['b_in'] },
    )
    const card = JSON.parse(await run('card show', accessor, ['c1'])) as {
      card_name: string
    }
    expect(card.card_name).toBe('Ship')
  })
})
