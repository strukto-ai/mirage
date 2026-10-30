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

type Json = Record<string, unknown>

function pickString(record: Json, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

function pickBoolOrNull(record: Json, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function pickNumberOrNull(record: Json, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' ? value : null
}

function pickStringArray(record: Json, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const v of value) if (typeof v === 'string') result.push(v)
  return result
}

export interface NormalizedWorkspace {
  workspace_id: string | null
  workspace_name: string | null
}

export function normalizeWorkspace(workspace: Json): NormalizedWorkspace {
  return {
    workspace_id: pickString(workspace, 'id'),
    workspace_name: pickString(workspace, 'displayName', 'name'),
  }
}

export interface NormalizedBoard {
  board_id: string | null
  board_name: string | null
  workspace_id: string | null
  closed: boolean | null
  url: string | null
}

export function normalizeBoard(board: Json): NormalizedBoard {
  return {
    board_id: pickString(board, 'id'),
    board_name: pickString(board, 'name'),
    workspace_id: pickString(board, 'idOrganization'),
    closed: pickBoolOrNull(board, 'closed'),
    url: pickString(board, 'url'),
  }
}

export interface NormalizedList {
  list_id: string | null
  list_name: string | null
  board_id: string | null
  closed: boolean | null
  pos: number | null
}

export function normalizeList(lst: Json): NormalizedList {
  return {
    list_id: pickString(lst, 'id'),
    list_name: pickString(lst, 'name'),
    board_id: pickString(lst, 'idBoard'),
    closed: pickBoolOrNull(lst, 'closed'),
    pos: pickNumberOrNull(lst, 'pos'),
  }
}

export interface NormalizedMember {
  member_id: string | null
  username: string | null
  full_name: string | null
}

export function normalizeMember(member: Json): NormalizedMember {
  return {
    member_id: pickString(member, 'id'),
    username: pickString(member, 'username'),
    full_name: pickString(member, 'fullName'),
  }
}

export interface NormalizedLabel {
  label_id: string | null
  label_name: string | null
  color: string | null
  board_id: string | null
}

export function normalizeLabel(label: Json): NormalizedLabel {
  return {
    label_id: pickString(label, 'id'),
    label_name: pickString(label, 'name'),
    color: pickString(label, 'color'),
    board_id: pickString(label, 'idBoard'),
  }
}

export interface NormalizedCard {
  card_id: string | null
  card_name: string | null
  board_id: string | null
  list_id: string | null
  member_ids: string[]
  label_ids: string[]
  due: string | null
  due_complete: boolean | null
  closed: boolean | null
  desc: string
  url: string | null
}

export function normalizeCard(card: Json): NormalizedCard {
  const labelIds: string[] = []
  const labels = card.labels
  if (Array.isArray(labels)) {
    for (const lbl of labels) {
      if (lbl !== null && typeof lbl === 'object') {
        const id = pickString(lbl as Json, 'id')
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

export interface NormalizedComment {
  comment_id: string | null
  card_id: string
  member_id: string | null
  member_name: string | null
  text: string
  created_at: string | null
}

export function normalizeComment(comment: Json, cardId: string): NormalizedComment {
  const memberRaw = comment.memberCreator
  const member: Json =
    memberRaw !== null && typeof memberRaw === 'object' && !Array.isArray(memberRaw)
      ? (memberRaw as Json)
      : {}
  const dataRaw = comment.data
  const data: Json =
    dataRaw !== null && typeof dataRaw === 'object' && !Array.isArray(dataRaw)
      ? (dataRaw as Json)
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
