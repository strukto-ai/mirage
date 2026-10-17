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

import type { TrelloAccessor } from '../../../../accessor/trello.ts'
import { getCard, getList } from '../../../../core/trello/client.ts'
import { boardInScope, scopeIsNarrowed } from '../../../../core/trello/readdir.ts'

function outside(kind: string, id: string): Error {
  return new Error(`${kind} ${id} is outside the configured scope`)
}

function boardOf(record: Record<string, unknown>): string {
  const value = record.idBoard
  return typeof value === 'string' ? value : ''
}

/**
 * Refuse a board the install's scope leaves out.
 *
 * A verb reaches the API by the id it is handed, not through a listing, so
 * without this the config's `workspaceId` and `boardIds` would narrow nothing
 * the CLI does. Mirrors python's `require_board`.
 */
export async function requireBoard(accessor: TrelloAccessor, boardId: string): Promise<void> {
  if (!(await boardInScope(accessor, boardId))) throw outside('board', boardId)
}

/** Refuse a list on a board the install's scope leaves out. */
export async function requireList(accessor: TrelloAccessor, listId: string): Promise<void> {
  if (!scopeIsNarrowed(accessor)) return
  const list = await getList(accessor.transport, listId)
  if (!(await boardInScope(accessor, boardOf(list)))) throw outside('list', listId)
}

/** Refuse a card on a board the install's scope leaves out. */
export async function requireCard(accessor: TrelloAccessor, cardId: string): Promise<void> {
  if (!scopeIsNarrowed(accessor)) return
  const card = await getCard(accessor.transport, cardId)
  if (!(await boardInScope(accessor, boardOf(card)))) throw outside('card', cardId)
}
