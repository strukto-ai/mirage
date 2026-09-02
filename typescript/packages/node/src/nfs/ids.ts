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

import { RenameIntoSelfError, StaleHandleError } from './errors.ts'

export const ROOT_PATH = '/'

function descendantPrefix(path: string): string {
  return path.replace(/\/+$/, '') + '/'
}

/**
 * The fileid ↔ path map an NFS server addresses files through.
 *
 * NFSv3 names a file by handle, never by path, and the server crate
 * builds the opaque handle from a fileid plus its own generation. The
 * adapter therefore owns exactly one thing: which id stands for which
 * path, and what happens to that mapping when a path moves.
 *
 * Ids are allocated monotonically and never reused. A reused id would
 * let a client holding a handle to a deleted file silently address a
 * different one, because the crate's generation counter distinguishes
 * server lifetimes rather than individual files.
 *
 * Entries are never evicted. NFSv3 clients cache handles for as long
 * as they like, so dropping a live one manufactures a stale-handle
 * error the client cannot recover from; an entry costs about a
 * hundred bytes, which makes a hundred thousand files a few
 * megabytes.
 *
 * Every method is synchronous and await-free, so the event loop runs
 * each one to completion before another callback proceeds and no lock
 * is needed; `state_sync.test.ts` pins that invariant, since one
 * added await would break it silently.
 */
const COOKIE_TOMBSTONES = 4096

export class IdTable {
  private nextId = 1
  private readonly byId = new Map<number, string>()
  private readonly byPath = new Map<string, number>()
  // Ids whose entry is gone, kept for cookie ordering only. A READDIR
  // resuming after an entry that has since been removed still has to
  // know where in the sorted listing it sat; without that the resume
  // matches nothing and the rest of the directory reads to the client
  // as end-of-listing. Bounded, because a long-lived mount removes
  // files forever.
  private readonly removed = new Map<number, string>()

  /** The id for a path, minting one when the path is new. */
  alloc(path: string): number {
    const existing = this.byPath.get(path)
    if (existing !== undefined) return existing
    const fileid = this.nextId
    this.nextId += 1
    this.byId.set(fileid, path)
    this.byPath.set(path, fileid)
    return fileid
  }

  /**
   * The path an id names.
   *
   * @throws StaleHandleError when the id is unknown or invalidated.
   */
  resolve(fileid: number): string {
    const path = this.byId.get(fileid)
    if (path === undefined) throw new StaleHandleError(`unknown file id: ${String(fileid)}`)
    return path
  }

  /** The id already held for a path, without minting one. */
  idFor(path: string): number | undefined {
    return this.byPath.get(path)
  }

  /** Forget an id after the path behind it is gone. Idempotent. */
  invalidate(fileid: number): void {
    const path = this.byId.get(fileid)
    if (path === undefined) return
    this.byId.delete(fileid)
    this.byPath.delete(path)
    this.removed.set(fileid, path)
    // Ids are minted in order and a Map iterates in insertion order,
    // so the front is the oldest.
    while (this.removed.size > COOKIE_TOMBSTONES) {
      const oldest = this.removed.keys().next()
      if (oldest.done === true) break
      this.removed.delete(oldest.value)
    }
  }

  /**
   * The path an id named, including one already removed.
   *
   * Cookie ordering only -- `resolve` is still the authority on whether
   * a handle is live, and still refuses a removed one.
   */
  cookiePath(fileid: number): string | undefined {
    return this.byId.get(fileid) ?? this.removed.get(fileid)
  }

  /**
   * Refuse a rename whose destination lies inside its source.
   *
   * Callers run this before the backend rename: raising it from
   * rename() alone would fire after the backend already moved the
   * tree, leaving the table and the store disagreeing.
   */
  guardRename(oldPath: string, newPath: string): void {
    if (newPath === oldPath || newPath.startsWith(descendantPrefix(oldPath))) {
      throw new RenameIntoSelfError(`cannot rename ${oldPath} into its own subtree ${newPath}`)
    }
  }

  /**
   * Move oldPath to newPath, carrying every descendant with it.
   *
   * A rename moves a whole subtree, so every id below the source has
   * to be rewritten: an id left pointing at the old path resolves to
   * somewhere that no longer exists, and the client sees its handle
   * rot for a file it never touched. Any id already held for the
   * destination is invalidated, matching what the rename did to the
   * file that used to live there.
   */
  rename(oldPath: string, newPath: string): void {
    this.guardRename(oldPath, newPath)
    const oldPrefix = descendantPrefix(oldPath)
    const newPrefix = descendantPrefix(newPath)
    const moves: [number, string][] = []
    for (const [fileid, path] of this.byId) {
      if (path === oldPath || path.startsWith(oldPrefix)) moves.push([fileid, path])
    }
    for (const [fileid, path] of moves) {
      const landed = path === oldPath ? newPath : newPrefix + path.slice(oldPrefix.length)
      const displaced = this.byPath.get(landed)
      if (displaced !== undefined && displaced !== fileid) this.byId.delete(displaced)
      if (this.byPath.get(path) === fileid) this.byPath.delete(path)
      this.byId.set(fileid, landed)
      this.byPath.set(landed, fileid)
    }
  }
}
