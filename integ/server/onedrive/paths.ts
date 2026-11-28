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

import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import { stripSlash } from '../kit/typescript/index.ts'

export function norm(path: string): string {
  return stripSlash(path)
}

export function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

export function dirName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

export function joinPath(dir: string, name: string): string {
  return norm(dir === '' ? name : `${dir}/${name}`)
}

export function notFound(): Reply {
  return { status: 404, body: { error: { code: 'itemNotFound', message: 'Item not found' } } }
}

export function nameExists(): Reply {
  return {
    status: 409,
    body: { error: { code: 'nameAlreadyExists', message: 'Name already exists' } },
  }
}

export function preconditionFailed(): Reply {
  return {
    status: 412,
    body: {
      error: {
        code: 'preconditionFailed',
        message: 'The resource has changed since the caller last read it',
      },
    },
  }
}

// Graph addresses an item by wedging its path into the URL between `/root:`
// and `:/`, so the same route serves `/root`, `/root/children`,
// `/root:/a/b.txt`, and `/root:/a/b.txt:/content`. Splitting that back into
// (item path, action) is one function because getting it wrong silently reads
// a neighbouring item.
export function parseItemPath(path: string): { item: string; action: string } {
  const idx = path.indexOf('/root')
  if (idx < 0) return { item: '', action: '' }
  let rest = path.slice(idx + '/root'.length)
  if (rest === '' || rest === '/') return { item: '', action: '' }
  if (rest === '/children') return { item: '', action: 'children' }
  if (rest.startsWith('/search(')) return { item: '', action: rest.slice(1) }
  if (rest.startsWith(':')) rest = rest.slice(1)
  const cut = rest.indexOf(':/')
  if (cut < 0) return { item: norm(rest), action: '' }
  return { item: norm(rest.slice(0, cut)), action: rest.slice(cut + 2) }
}

// A parentReference states the destination as a Graph path
// (`/drives/{id}/root:/a/b`), so both the drive and the folder come out of the
// same string.
export function refParent(refPath: string): string {
  const after = refPath.split('root').slice(-1)[0] ?? ''
  return norm(after.startsWith(':') ? after.slice(1) : after)
}

export function refDrive(refPath: string): string | null {
  if (!refPath.includes('/drives/')) return null
  return (refPath.split('/drives/')[1] ?? '').split('/')[0] ?? null
}

export function objOf(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

export function strOf(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' && v !== '' ? v : fallback
}
