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
import { SEPARATOR, fitIdName } from '../../utils/naming.ts'

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

export function teamDirname(team: Record<string, unknown>): string {
  const parts: string[] = []
  const key = pickString(team, 'key')
  if (key !== '') parts.push(sanitizeName(key))
  const name = pickString(team, 'name')
  if (name !== '') {
    const sanitized = sanitizeName(name)
    if (!parts.includes(sanitized)) parts.push(sanitized)
  }
  if (parts.length === 0) parts.push('team')
  // fitIdName rather than makeIdName: the parts are already sanitized and
  // joined with the separator, and re-sanitizing would collapse that `__`
  // to `_`.
  return fitIdName(parts.join(SEPARATOR), requireId(team))
}

export function memberFilename(user: Record<string, unknown>): string {
  const label = sanitizeName(pickString(user, 'displayName', 'name', 'email') || 'user')
  return fitIdName(label, requireId(user), '.json')
}

export function issueDirname(issue: Record<string, unknown>): string {
  const key = pickString(issue, 'identifier', 'id') || 'issue'
  return fitIdName(sanitizeName(key), requireId(issue))
}

export function projectFilename(project: Record<string, unknown>): string {
  const label = sanitizeName(pickString(project, 'name') || 'project')
  return fitIdName(label, requireId(project), '.json')
}

export function cycleFilename(cycle: Record<string, unknown>): string {
  const label = sanitizeName(pickString(cycle, 'name') || 'cycle')
  return fitIdName(label, requireId(cycle), '.json')
}

export function documentFilename(document: Record<string, unknown>): string {
  const label = sanitizeName(pickString(document, 'title') || 'document')
  return fitIdName(label, requireId(document), '.json')
}
