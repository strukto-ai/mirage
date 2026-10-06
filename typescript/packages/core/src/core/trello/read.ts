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
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonlBytesByCreatedAt } from '../render/json.ts'
import {
  getBoard,
  getCard,
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listCardComments,
  listWorkspaces,
} from './client.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeComment,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  normalizeWorkspace,
  toJsonBytes,
} from './normalize.ts'
import { detectScope } from './scope.ts'
import { stat } from './stat.ts'

async function readWorkspaceJson(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const workspaceId = match.slots.workspace_id ?? ''
  for (const workspace of await listWorkspaces(accessor.transport)) {
    if (workspace.id === workspaceId) return toJsonBytes(normalizeWorkspace(workspace))
  }
  throw enoent(path.virtual)
}

async function readBoardJson(accessor: TrelloAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const board = await getBoard(accessor.transport, match.slots.board_id ?? '')
  return toJsonBytes(normalizeBoard(board))
}

async function readMember(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const memberId = match.slots.member_id ?? ''
  const members = await listBoardMembers(accessor.transport, match.slots.board_id ?? '')
  for (const member of members) {
    if (member.id === memberId) return toJsonBytes(normalizeMember(member))
  }
  throw enoent(path.virtual)
}

async function readLabel(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const labelId = match.slots.label_id ?? ''
  const labels = await listBoardLabels(accessor.transport, match.slots.board_id ?? '')
  for (const label of labels) {
    if (label.id === labelId) return toJsonBytes(normalizeLabel(label))
  }
  throw enoent(path.virtual)
}

async function readListJson(
  accessor: TrelloAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const listId = match.slots.list_id ?? ''
  const lists = await listBoardLists(accessor.transport, match.slots.board_id ?? '')
  for (const lst of lists) {
    if (lst.id === listId) return toJsonBytes(normalizeList(lst))
  }
  throw enoent(path.virtual)
}

async function readCardJson(accessor: TrelloAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const card = await getCard(accessor.transport, match.slots.card_id ?? '')
  return toJsonBytes(normalizeCard(card))
}

async function readComments(accessor: TrelloAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const cardId = match.slots.card_id ?? ''
  const comments = await listCardComments(accessor.transport, cardId)
  const rows = comments.map((c) => normalizeComment(c, cardId))
  return jsonlBytesByCreatedAt(rows)
}

export const read = makeRead<TrelloAccessor>(
  detectScope,
  {
    workspace_json: readWorkspaceJson,
    board_json: readBoardJson,
    member: readMember,
    label: readLabel,
    list_json: readListJson,
    card_json: readCardJson,
    comments_jsonl: readComments,
  },
  { stat },
)
