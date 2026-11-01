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

import type { JsonObject } from '../../types.ts'
import {
  pickBoolOrNull,
  pickNumberOrNull,
  pickString,
  pickStringArray,
} from '../../utils/records.ts'

export function normalizeWorkspace(workspace: JsonObject) {
  return {
    workspace_id: pickString(workspace, 'id'),
    workspace_name: pickString(workspace, 'displayName', 'name'),
  }
}

export function normalizeBoard(board: JsonObject) {
  return {
    board_id: pickString(board, 'id'),
    board_name: pickString(board, 'name'),
    workspace_id: pickString(board, 'idOrganization'),
    closed: pickBoolOrNull(board, 'closed'),
    url: pickString(board, 'url'),
  }
}

export function normalizeList(lst: JsonObject) {
  return {
    list_id: pickString(lst, 'id'),
    list_name: pickString(lst, 'name'),
    board_id: pickString(lst, 'idBoard'),
    closed: pickBoolOrNull(lst, 'closed'),
    pos: pickNumberOrNull(lst, 'pos'),
  }
}

export function normalizeMember(member: JsonObject) {
  return {
    member_id: pickString(member, 'id'),
    username: pickString(member, 'username'),
    full_name: pickString(member, 'fullName'),
  }
}

export function normalizeLabel(label: JsonObject) {
  return {
    label_id: pickString(label, 'id'),
    label_name: pickString(label, 'name'),
    color: pickString(label, 'color'),
    board_id: pickString(label, 'idBoard'),
  }
}

export function normalizeCard(card: JsonObject) {
  const labelIds: string[] = []
  const labels = card.labels
  if (Array.isArray(labels)) {
    for (const lbl of labels) {
      if (lbl !== null && typeof lbl === 'object') {
        const id = pickString(lbl as JsonObject, 'id')
        if (id !== null) labelIds.push(id)
      }
    }
  }
  return {
    card_id: pickString(card, 'id'),
    card_name: pickString(card, 'name'),
    board_id: pickString(card, 'idBoard'),
    list_id: pickString(card, 'idList'),
    member_ids: pickStringArray(card, 'idMembers'),
    label_ids: labelIds,
    due: pickString(card, 'due'),
    due_complete: pickBoolOrNull(card, 'dueComplete'),
    closed: pickBoolOrNull(card, 'closed'),
    desc: pickString(card, 'desc') ?? '',
    url: pickString(card, 'shortUrl', 'url'),
  }
}

export function normalizeComment(comment: JsonObject, cardId: string) {
  const memberRaw = comment.memberCreator
  const member: JsonObject =
    memberRaw !== null && typeof memberRaw === 'object' && !Array.isArray(memberRaw)
      ? (memberRaw as JsonObject)
      : {}
  const dataRaw = comment.data
  const data: JsonObject =
    dataRaw !== null && typeof dataRaw === 'object' && !Array.isArray(dataRaw)
      ? (dataRaw as JsonObject)
      : {}
  return {
    comment_id: pickString(comment, 'id'),
    card_id: cardId,
    member_id: pickString(member, 'id'),
    member_name: pickString(member, 'fullName', 'username'),
    text: pickString(data, 'text') ?? '',
    created_at: pickString(comment, 'date'),
  }
}

// The fields of a card's JSON Trello's search reads; every other field is
// checked against the listing instead (`unsearchedText`).
export const SEARCHED_FIELDS: ReadonlySet<string> = new Set(['card_name', 'desc'])
