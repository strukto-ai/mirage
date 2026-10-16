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
import { FileChangeKind, PathSpec, type JsonValue } from '../../types.ts'
import { TrelloApiError, type TrelloTransport } from './client.ts'
import { TrelloEventHook } from './events.ts'

const { CREATE: C, UPDATE: U, DELETE: D, MOVE: M, UNKNOWN: X } = FileChangeKind
const BOARD = { id: 'b1', name: 'Roadmap' }
const TODO = { id: 'l1', name: 'To Do' }
const DONE = { id: 'l2', name: 'Done' }
const CARD = { id: 'c1', name: 'Ship it' }
const BOARD_DIR = '/t/workspaces/Acme__w1/boards/Roadmap__b1'
const TODO_CARD = `${BOARD_DIR}/lists/To_Do__l1/cards/Ship_it__c1`
const DONE_CARD = `${BOARD_DIR}/lists/Done__l2/cards/Ship_it__c1`
const ROOT = new PathSpec({ virtual: '/t', directory: '/t', vfsPath: '' })

function fake(options: { workspaceId?: string; boardIds?: string[] } = {}): {
  hook: TrelloEventHook
  calls: string[]
} {
  const calls: string[] = []
  const transport: TrelloTransport = {
    call(_method, path) {
      if (path === '/members/me/organizations') {
        calls.push('workspaces')
        return Promise.resolve([{ id: 'w1', displayName: 'Acme' }])
      }
      const [, kind, id] = path.split('/')
      if (kind === 'cards') {
        calls.push(`card ${id ?? ''}`)
        if (id !== 'c1') return Promise.reject(new TrelloApiError(path, 404, 'not found'))
        return Promise.resolve({ ...CARD, idList: 'l1' })
      }
      if (kind === 'lists') {
        calls.push(`list ${id ?? ''}`)
        return Promise.resolve({ ...TODO })
      }
      calls.push(`board ${id ?? ''}`)
      return Promise.resolve({ id, idOrganization: 'w1' })
    },
  }
  return { hook: new TrelloEventHook(new TrelloAccessor(transport, options)), calls }
}

function body(
  kind: string,
  data: Record<string, JsonValue> = {},
  model?: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    action: { type: kind, data: { board: BOARD, ...data } },
    model: model ?? { id: 'b1', name: 'Roadmap', idOrganization: 'w1' },
  }
}

async function map(
  hook: TrelloEventHook,
  delivery: Record<string, JsonValue>,
): Promise<[FileChangeKind, string][]> {
  const kind = (delivery.action as { type: string }).type
  const events = await hook.toEvents(ROOT, kind, delivery)
  return events.map((e) => [e.kind, e.path.virtual])
}

async function moves(
  hook: TrelloEventHook,
  delivery: Record<string, JsonValue>,
): Promise<[string, string][]> {
  const kind = (delivery.action as { type: string }).type
  const events = await hook.toEvents(ROOT, kind, delivery)
  expect(events.every((e) => e.kind === M)).toBe(true)
  return events.map((e) => [e.previousPath?.virtual ?? '', e.path.virtual])
}

