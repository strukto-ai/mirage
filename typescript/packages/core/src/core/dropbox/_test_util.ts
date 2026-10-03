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

import { DropboxApiError } from './client.ts'
import type { DropboxEntry } from './api.ts'

/**
 * A `dropboxRpc` stand-in that pages `/files/list_folder`.
 *
 * Stands in for the transport rather than for `listFolder` itself,
 * because the walk is what a probe has to bound and only the real
 * `listFolder` performs it: a stub in its place answers in one call
 * whatever the caller asked for, so it cannot tell a bounded probe from
 * an unbounded one.
 *
 * Pages every request on the limit the first one carried, as the real API
 * does (the cursor retains the original request's parameters), and
 * records both the cap each caller asked for and how many requests the
 * walk actually made. `pageSize` cannot express a bound on the walk: it
 * caps the page, not the walk, so a small page turns a listing of a large
 * folder into more requests rather than fewer.
 */
export class FakeDropboxRpc {
  entries: DropboxEntry[]
  metadata: DropboxEntry | null
  moveErrors: (DropboxApiError | null)[]
  listLimits: number[] = []
  listRequests = 0
  deleted: string[] = []
  moves: [string, string][] = []
  // Every path get_metadata was asked for, so a test can pin a point lookup
  // against a listing.
  metadataPaths: string[] = []
  metadataByPath: Record<string, DropboxEntry> | null
  private cursors = new Map<string, DropboxEntry[]>()
  private limits = new Map<string, number>()

  constructor(
    opts: {
      entries?: DropboxEntry[]
      metadata?: DropboxEntry | null
      // Per-path answers to get_metadata, a missing path a 409; overrides
      // `metadata` when given.
      metadataByPath?: Record<string, DropboxEntry>
      moveErrors?: (DropboxApiError | null)[]
    } = {},
  ) {
    this.entries = opts.entries ?? []
    this.metadata = opts.metadata ?? null
    this.metadataByPath = opts.metadataByPath ?? null
    this.moveErrors = opts.moveErrors ?? []
  }

  private page(rest: DropboxEntry[], limit: number): unknown {
    this.listRequests += 1
    const head = rest.slice(0, limit)
    const tail = rest.slice(limit)
    const token = `cursor-${String(this.cursors.size)}`
    this.cursors.set(token, tail)
    this.limits.set(token, limit)
    return { entries: head, cursor: token, has_more: tail.length > 0 }
  }

  handle = (_tm: unknown, endpoint: string, body: unknown): Promise<unknown> => {
    const req = body as Record<string, unknown>
    if (endpoint === '/files/list_folder') {
      const limit = Number(req.limit ?? 2000)
      this.listLimits.push(limit)
      this.cursors.clear()
      this.limits.clear()
      return Promise.resolve(this.page(this.entries, limit))
    }
    if (endpoint === '/files/list_folder/continue') {
      const token = String(req.cursor)
      const rest = this.cursors.get(token)
      if (rest === undefined) throw new DropboxApiError('reset', 409, 'reset/...')
      this.cursors.delete(token)
      return Promise.resolve(this.page(rest, this.limits.get(token) ?? 2000))
    }
    if (endpoint === '/files/get_metadata') {
      const path = String(req.path)
      this.metadataPaths.push(path)
      const found =
        this.metadataByPath === null ? this.metadata : (this.metadataByPath[path] ?? null)
      if (found === null) throw new DropboxApiError('nf', 409, 'path/not_found/...')
      return Promise.resolve(found)
    }
    if (endpoint === '/files/delete_v2') {
      this.deleted.push(String(req.path))
      return Promise.resolve({})
    }
    if (endpoint === '/files/move_v2') {
      this.moves.push([String(req.from_path), String(req.to_path)])
      const error = this.moveErrors.shift() ?? null
      if (error !== null) throw error
      return Promise.resolve({})
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
}

export function folderEntry(name: string): DropboxEntry {
  return { '.tag': 'folder', name }
}

export function fileEntry(name: string, size = 1): DropboxEntry {
  return { '.tag': 'file', name, size }
}
