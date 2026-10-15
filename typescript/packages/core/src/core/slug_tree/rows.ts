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

import { FileStat, FileType } from '../../types.ts'
import { gnuBasename, parent } from '../../utils/path.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DirRows } from './types.ts'

/** A metadata scalar as text; null for anything that is not one. */
export function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Turn a backend slug into an absolute tree path.
 *
 * Args:
 *   value: the slug as the backend stores it.
 *   noun: what the backend calls a slug, for the error wording.
 */
export function normalizeSlug(value: string, noun: string): string {
  const parts = stripSlash(value)
    .split('/')
    .filter((part) => part !== '')
  if (parts.length === 0) throw new Error(`Invalid empty ${noun}`)
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`Invalid ${noun} segment: '${part}'`)
  }
  return '/' + parts.join('/')
}

/**
 * Drop every file that another file needs as its directory. A backend that
 * refuses such a tree throws from `onCollision`, which hears
 * `(ancestor, path)` for each path dropped, `ancestor` being the file.
 */
export function dropCollisions<V>(
  files: ReadonlyMap<string, V>,
  onCollision: (ancestor: string, path: string) => void,
): Map<string, V> {
  const kept = new Map(files)
  for (const path of [...files.keys()].sort(compareCodePoints)) {
    const parts = stripSlash(path).split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = '/' + parts.slice(0, i).join('/')
      if (files.has(ancestor)) {
        onCollision(ancestor, path)
        kept.delete(path)
        break
      }
    }
  }
  return kept
}

/** Lay files out as each folder's rows, keyed by the folder's tree path. */
export function dirRows<V>(
  files: ReadonlyMap<string, V>,
  fileRow: (path: string, value: V) => FileStat,
): DirRows {
  const directories = new Set<string>(['/'])
  for (const path of files.keys()) {
    const parts = stripSlash(path).split('/')
    for (let i = 1; i < parts.length; i++) {
      directories.add('/' + parts.slice(0, i).join('/'))
    }
  }
  const rows: DirRows = new Map()
  for (const directory of directories) rows.set(directory, [])
  for (const directory of [...directories].sort(compareCodePoints)) {
    if (directory === '/') continue
    rows.get(parent(directory))?.push(folderRow(gnuBasename(directory)))
  }
  for (const [path, value] of [...files].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    rows.get(parent(path))?.push(fileRow(path, value))
  }
  for (const children of rows.values()) children.sort((a, b) => compareCodePoints(a.name, b.name))
  return rows
}

/** A folder of the tree, which exists only as its listing. */
export function folderRow(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { children_count: 0 } })
}