describe('TrelloEventHook', () => {
  it('creates both files of a new card from the board model', async () => {
    const { hook, calls } = fake()
    expect(await map(hook, body('createCard', { card: CARD, list: TODO }))).toEqual([
      [C, `${TODO_CARD}/card.json`],
      [C, `${TODO_CARD}/comments.jsonl`],
    ])
    expect(calls).toEqual(['workspaces'])
  })

  it('moves both files of a card moved between lists', async () => {
    const { hook } = fake()
    const delivery = body('updateCard', {
      card: { ...CARD, idList: 'l2' },
      old: { idList: 'l1' },
      listBefore: TODO,
      listAfter: DONE,
    })
    expect(await moves(hook, delivery)).toEqual([
      [`${TODO_CARD}/card.json`, `${DONE_CARD}/card.json`],
      [`${TODO_CARD}/comments.jsonl`, `${DONE_CARD}/comments.jsonl`],
    ])
  })

  it('moves a renamed card and updates an edited one', async () => {
    const { hook } = fake()
    const draft = `${BOARD_DIR}/lists/To_Do__l1/cards/Draft__c1`
    const renamed = body('updateCard', { card: CARD, old: { name: 'Draft' }, list: TODO })
    expect((await moves(hook, renamed))[0]).toEqual([
      `${draft}/card.json`,
      `${TODO_CARD}/card.json`,
    ])
    const edited = body('updateCard', { card: CARD, old: { desc: '' }, list: TODO })
    expect(await map(hook, edited)).toEqual([[U, `${TODO_CARD}/card.json`]])
    const labelled = body('addLabelToCard', { card: CARD, list: TODO })
    expect(await map(hook, labelled)).toEqual([[U, `${TODO_CARD}/card.json`]])
  })

  it('removes an archived card and updates comments for a comment', async () => {
    const { hook } = fake()
    const archived = body('updateCard', {
      card: { ...CARD, closed: true },
      old: { closed: false },
      list: TODO,
    })
    expect(await map(hook, archived)).toEqual([[D, TODO_CARD]])
    const restored = body('updateCard', {
      card: { ...CARD, closed: false },
      old: { closed: true },
      list: TODO,
    })
    expect((await map(hook, restored)).map(([kind]) => kind)).toEqual([C, C])
    const comment = body('commentCard', { card: CARD, list: TODO, text: 'hi' })
    expect(await map(hook, comment)).toEqual([[U, `${TODO_CARD}/comments.jsonl`]])
  })

  it('finds a deleted card where it was seen', async () => {
    const { hook } = fake()
    await map(hook, body('createCard', { card: CARD, list: TODO }))
    const gone = body('deleteCard', { card: { id: 'c1', idShort: 4 }, list: TODO })
    expect(await map(hook, gone)).toEqual([[D, TODO_CARD]])
    const unseen = body('deleteCard', { card: { id: 'c9' }, list: TODO })
    expect(await map(hook, unseen)).toEqual([[X, `${BOARD_DIR}/lists/To_Do__l1/cards`]])
  })

  it('is UNKNOWN on both places of a renamed list or board', async () => {
    const { hook } = fake()
    expect(await map(hook, body('updateList', { list: DONE, old: { name: 'Doing' } }))).toEqual([
      [X, `${BOARD_DIR}/lists/Doing__l2`],
      [X, `${BOARD_DIR}/lists/Done__l2`],
    ])
    expect(await map(hook, body('updateList', { list: DONE, old: { pos: 1 } }))).toEqual([
      [U, `${BOARD_DIR}/lists/Done__l2/list.json`],
    ])
    expect(await map(hook, body('updateBoard', { old: { name: 'Plans' } }))).toEqual([
      [X, '/t/workspaces/Acme__w1/boards/Plans__b1'],
      [X, BOARD_DIR],
    ])
    const closed = body('updateBoard', {
      old: { closed: false },
      board: { ...BOARD, closed: true },
    })
    expect(await map(hook, closed)).toEqual([[D, BOARD_DIR]])
  })

  it('is UNKNOWN on the listing for labels and members', async () => {
    const { hook } = fake()
    expect(await map(hook, body('createLabel', { label: { id: 'x' } }))).toEqual([
      [X, `${BOARD_DIR}/labels`],
    ])
    expect(await map(hook, body('addMemberToBoard'))).toEqual([[X, `${BOARD_DIR}/members`]])
  })

  it('maps a board outside the mount to nothing', async () => {
    const outside = fake({ boardIds: ['b9'] })
    expect(await map(outside.hook, body('createCard', { card: CARD, list: TODO }))).toEqual([])
    const { hook, calls } = fake({ workspaceId: 'w2' })
    const delivery = body('createCard', { card: CARD, list: TODO }, { id: 'c1', name: 'Ship it' })
    expect(await map(hook, delivery)).toEqual([])
    expect(calls).toEqual(['board b1'])
  })

  it('reads the card once for an action without its list', async () => {
    const { hook, calls } = fake()
    const labelled = body('addLabelToCard', { card: CARD, label: { id: 'x' } })
    expect(await map(hook, labelled)).toEqual([[U, `${TODO_CARD}/card.json`]])
    expect(await map(hook, labelled)).toEqual([[U, `${TODO_CARD}/card.json`]])
    expect(calls).toEqual(['workspaces', 'card c1', 'list l1'])
  })

  it('moves remembered cards with a renamed list or board', async () => {
    const { hook } = fake()
    await map(hook, body('createCard', { card: CARD, list: TODO }))
    const nextList = { id: 'l1', name: 'Next' }
    await map(hook, body('updateList', { list: nextList, old: { name: 'To Do' } }))
    const gone = body('deleteCard', { card: { id: 'c1' }, list: nextList })
    expect(await map(hook, gone)).toEqual([[D, `${BOARD_DIR}/lists/Next__l1/cards/Ship_it__c1`]])
    await map(hook, body('createCard', { card: CARD, list: TODO }))
    const renamed = body('updateBoard', {
      old: { name: 'Roadmap' },
      board: { id: 'b1', name: 'Ideas' },
    })
    await map(hook, renamed)
    const ideas = '/t/workspaces/Acme__w1/boards/Ideas__b1'
    expect(await map(hook, gone)).toEqual([[D, `${ideas}/lists/To_Do__l1/cards/Ship_it__c1`]])
  })

  it('deletes a board that left the workspace where it was', async () => {
    const { hook } = fake({ workspaceId: 'w1' })
    const left = body(
      'updateBoard',
      { old: { idOrganization: 'w1' } },
      { id: 'b1', name: 'Roadmap', idOrganization: 'w2' },
    )
    expect(await map(hook, left)).toEqual([[D, BOARD_DIR]])
  })

  it('is UNKNOWN on the board for a late delivery about a deleted card', async () => {
    const { hook } = fake()
    const late = body('commentCard', { card: { id: 'c9', name: 'Gone' } })
    expect(await map(hook, late)).toEqual([[X, BOARD_DIR]])
  })
})
