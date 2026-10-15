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

import type { TrelloAccessor } from '../../accessor/trello.ts'
import { ContentType, FileStat, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat } from '../hierarchy/stat.ts'
import {
  getBoard,
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listListCards,
  listWorkspaceBoards,
  listWorkspaces,
} from './client.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  normalizeWorkspace,
  toJsonBytes,
  unsearchedText,
} from './normalize.ts'
import {
  boardDirname,
  cardDirname,
  labelFilename,
  listDirname,
  memberFilename,
  workspaceDirname,
} from './pathing.ts'
import { detectScope } from './scope.ts'

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function extraSize(entry: FileStat): number | null {
  const value = entry.extra.json_size
  return typeof value === 'number' ? value : null
}

/** The workspaces the mount shows: the member's, narrowed to `workspaceId` when it is set. */
export async function filteredWorkspaces(
  accessor: TrelloAccessor,
): Promise<Record<string, unknown>[]> {
  let workspaces = await listWorkspaces(accessor.transport)
  if (accessor.workspaceId !== null && accessor.workspaceId !== '') {
    workspaces = workspaces.filter((w) => pickString(w, 'id') === accessor.workspaceId)
  }
  return workspaces
}

/** A workspace's open boards the mount shows, narrowed to `boardIds` when it is set. */
export async function filteredBoards(
  accessor: TrelloAccessor,
  workspaceId: string,
): Promise<Record<string, unknown>[]> {
  let boards = await listWorkspaceBoards(accessor.transport, workspaceId)
  if (accessor.boardIds !== null && accessor.boardIds.length > 0) {
    const allowed = new Set(accessor.boardIds)
    boards = boards.filter((b) => allowed.has(pickString(b, 'id')))
  }
  return boards
}

/** Whether `workspaceId` or `boardIds` narrows the mount. */
export function scopeIsNarrowed(accessor: TrelloAccessor): boolean {
  const byWorkspace = accessor.workspaceId !== null && accessor.workspaceId !== ''
  const byBoard = accessor.boardIds !== null && accessor.boardIds.length > 0
  return byWorkspace || byBoard
}

/**
 * Whether the mount's scope admits a board addressed by id.
 *
 * The two knobs that narrow the listing narrow an id too: a board
 * `boardIds` leaves out, or one outside `workspaceId`, is not this
 * mount's to read or write. Unnarrowed, every id is admitted without a
 * call; `workspaceId` costs one board fetch. Mirrors python's
 * `board_in_scope`.
 */
export async function boardInScope(accessor: TrelloAccessor, boardId: string): Promise<boolean> {
  if (!scopeIsNarrowed(accessor)) return true
  if (boardId === '') return false
  if (accessor.boardIds !== null && accessor.boardIds.length > 0) {
    if (!accessor.boardIds.includes(boardId)) return false
  }
  if (accessor.workspaceId === null || accessor.workspaceId === '') return true
  const board = await getBoard(accessor.transport, boardId)
  return pickString(board, 'idOrganization') === accessor.workspaceId
}

export const WORKSPACE = entryStat('workspace_id', FileType.DIRECTORY)
export const WORKSPACE_JSON = entryStat('workspace_id', ContentType.JSON)
export const BOARD = entryStat('board_id', FileType.DIRECTORY)
export const BOARD_JSON = entryStat('board_id', ContentType.JSON)
export const MEMBER = entryStat('member_id', ContentType.JSON)
export const LABEL = entryStat('label_id', ContentType.JSON)
export const LIST = entryStat('list_id', FileType.DIRECTORY)
export const LIST_JSON = entryStat('list_id', ContentType.JSON)
export const CARD = entryStat('card_id', FileType.DIRECTORY)
export const CARD_JSON = entryStat('card_id', ContentType.JSON)
export const COMMENTS = entryStat('card_id', ContentType.TEXT)

function dir(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY })
}

