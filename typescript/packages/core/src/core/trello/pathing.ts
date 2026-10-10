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

import { sanitizeName } from '../../utils/sanitize.ts'

export { sanitizeName } from '../../utils/sanitize.ts'
import { fitIdName } from '../../utils/naming.ts'

function pickString(record: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function requireId(record: Record<string, unknown>): string {
  const id = pickString(record, 'id')
  if (id === '') throw new Error('record missing id')
  return id
}

export function workspaceDirname(workspace: Record<string, unknown>): string {
  const label = sanitizeName(pickString(workspace, 'displayName', 'name') || 'workspace')
  return fitIdName(label, requireId(workspace))
}

export function boardDirname(board: Record<string, unknown>): string {
  const label = sanitizeName(pickString(board, 'name') || 'board')
  return fitIdName(label, requireId(board))
}

export function listDirname(lst: Record<string, unknown>): string {
  const label = sanitizeName(pickString(lst, 'name') || 'list')
  return fitIdName(label, requireId(lst))
}

export function cardDirname(card: Record<string, unknown>): string {
  const label = sanitizeName(pickString(card, 'name') || 'card')
  return fitIdName(label, requireId(card))
}

export function memberFilename(member: Record<string, unknown>): string {
  const label = sanitizeName(pickString(member, 'fullName', 'username') || 'member')
  return fitIdName(label, requireId(member), '.json')
}

export function labelFilename(label: Record<string, unknown>): string {
  const raw = pickString(label, 'name', 'color') || 'label'
  return fitIdName(sanitizeName(raw), requireId(label), '.json')
}