async function listWorkspacesDir(
  accessor: TrelloAccessor,
  _match: ScopeMatch,
): Promise<FileStat[]> {
  // workspace.json renders the workspace object this listing already
  // fetched, so its exact size rides the directory's row for the child
  // listing to read back without another call.
  return (await filteredWorkspaces(accessor)).map((workspace) =>
    WORKSPACE(workspaceDirname(workspace), pickString(workspace, 'id'), {
      extra: { json_size: toJsonBytes(normalizeWorkspace(workspace)).byteLength },
    }),
  )
}

function listWorkspace(
  _accessor: TrelloAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  return Promise.resolve([
    WORKSPACE_JSON('workspace.json', match.slots.workspace_id ?? '', { size: extraSize(entry) }),
    dir('boards'),
  ])
}

async function listBoards(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  // board.json's normalizer only uses fields the board listing already
  // carries, so its exact size is free here.
  return (await filteredBoards(accessor, match.slots.workspace_id ?? '')).map((board) =>
    BOARD(boardDirname(board), pickString(board, 'id'), {
      modified: pickString(board, 'dateLastActivity'),
      extra: { json_size: toJsonBytes(normalizeBoard(board)).byteLength },
    }),
  )
}

function listBoard(
  _accessor: TrelloAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  return Promise.resolve([
    BOARD_JSON('board.json', match.slots.board_id ?? '', {
      size: extraSize(entry),
      modified: entry.modified,
    }),
    dir('members'),
    dir('labels'),
    dir('lists'),
  ])
}

async function listMembers(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const members = await listBoardMembers(accessor.transport, match.slots.board_id ?? '')
  return members.map((member) =>
    MEMBER(memberFilename(member), pickString(member, 'id'), {
      size: toJsonBytes(normalizeMember(member)).byteLength,
    }),
  )
}

async function listLabels(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const labels = await listBoardLabels(accessor.transport, match.slots.board_id ?? '')
  return labels.map((label) =>
    LABEL(labelFilename(label), pickString(label, 'id'), {
      size: toJsonBytes(normalizeLabel(label)).byteLength,
    }),
  )
}

async function listLists(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const lists = await listBoardLists(accessor.transport, match.slots.board_id ?? '')
  // list.json's normalizer only uses fields the list listing already
  // carries, so its exact size is free here.
  return lists.map((lst) =>
    LIST(listDirname(lst), pickString(lst, 'id'), {
      extra: { json_size: toJsonBytes(normalizeList(lst)).byteLength },
    }),
  )
}

function listList(
  _accessor: TrelloAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  return Promise.resolve([
    LIST_JSON('list.json', match.slots.list_id ?? '', { size: extraSize(entry) }),
    dir('cards'),
  ])
}

async function listCards(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const cards = await listListCards(accessor.transport, match.slots.list_id ?? '')
  // card.json's normalizer only uses fields the card listing already
  // carries, so its exact size is free here.
  return cards.map((card) =>
    CARD(cardDirname(card), pickString(card, 'id'), {
      modified: pickString(card, 'dateLastActivity'),
      extra: {
        json_size: toJsonBytes(normalizeCard(card)).byteLength,
        ...(accessor.contentSearch ? { unsearched: unsearchedText(card) } : {}),
      },
    }),
  )
}

function listCard(
  _accessor: TrelloAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<FileStat[]> {
  // comments.jsonl needs a per-card actions call and stays size-unknown.
  const cardId = match.slots.card_id ?? ''
  return Promise.resolve([
    CARD_JSON('card.json', cardId, { size: extraSize(entry), modified: entry.modified }),
    COMMENTS('comments.jsonl', cardId, { modified: entry.modified }),
  ])
}

export const readdir = makeReaddir<TrelloAccessor>(detectScope, {
  listers: {
    workspaces: listWorkspacesDir,
  },
  entryListers: {
    workspace: listWorkspace,
    boards: listBoards,
    board: listBoard,
    members: listMembers,
    labels: listLabels,
    lists: listLists,
    list: listList,
    cards: listCards,
    card: listCard,
  },
  staticRoot: ['workspaces'],
})
